package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	storepkg "github.com/P-PrPas/ChronoFish/backend/internal/store"
	_ "github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
)

type stateStore interface {
	Load(context.Context, *apiServer) error
	Save(context.Context, *apiServer) error
	Close() error
}

type memoryStateStore struct{}

func (memoryStateStore) Load(context.Context, *apiServer) error { return nil }
func (memoryStateStore) Save(context.Context, *apiServer) error { return nil }
func (memoryStateStore) Close() error                           { return nil }

type sqlStateStore struct {
	db     *sql.DB
	driver string
}

func openStateStore(ctx context.Context, cfg config) (stateStore, error) {
	if cfg.dbDriver == "memory" {
		return memoryStateStore{}, nil
	}
	driver := "pgx"
	if cfg.dbDriver == "mysql" {
		driver = "mysql"
	}
	db, err := sql.Open(driver, cfg.databaseURL)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	db.SetMaxOpenConns(cfg.maxOpenConns)
	db.SetMaxIdleConns(cfg.maxIdleConns)
	db.SetConnMaxLifetime(cfg.connMaxLifetime)
	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	store := &sqlStateStore{db: db, driver: cfg.dbDriver}
	if err := storepkg.RunMigrations(ctx, db, cfg.dbDriver, cfg.migrationsDir); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *sqlStateStore) placeholder(n int) string {
	if s.driver == "postgres" {
		return fmt.Sprintf("$%d", n)
	}
	return "?"
}

func (s *sqlStateStore) Load(ctx context.Context, server *apiServer) error {
	rows, err := s.db.QueryContext(ctx, `SELECT resource, record_id, payload FROM chronofish_runtime_state`)
	if err != nil {
		return fmt.Errorf("load runtime state: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var resource, id, payload string
		if err := rows.Scan(&resource, &id, &payload); err != nil {
			return err
		}
		var item map[string]any
		if err := json.Unmarshal([]byte(payload), &item); err != nil {
			return fmt.Errorf("decode runtime state %s/%s: %w", resource, id, err)
		}
		if resource == "audit-log" {
			server.audits = append(server.audits, item)
			continue
		}
		if resource == "embryo-observations" {
			server.observations[id] = item
			continue
		}
		if resource == "fish-observations" {
			server.fishObs[id] = item
			continue
		}
		if _, ok := server.entities[resource]; !ok {
			server.entities[resource] = make(map[string]map[string]any)
		}
		server.entities[resource][id] = item
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows, err = s.db.QueryContext(ctx, `SELECT scope, response FROM chronofish_runtime_idempotency`)
	if err != nil {
		return fmt.Errorf("load idempotency: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var scope, response string
		if err := rows.Scan(&scope, &response); err != nil {
			return err
		}
		server.idempotency[scope] = json.RawMessage(response)
		if strings.HasPrefix(scope, "request:") {
			var envelope struct {
				Status   int             `json:"status"`
				Body     json.RawMessage `json:"body"`
				Encoding string          `json:"encoding"`
				Hash     string          `json:"hash"`
			}
			if json.Unmarshal([]byte(response), &envelope) == nil && envelope.Status > 0 {
				server.idempotency[scope] = envelope.Body
				server.idempotencyStatus[scope] = envelope.Status
				server.idempotencyBinary[scope] = envelope.Encoding == "base64"
				server.idempotencyHash[scope] = envelope.Hash
			}
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, fish := range server.entities["fish"] {
		if running := intValue(fish["runningNo"]); running >= server.fishNo {
			server.fishNo = running + 1
		}
	}
	return nil
}

func (s *sqlStateStore) Save(ctx context.Context, server *apiServer) error {
	server.mu.RLock()
	defer server.mu.RUnlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	rollback := func(e error) error { _ = tx.Rollback(); return e }
	if _, err := tx.ExecContext(ctx, `DELETE FROM chronofish_runtime_state`); err != nil {
		return rollback(err)
	}
	stateQuery := "INSERT INTO chronofish_runtime_state (resource, record_id, payload, active, updated_at) VALUES (" + s.placeholder(1) + "," + s.placeholder(2) + "," + s.placeholder(3) + "," + s.placeholder(4) + "," + s.placeholder(5) + ")"
	now := time.Now().UTC()
	for resource, records := range server.entities {
		for id, item := range records {
			payload, err := json.Marshal(item)
			if err != nil {
				return rollback(err)
			}
			active := item["active"] != false
			if _, err := tx.ExecContext(ctx, stateQuery, resource, id, string(payload), active, now); err != nil {
				return rollback(err)
			}
		}
	}
	for id, item := range server.observations {
		if err := s.insertRuntimeRecord(ctx, tx, "embryo-observations", id, item, now); err != nil {
			return rollback(err)
		}
	}
	for id, item := range server.fishObs {
		if err := s.insertRuntimeRecord(ctx, tx, "fish-observations", id, item, now); err != nil {
			return rollback(err)
		}
	}
	for index, item := range server.audits {
		id := stringValue(item["id"])
		if id == "" {
			id = fmt.Sprintf("audit-%d", index)
		}
		if err := s.insertRuntimeRecord(ctx, tx, "audit-log", id, item, now); err != nil {
			return rollback(err)
		}
	}
	if err := s.syncCanonical(ctx, tx, server); err != nil {
		return rollback(err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM chronofish_runtime_idempotency`); err != nil {
		return rollback(err)
	}
	idempotencyQuery := "INSERT INTO chronofish_runtime_idempotency (scope, response, created_at) VALUES (" + s.placeholder(1) + "," + s.placeholder(2) + "," + s.placeholder(3) + ")"
	for scope, response := range server.idempotency {
		persisted := string(response)
		if strings.HasPrefix(scope, "request:") {
			body := json.RawMessage(response)
			if len(body) == 0 {
				body = json.RawMessage("null")
			}
			envelopeValue := map[string]any{"status": server.idempotencyStatus[scope], "body": body, "hash": server.idempotencyHash[scope]}
			if server.idempotencyBinary[scope] {
				envelopeValue["encoding"] = "base64"
			}
			envelope, marshalErr := json.Marshal(envelopeValue)
			if marshalErr != nil {
				return rollback(marshalErr)
			}
			persisted = string(envelope)
		}
		if _, err := tx.ExecContext(ctx, idempotencyQuery, scope, persisted, now); err != nil {
			return rollback(err)
		}
	}
	return tx.Commit()
}

func (s *sqlStateStore) insertRuntimeRecord(ctx context.Context, tx *sql.Tx, resource, id string, item map[string]any, now time.Time) error {
	payload, err := json.Marshal(item)
	if err != nil {
		return err
	}
	active := item["active"] != false
	query := "INSERT INTO chronofish_runtime_state (resource, record_id, payload, active, updated_at) VALUES (" + s.placeholder(1) + "," + s.placeholder(2) + "," + s.placeholder(3) + "," + s.placeholder(4) + "," + s.placeholder(5) + ")"
	_, err = tx.ExecContext(ctx, query, resource, id, string(payload), active, now)
	return err
}

func (s *sqlStateStore) syncCanonical(ctx context.Context, tx *sql.Tx, server *apiServer) error {
	for id, item := range server.entities["sites"] {
		if err := s.upsertCanonical(ctx, tx, "site", []string{"id", "code", "name", "active", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["code"]), stringValue(item["name"]), item["active"] != false, timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range server.entities["operators"] {
		siteID := nullableReference(item["siteId"], server.entities["sites"])
		if err := s.upsertCanonical(ctx, tx, "operator", []string{"id", "site_id", "name", "active", "created_at", "updated_at", "deleted_at"}, []any{id, siteID, stringValue(item["name"]), item["active"] != false, timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range server.entities["donor-cell-lines"] {
		if err := s.upsertCanonical(ctx, tx, "donor_cell_line", []string{"id", "strain", "preparation", "batch_code", "active", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["strain"]), stringValue(item["preparation"]), nullableString(item["batchCode"]), item["active"] != false, timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range server.entities["recipient-egg-lots"] {
		if err := s.upsertCanonical(ctx, tx, "recipient_egg_lot", []string{"id", "breed", "lot_date", "label", "active", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["breed"]), nullableString(item["lotDate"]), stringValue(item["label"]), item["active"] != false, timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range server.entities["csof-lots"] {
		if err := s.upsertCanonical(ctx, tx, "csof_lot", []string{"id", "lot_code", "active", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["lotCode"]), item["active"] != false, timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range server.entities["treatment-groups"] {
		if err := s.upsertCanonical(ctx, tx, "treatment_group", []string{"id", "code", "name", "arm_type", "active", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["code"]), nullableString(item["name"]), stringValue(item["armType"]), item["active"] != false, timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range server.entities["fish-boxes"] {
		if err := s.upsertCanonical(ctx, tx, "fish_box", []string{"id", "box_code", "site_id", "active", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["boxCode"]), nullableReference(item["siteId"], server.entities["sites"]), item["active"] != false, timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	if err := s.syncTimingProfiles(ctx, tx, server); err != nil {
		return err
	}
	for id, item := range server.entities["batches"] {
		if !referencesAvailable(item, server, "siteId", "operatorId", "protocolId", "timingProfileId", "treatmentGroupId") {
			continue
		}
		profileID := stringValue(item["timingProfileId"])
		if profileID == "" {
			profileID = "01900000-0000-7000-8000-000000000002"
		}
		if err := s.upsertCanonical(ctx, tx, "experiment_batch", []string{"id", "batch_code", "experiment_date", "day_no", "site_id", "operator_id", "protocol_id", "timing_profile_id", "treatment_group_id", "recipient_egg_lot_id", "csof_lot_id", "clutch_code", "replicate_no", "incubation_temp_c", "notes", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["batchCode"]), stringValue(item["experimentDate"]), nullableInt(item["dayNo"]), stringValue(item["siteId"]), stringValue(item["operatorId"]), stringValueOr(item["protocolId"], "01900000-0000-7000-8000-000000000001"), profileID, stringValue(item["treatmentGroupId"]), nullableReference(item["recipientEggLotId"], server.entities["recipient-egg-lots"]), nullableReference(item["csofLotId"], server.entities["csof-lots"]), nullableString(item["clutchCode"]), nullableInt(item["replicateNo"]), nullableNumber(item["incubationTempC"]), nullableString(item["notes"]), timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range server.entities["injection-lots"] {
		if !referencesAvailable(item, server, "batchId", "donorCellLineId") {
			continue
		}
		if err := s.upsertCanonical(ctx, tx, "injection_lot", []string{"id", "batch_id", "lot_no", "donor_cell_line_id", "enu_power_pct", "enu_pulse_us", "enu_led", "enu_start_at", "enu_finish_at", "activated_at", "n_eggs", "n_activated", "notes", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["batchId"]), stringValue(item["lotNo"]), stringValue(item["donorCellLineId"]), nullableInt(item["enuPowerPct"]), nullableInt(item["enuPulseUs"]), nullableInt(item["enuLed"]), item["enuStartAt"], item["enuFinishAt"], timestampValue(item["activatedAt"]), nullableInt(item["nEggs"]), intValue(item["nActivated"]), nullableString(item["notes"]), timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range server.entities["embryos"] {
		if !referencesAvailable(item, server, "injectionLotId") {
			continue
		}
		if err := s.upsertCanonical(ctx, tx, "embryo", []string{"id", "injection_lot_id", "seq_in_lot", "embryo_code", "well_position", "exit_stage_id", "exit_at", "exit_reason", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["injectionLotId"]), intValue(item["seqInLot"]), stringValue(item["embryoCode"]), nullableString(item["wellPosition"]), nullableString(item["exitStageId"]), item["exitAt"], nullableString(item["exitReason"]), timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range server.entities["fish"] {
		if !referencesAvailable(item, server, "donorCellLineId") {
			continue
		}
		if err := s.upsertCanonical(ctx, tx, "clone_fish", []string{"id", "embryo_id", "fish_code", "running_no", "dob", "donor_cell_line_id", "site_id", "fish_box_id", "status", "biological_condition", "first_abnormal_on", "first_abnormal_age_days", "first_abnormal_stage_id", "sex", "fin_clipped", "exit_date", "exit_reason", "remarks", "created_at", "updated_at", "deleted_at"}, []any{id, nullableReference(item["embryoId"], server.entities["embryos"]), stringValue(item["fishCode"]), intValue(item["runningNo"]), stringValue(item["dob"]), stringValue(item["donorCellLineId"]), nullableReference(item["siteId"], server.entities["sites"]), nullableReference(item["fishBoxId"], server.entities["fish-boxes"]), stringValueOr(item["status"], "ALIVE"), stringValueOr(item["condition"], "NORMAL"), nullableString(item["firstAbnormalOn"]), nullableInt(item["firstAbnormalAgeDays"]), nullableString(item["firstAbnormalStageId"]), stringValueOr(item["sex"], "UNKNOWN"), item["finClipped"] == true, nullableString(item["exitDate"]), nullableFishExitReason(item["exitReason"]), nullableString(item["remarks"]), timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range server.observations {
		stageID := stageDefinitionID(stringValue(item["stageCode"]))
		if stageID == "" || !referencesAvailable(item, server, "embryoId", "operatorId") {
			continue
		}
		if err := s.upsertCanonical(ctx, tx, "embryo_observation", []string{"id", "client_uuid", "embryo_id", "stage_definition_id", "observed_at", "hpa_actual", "hpa_expected_snapshot", "deviation_h", "outcome", "biological_condition", "operator_id", "device_id", "is_backdated", "override_reason", "notes", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["clientUuid"]), stringValue(item["embryoId"]), stageID, timestampValue(item["observedAt"]), numberValue(item["hpaActual"]), numberValue(item["hpaExpectedSnapshot"]), numberValue(item["deviationH"]), stringValue(item["outcome"]), stringValue(item["condition"]), stringValue(item["operatorId"]), nullableString(item["deviceId"]), item["isBackdated"] == true, nullableString(item["overrideReason"]), nullableString(item["notes"]), timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range server.entities["embryos"] {
		observationID := nullableString(item["firstAbnormalObservationId"])
		query := "UPDATE embryo SET first_abnormal_observation_id = " + s.placeholder(1) + " WHERE id = " + s.placeholder(2)
		if _, err := tx.ExecContext(ctx, query, observationID, id); err != nil {
			return err
		}
	}
	for id, item := range server.fishObs {
		if !referencesAvailable(item, server, "cloneFishId", "operatorId") {
			continue
		}
		if err := s.upsertCanonical(ctx, tx, "fish_observation", []string{"id", "client_uuid", "clone_fish_id", "observed_on", "age_days", "outcome", "biological_condition", "operator_id", "device_id", "is_backdated", "notes", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["clientUuid"]), stringValue(item["cloneFishId"]), stringValue(item["observedOn"]), intValue(item["ageDays"]), stringValue(item["outcome"]), stringValue(item["condition"]), stringValue(item["operatorId"]), nullableString(item["deviceId"]), item["isBackdated"] == true, nullableString(item["notes"]), timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range server.entities["control-arm-counts"] {
		stageID := stageDefinitionID(stringValue(item["stageCode"]))
		if stageID == "" || !referencesAvailable(item, server, "batchId") {
			continue
		}
		if err := s.upsertCanonical(ctx, tx, "control_arm_count", []string{"id", "batch_id", "arm_type", "stage_definition_id", "n_normal", "n_abnormal", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["batchId"]), stringValue(item["armType"]), stageID, intValue(item["nNormal"]), intValue(item["nAbnormal"]), timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range server.entities["specimens"] {
		if !referencesAvailable(item, server, "cloneFishId") || stringValue(item["specimenCode"]) == "" || stringValue(item["specimenKind"]) == "" || stringValue(item["specimenType"]) == "" {
			continue
		}
		if err := s.upsertCanonical(ctx, tx, "specimen", []string{"id", "clone_fish_id", "specimen_code", "specimen_kind", "specimen_type", "collected_on", "frozen_on", "storage", "notes", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["cloneFishId"]), stringValue(item["specimenCode"]), stringValue(item["specimenKind"]), stringValue(item["specimenType"]), nullableString(item["collectedOn"]), nullableString(item["frozenOn"]), nullableString(item["storage"]), nullableString(item["notes"]), timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for _, item := range server.audits {
		oldValues, _ := json.Marshal(item["oldValues"])
		newValues, _ := json.Marshal(item["newValues"])
		if err := s.upsertCanonical(ctx, tx, "audit_log", []string{"id", "table_name", "record_id", "action", "old_values", "new_values", "operator_id", "device_id", "occurred_at"}, []any{stringValue(item["id"]), stringValue(item["tableName"]), stringValue(item["recordId"]), stringValue(item["action"]), string(oldValues), string(newValues), nullableReference(item["operatorId"], server.entities["operators"]), nullableString(item["deviceId"]), timestampValue(item["occurredAt"])}, []string{"id"}); err != nil {
			return err
		}
	}
	return nil
}

func (s *sqlStateStore) syncTimingProfiles(ctx context.Context, tx *sql.Tx, server *apiServer) error {
	ids := make([]string, 0, len(server.entities["timing-profiles"]))
	for id := range server.entities["timing-profiles"] {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		profile := server.entities["timing-profiles"][id]
		protocolID := stringValueOr(profile["protocolId"], "01900000-0000-7000-8000-000000000001")
		clearCurrent := "UPDATE stage_timing_profile SET is_current = " + s.placeholder(1) + " WHERE protocol_id = " + s.placeholder(2)
		if _, err := tx.ExecContext(ctx, clearCurrent, false, protocolID); err != nil {
			return err
		}
		if err := s.upsertCanonical(ctx, tx, "stage_timing_profile", []string{"id", "protocol_id", "version", "name", "reference_temp_c", "auto_temp_adjust", "source_note", "is_current", "created_by_operator_id", "created_at", "updated_at", "deleted_at"}, []any{id, protocolID, intValue(profile["version"]), stringValueOr(profile["name"], "Timing profile"), nullableNumber(profile["referenceTempC"]), profile["autoTempAdjust"] == true, nullableString(profile["sourceNote"]), false, nullableReference(profile["createdByOperatorId"], server.entities["operators"]), timestampValue(profile["createdAt"]), timestampValue(profile["updatedAt"]), profile["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
		entries, _ := profile["entries"].([]any)
		for _, raw := range entries {
			entry, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			stageID := stageDefinitionID(stringValueOr(entry["stageCode"], stringValue(entry["code"])))
			if stageID == "" {
				continue
			}
			entryID := stringValue(entry["id"])
			if entryID == "" {
				entryID = uuidV7()
			}
			if err := s.upsertCanonical(ctx, tx, "stage_timing", []string{"id", "protocol_id", "profile_id", "stage_definition_id", "expected_hpa", "created_at", "updated_at", "deleted_at"}, []any{entryID, protocolID, id, stageID, numberValue(entry["expectedHpa"]), timestampValue(profile["createdAt"]), timestampValue(profile["updatedAt"]), nil}, []string{"profile_id", "stage_definition_id"}); err != nil {
				return err
			}
		}
	}
	for _, id := range ids {
		profile := server.entities["timing-profiles"][id]
		if profile["isCurrent"] != true {
			continue
		}
		protocolID := stringValueOr(profile["protocolId"], "01900000-0000-7000-8000-000000000001")
		query := "UPDATE stage_timing_profile SET is_current = " + s.placeholder(1) + " WHERE id = " + s.placeholder(2) + " AND protocol_id = " + s.placeholder(3)
		if _, err := tx.ExecContext(ctx, query, true, id, protocolID); err != nil {
			return err
		}
	}
	return nil
}

func (s *sqlStateStore) upsertCanonical(ctx context.Context, tx *sql.Tx, table string, columns []string, values []any, conflict []string) error {
	marks := make([]string, len(columns))
	for index := range columns {
		marks[index] = s.placeholder(index + 1)
	}
	query := "INSERT INTO " + table + " (" + strings.Join(columns, ", ") + ") VALUES (" + strings.Join(marks, ", ") + ")"
	if s.driver == "postgres" {
		updates := make([]string, 0, len(columns)-len(conflict))
		for _, column := range columns {
			if !containsString(conflict, column) {
				updates = append(updates, column+" = EXCLUDED."+column)
			}
		}
		query += " ON CONFLICT (" + strings.Join(conflict, ", ") + ") DO UPDATE SET " + strings.Join(updates, ", ")
	} else {
		updates := make([]string, 0, len(columns)-len(conflict))
		for _, column := range columns {
			if !containsString(conflict, column) {
				updates = append(updates, column+" = VALUES("+column+")")
			}
		}
		query += " ON DUPLICATE KEY UPDATE " + strings.Join(updates, ", ")
	}
	_, err := tx.ExecContext(ctx, query, values...)
	return err
}

func referencesAvailable(item map[string]any, server *apiServer, fields ...string) bool {
	for _, field := range fields {
		id := stringValue(item[field])
		if id == "" {
			return false
		}
		var resource string
		switch field {
		case "siteId":
			resource = "sites"
		case "operatorId":
			resource = "operators"
		case "treatmentGroupId":
			resource = "treatment-groups"
		case "protocolId":
			resource = "protocols"
		case "timingProfileId":
			resource = "timing-profiles"
		case "batchId":
			resource = "batches"
		case "donorCellLineId":
			resource = "donor-cell-lines"
		case "injectionLotId":
			resource = "injection-lots"
		case "cloneFishId":
			resource = "fish"
		default:
			continue
		}
		if server.entities[resource][id] == nil {
			return false
		}
	}
	return true
}

func nullableReference(value any, records map[string]map[string]any) any {
	id := stringValue(value)
	if id == "" || records[id] == nil {
		return nil
	}
	return id
}

func nullableString(value any) any {
	if stringValue(value) == "" {
		return nil
	}
	return stringValue(value)
}

func stringValueOr(value any, fallback string) string {
	if value := stringValue(value); value != "" {
		return value
	}
	return fallback
}

func nullableInt(value any) any {
	if value == nil || stringValue(value) == "" {
		return nil
	}
	return intValue(value)
}

func nullableNumber(value any) any {
	if value == nil || stringValue(value) == "" {
		return nil
	}
	if number, ok := value.(float64); ok {
		return number
	}
	return value
}

func numberValue(value any) float64 {
	switch number := value.(type) {
	case float64:
		return number
	case float32:
		return float64(number)
	case int:
		return float64(number)
	case int64:
		return float64(number)
	default:
		return 0
	}
}

func stageDefinitionID(code string) string {
	order := stageNumber(code)
	if order < 1 || order > 36 {
		return ""
	}
	return fmt.Sprintf("01900001-0000-7000-8000-%012d", order)
}

func timestampValue(value any) any {
	if stringValue(value) == "" {
		return time.Now().UTC()
	}
	if parsed, err := time.Parse(time.RFC3339Nano, stringValue(value)); err == nil {
		return parsed.UTC()
	}
	return stringValue(value)
}

func nullableFishExitReason(value any) any {
	reason := stringValue(value)
	if reason == "" || reason == "PROMOTED" {
		return nil
	}
	return reason
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func (s *sqlStateStore) Close() error { return s.db.Close() }

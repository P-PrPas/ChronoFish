package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/P-PrPas/ChronoFish/backend/internal/domain"
)

type State struct {
	Entities          map[string]map[string]map[string]any
	Audits            []map[string]any
	Observations      map[string]map[string]any
	FishObservations  map[string]map[string]any
	Idempotency       map[string]json.RawMessage
	IdempotencyStatus map[string]int
	IdempotencyBinary map[string]bool
	IdempotencyHash   map[string]string
	FishNo            int
}

type SQLRepository struct {
	db     *sql.DB
	driver string
}

// Store is the persistence/UOW boundary used by the HTTP composition root.
// Commit is the unit of work: canonical mutation, audit rows, and completed
// request idempotency are committed together or none are visible.
type Store interface {
	Load(context.Context, *State) error
	Reserve(context.Context, Mutation) (Mutation, bool, error)
	WaitForCompletion(context.Context, Mutation) (Mutation, error)
	Abort(context.Context, Mutation) error
	Commit(context.Context, *State, *Mutation) error
	Close() error
}

func NewSQLRepository(db *sql.DB, driver string) *SQLRepository {
	return &SQLRepository{db: db, driver: driver}
}

func (s *SQLRepository) placeholder(n int) string {
	if s.driver == "postgres" {
		return fmt.Sprintf("$%d", n)
	}
	return "?"
}

func (s *SQLRepository) Load(ctx context.Context, state *State) error {
	if state.Entities == nil {
		state.Entities = make(map[string]map[string]map[string]any)
	}
	for _, resource := range []string{"sites", "operators", "donor-cell-lines", "recipient-egg-lots", "csof-lots", "treatment-groups", "fish-boxes", "protocols", "timing-profiles", "batches", "injection-lots", "embryos", "fish", "specimens", "control-arm-counts"} {
		state.Entities[resource] = make(map[string]map[string]any)
	}
	state.Audits = nil
	state.Observations = make(map[string]map[string]any)
	state.FishObservations = make(map[string]map[string]any)
	state.Idempotency = make(map[string]json.RawMessage)
	state.IdempotencyStatus = make(map[string]int)
	state.IdempotencyBinary = make(map[string]bool)
	state.IdempotencyHash = make(map[string]string)
	state.FishNo = 1

	tables := []struct{ table, resource string }{
		{"site", "sites"}, {"operator", "operators"}, {"donor_cell_line", "donor-cell-lines"},
		{"recipient_egg_lot", "recipient-egg-lots"}, {"csof_lot", "csof-lots"},
		{"treatment_group", "treatment-groups"}, {"fish_box", "fish-boxes"},
		{"protocol", "protocols"}, {"stage_timing_profile", "timing-profiles"},
		{"experiment_batch", "batches"}, {"injection_lot", "injection-lots"},
		{"embryo", "embryos"}, {"clone_fish", "fish"}, {"specimen", "specimens"},
		{"control_arm_count", "control-arm-counts"},
	}
	for _, table := range tables {
		if err := s.loadTable(ctx, state, table.table, table.resource); err != nil {
			return fmt.Errorf("load %s: %w", table.table, err)
		}
	}
	stageCodes, err := s.loadStageCodes(ctx)
	if err != nil {
		return fmt.Errorf("load stage definitions: %w", err)
	}
	if err := s.loadTimingEntries(ctx, state); err != nil {
		return fmt.Errorf("load timing entries: %w", err)
	}
	if err := s.loadObservationTable(ctx, state, "embryo_observation", state.Observations, stageCodes); err != nil {
		return fmt.Errorf("load embryo observations: %w", err)
	}
	if err := s.loadObservationTable(ctx, state, "fish_observation", state.FishObservations, stageCodes); err != nil {
		return fmt.Errorf("load fish observations: %w", err)
	}
	if err := s.loadAudits(ctx, state); err != nil {
		return err
	}
	rows, err := s.db.QueryContext(ctx, "SELECT scope, idempotency_key, request_hash, status_code, content_type, response_body FROM request_idempotency")
	if err != nil {
		return fmt.Errorf("load request idempotency: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var scope, key, hash, contentType, body string
		var status int
		if err := rows.Scan(&scope, &key, &hash, &status, &contentType, &body); err != nil {
			return err
		}
		cacheKey := scope
		if cacheKey == "" {
			cacheKey = "request:" + key
		}
		state.Idempotency[cacheKey] = json.RawMessage(body)
		state.IdempotencyStatus[cacheKey] = status
		state.IdempotencyHash[cacheKey] = hash
		state.IdempotencyBinary[cacheKey] = strings.Contains(contentType, "spreadsheetml")
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, fish := range state.Entities["fish"] {
		if running := intValue(fish["runningNo"]); running >= state.FishNo {
			state.FishNo = running + 1
		}
	}
	return nil
}

func (s *SQLRepository) loadTable(ctx context.Context, state *State, table, resource string) error {
	rows, err := s.db.QueryContext(ctx, "SELECT * FROM "+table)
	if err != nil {
		return err
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return err
	}
	for rows.Next() {
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			return err
		}
		item := make(map[string]any, len(columns))
		for i, column := range columns {
			item[apiField(column)] = databaseValueFor(column, values[i])
		}
		if id := stringValue(item["id"]); id != "" {
			state.Entities[resource][id] = item
		}
	}
	return rows.Err()
}

func (s *SQLRepository) loadStageCodes(ctx context.Context) (map[string]string, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT id, code FROM stage_definition")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string]string)
	for rows.Next() {
		var id, code string
		if err := rows.Scan(&id, &code); err != nil {
			return nil, err
		}
		result[id] = code
	}
	return result, rows.Err()
}

func (s *SQLRepository) loadTimingEntries(ctx context.Context, state *State) error {
	rows, err := s.db.QueryContext(ctx, `SELECT st.profile_id, st.id, st.stage_definition_id, st.expected_hpa, sd.stage_order, sd.label, sd.phase, sd.stage_scope, sd.code
		FROM stage_timing st JOIN stage_definition sd ON sd.id = st.stage_definition_id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var profileID, id, stageID, code, label, phase, scope string
		var expected any
		var order int
		if err := rows.Scan(&profileID, &id, &stageID, &expected, &order, &label, &phase, &scope, &code); err != nil {
			return err
		}
		profile := state.Entities["timing-profiles"][profileID]
		if profile == nil {
			continue
		}
		entries, _ := profile["entries"].([]any)
		entries = append(entries, map[string]any{"id": id, "stageDefinitionId": stageID, "stageOrder": order, "stageCode": code, "stageLabel": label, "expectedHpa": numberValue(databaseValue(expected)), "phase": phase, "stageScope": scope})
		profile["entries"] = entries
	}
	return rows.Err()
}

func (s *SQLRepository) loadObservationTable(ctx context.Context, state *State, table string, target map[string]map[string]any, stageCodes map[string]string) error {
	rows, err := s.db.QueryContext(ctx, "SELECT * FROM "+table)
	if err != nil {
		return err
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return err
	}
	for rows.Next() {
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			return err
		}
		item := make(map[string]any, len(columns))
		for i, column := range columns {
			item[apiField(column)] = databaseValueFor(column, values[i])
		}
		if code := stageCodes[stringValue(item["stageDefinitionId"])]; code != "" {
			item["stageCode"] = code
		}
		if id := stringValue(item["id"]); id != "" {
			target[id] = item
		}
	}
	return rows.Err()
}

func (s *SQLRepository) loadAudits(ctx context.Context, state *State) error {
	rows, err := s.db.QueryContext(ctx, "SELECT * FROM audit_log")
	if err != nil {
		return fmt.Errorf("load audit log: %w", err)
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return err
	}
	for rows.Next() {
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			return err
		}
		item := make(map[string]any, len(columns))
		for i, column := range columns {
			item[apiField(column)] = databaseValueFor(column, values[i])
		}
		for _, key := range []string{"oldValues", "newValues"} {
			if raw := stringValue(item[key]); raw != "" {
				var decoded any
				if json.Unmarshal([]byte(raw), &decoded) == nil {
					item[key] = decoded
				}
			}
		}
		state.Audits = append(state.Audits, item)
	}
	return rows.Err()
}

func apiField(column string) string {
	parts := strings.Split(strings.ToLower(column), "_")
	if len(parts) == 1 {
		return parts[0]
	}
	var builder strings.Builder
	builder.WriteString(parts[0])
	for _, part := range parts[1:] {
		if part != "" {
			builder.WriteString(strings.ToUpper(part[:1]))
			builder.WriteString(part[1:])
		}
	}
	return builder.String()
}

func databaseValue(value any) any {
	switch value := value.(type) {
	case []byte:
		return string(value)
	case time.Time:
		return value.UTC().Format(time.RFC3339Nano)
	default:
		return value
	}
}

func databaseValueFor(column string, value any) any {
	if bytes, ok := value.([]byte); ok {
		switch column {
		case "active", "auto_temp_adjust", "is_current", "fin_clipped", "is_backdated":
			return string(bytes) == "1" || strings.EqualFold(string(bytes), "true")
		}
	}
	if timestamp, ok := value.(time.Time); ok {
		if strings.HasSuffix(column, "_date") || column == "dob" || strings.HasSuffix(column, "_on") {
			return timestamp.Format("2006-01-02")
		}
	}
	return databaseValue(value)
}

func stringValue(value any) string {
	if value == nil {
		return ""
	}
	return fmt.Sprint(value)
}

func intValue(value any) int {
	switch value := value.(type) {
	case int:
		return value
	case int64:
		return int(value)
	case int32:
		return int(value)
	case float64:
		return int(value)
	case float32:
		return int(value)
	case []byte:
		var result int
		_, _ = fmt.Sscan(string(value), &result)
		return result
	case string:
		var result int
		_, _ = fmt.Sscan(value, &result)
		return result
	default:
		return 0
	}
}

func newUUID() string {
	var b [16]byte
	binary.BigEndian.PutUint64(b[:8], uint64(time.Now().UnixMilli()))
	_, _ = rand.Read(b[8:])
	b[6] = (b[6] & 0x0f) | 0x70
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", binary.BigEndian.Uint32(b[:4]), binary.BigEndian.Uint16(b[4:6]), binary.BigEndian.Uint16(b[6:8]), binary.BigEndian.Uint16(b[8:10]), b[10:])
}

type Mutation struct {
	Scope       string
	Key         string
	RequestHash string
	Status      int
	ContentType string
	Body        []byte
	OperatorID  string
	DeviceID    string
}

var ErrIdempotencyConflict = errors.New("idempotency key was already used with a different request")

func (s *SQLRepository) Save(ctx context.Context, state *State) error {
	return s.Commit(ctx, state, nil)
}

func (s *SQLRepository) Commit(ctx context.Context, state *State, mutation *Mutation) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	rollback := func(cause error) error { _ = tx.Rollback(); return cause }
	if err := s.syncCanonical(ctx, tx, state); err != nil {
		return rollback(err)
	}
	if mutation != nil {
		body := string(mutation.Body)
		query := "UPDATE request_idempotency SET status_code = " + s.placeholder(1) + ", content_type = " + s.placeholder(2) + ", response_body = " + s.placeholder(3) + ", completed_at = " + s.placeholder(4) + " WHERE scope = " + s.placeholder(5) + " AND idempotency_key = " + s.placeholder(6) + " AND request_hash = " + s.placeholder(7)
		result, err := tx.ExecContext(ctx, query, mutation.Status, mutation.ContentType, body, time.Now().UTC(), mutation.Scope, mutation.Key, mutation.RequestHash)
		if err != nil {
			return rollback(err)
		}
		if affected, _ := result.RowsAffected(); affected != 1 {
			return rollback(errors.New("idempotency reservation missing"))
		}
	}
	return tx.Commit()
}

func (s *SQLRepository) Reserve(ctx context.Context, mutation Mutation) (Mutation, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Mutation{}, false, err
	}
	rollback := func(cause error) (Mutation, bool, error) { _ = tx.Rollback(); return Mutation{}, false, cause }
	now := time.Now().UTC()
	insert := "INSERT INTO request_idempotency (scope, idempotency_key, request_hash, status_code, content_type, response_body, operator_id, device_id, created_at) VALUES (" + s.placeholder(1) + "," + s.placeholder(2) + "," + s.placeholder(3) + ",102," + s.placeholder(4) + "," + s.placeholder(5) + "," + s.placeholder(6) + "," + s.placeholder(7) + "," + s.placeholder(8) + ")"
	if s.driver == "postgres" {
		insert += " ON CONFLICT (scope, idempotency_key) DO NOTHING"
	} else {
		insert += " ON DUPLICATE KEY UPDATE idempotency_key = idempotency_key"
	}
	if _, err := tx.ExecContext(ctx, insert, mutation.Scope, mutation.Key, mutation.RequestHash, "", "", mutation.OperatorID, mutation.DeviceID, now); err != nil {
		return rollback(err)
	}
	var found Mutation
	var completedAt any
	selectQuery := "SELECT request_hash, status_code, content_type, response_body, completed_at FROM request_idempotency WHERE scope = " + s.placeholder(1) + " AND idempotency_key = " + s.placeholder(2)
	if err := tx.QueryRowContext(ctx, selectQuery, mutation.Scope, mutation.Key).Scan(&found.RequestHash, &found.Status, &found.ContentType, &found.Body, &completedAt); err != nil {
		return rollback(err)
	}
	found.Scope, found.Key = mutation.Scope, mutation.Key
	found.OperatorID, found.DeviceID = mutation.OperatorID, mutation.DeviceID
	if found.RequestHash != mutation.RequestHash {
		return rollback(ErrIdempotencyConflict)
	}
	found.Body = append([]byte(nil), found.Body...)
	if err := tx.Commit(); err != nil {
		return Mutation{}, false, err
	}
	return found, found.Status == 102 && completedAt == nil, nil
}

func (s *SQLRepository) WaitForCompletion(ctx context.Context, mutation Mutation) (Mutation, error) {
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		var found Mutation
		var completedAt any
		query := "SELECT request_hash, status_code, content_type, response_body, completed_at FROM request_idempotency WHERE scope = " + s.placeholder(1) + " AND idempotency_key = " + s.placeholder(2)
		err := s.db.QueryRowContext(ctx, query, mutation.Scope, mutation.Key).Scan(&found.RequestHash, &found.Status, &found.ContentType, &found.Body, &completedAt)
		if err != nil {
			return Mutation{}, err
		}
		if found.RequestHash != mutation.RequestHash {
			return Mutation{}, ErrIdempotencyConflict
		}
		if found.Status != 102 || completedAt != nil {
			found.Scope, found.Key = mutation.Scope, mutation.Key
			found.Body = append([]byte(nil), found.Body...)
			return found, nil
		}
		select {
		case <-ctx.Done():
			return Mutation{}, ctx.Err()
		case <-ticker.C:
		}
	}
}

func (s *SQLRepository) Abort(ctx context.Context, mutation Mutation) error {
	query := "DELETE FROM request_idempotency WHERE scope = " + s.placeholder(1) + " AND idempotency_key = " + s.placeholder(2) + " AND request_hash = " + s.placeholder(3) + " AND status_code = 102"
	_, err := s.db.ExecContext(ctx, query, mutation.Scope, mutation.Key, mutation.RequestHash)
	return err
}

func (s *SQLRepository) syncCanonical(ctx context.Context, tx *sql.Tx, state *State) error {
	for id, item := range state.Entities["sites"] {
		if err := s.upsertCanonical(ctx, tx, "site", []string{"id", "code", "name", "active", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["code"]), stringValue(item["name"]), item["active"] != false, timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range state.Entities["operators"] {
		siteID := nullableReference(item["siteId"], state.Entities["sites"])
		if err := s.upsertCanonical(ctx, tx, "operator", []string{"id", "site_id", "name", "active", "created_at", "updated_at", "deleted_at"}, []any{id, siteID, stringValue(item["name"]), item["active"] != false, timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range state.Entities["donor-cell-lines"] {
		if err := s.upsertCanonical(ctx, tx, "donor_cell_line", []string{"id", "strain", "preparation", "batch_code", "active", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["strain"]), stringValue(item["preparation"]), nullableString(item["batchCode"]), item["active"] != false, timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range state.Entities["recipient-egg-lots"] {
		if err := s.upsertCanonical(ctx, tx, "recipient_egg_lot", []string{"id", "breed", "lot_date", "label", "active", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["breed"]), nullableString(item["lotDate"]), stringValue(item["label"]), item["active"] != false, timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range state.Entities["csof-lots"] {
		if err := s.upsertCanonical(ctx, tx, "csof_lot", []string{"id", "lot_code", "active", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["lotCode"]), item["active"] != false, timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range state.Entities["treatment-groups"] {
		if err := s.upsertCanonical(ctx, tx, "treatment_group", []string{"id", "code", "name", "arm_type", "active", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["code"]), nullableString(item["name"]), stringValue(item["armType"]), item["active"] != false, timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range state.Entities["fish-boxes"] {
		if err := s.upsertCanonical(ctx, tx, "fish_box", []string{"id", "box_code", "site_id", "active", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["boxCode"]), nullableReference(item["siteId"], state.Entities["sites"]), item["active"] != false, timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	if err := s.syncTimingProfiles(ctx, tx, state); err != nil {
		return err
	}
	for id, item := range state.Entities["batches"] {
		if !referencesAvailable(item, state, "siteId", "operatorId", "protocolId", "timingProfileId", "treatmentGroupId") {
			continue
		}
		profileID := stringValue(item["timingProfileId"])
		if profileID == "" {
			profileID = "01900000-0000-7000-8000-000000000002"
		}
		if err := s.upsertCanonical(ctx, tx, "experiment_batch", []string{"id", "batch_code", "experiment_date", "day_no", "site_id", "operator_id", "protocol_id", "timing_profile_id", "treatment_group_id", "recipient_egg_lot_id", "csof_lot_id", "clutch_code", "replicate_no", "incubation_temp_c", "notes", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["batchCode"]), stringValue(item["experimentDate"]), nullableInt(item["dayNo"]), stringValue(item["siteId"]), stringValue(item["operatorId"]), stringValueOr(item["protocolId"], "01900000-0000-7000-8000-000000000001"), profileID, stringValue(item["treatmentGroupId"]), nullableReference(item["recipientEggLotId"], state.Entities["recipient-egg-lots"]), nullableReference(item["csofLotId"], state.Entities["csof-lots"]), nullableString(item["clutchCode"]), nullableInt(item["replicateNo"]), nullableNumber(item["incubationTempC"]), nullableString(item["notes"]), timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range state.Entities["injection-lots"] {
		if !referencesAvailable(item, state, "batchId", "donorCellLineId") {
			continue
		}
		if err := s.upsertCanonical(ctx, tx, "injection_lot", []string{"id", "batch_id", "lot_no", "donor_cell_line_id", "enu_power_pct", "enu_pulse_us", "enu_led", "enu_start_at", "enu_finish_at", "activated_at", "n_eggs", "n_activated", "notes", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["batchId"]), stringValue(item["lotNo"]), stringValue(item["donorCellLineId"]), nullableInt(item["enuPowerPct"]), nullableInt(item["enuPulseUs"]), nullableInt(item["enuLed"]), item["enuStartAt"], item["enuFinishAt"], timestampValue(item["activatedAt"]), nullableInt(item["nEggs"]), intValue(item["nActivated"]), nullableString(item["notes"]), timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range state.Entities["embryos"] {
		if !referencesAvailable(item, state, "injectionLotId") {
			continue
		}
		if err := s.upsertCanonical(ctx, tx, "embryo", []string{"id", "injection_lot_id", "seq_in_lot", "embryo_code", "well_position", "exit_stage_id", "exit_at", "exit_reason", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["injectionLotId"]), intValue(item["seqInLot"]), stringValue(item["embryoCode"]), nullableString(item["wellPosition"]), nullableString(item["exitStageId"]), item["exitAt"], nullableString(item["exitReason"]), timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range state.Entities["fish"] {
		if !referencesAvailable(item, state, "donorCellLineId") {
			continue
		}
		if err := s.upsertCanonical(ctx, tx, "clone_fish", []string{"id", "embryo_id", "fish_code", "running_no", "dob", "donor_cell_line_id", "site_id", "fish_box_id", "status", "biological_condition", "first_abnormal_on", "first_abnormal_age_days", "first_abnormal_stage_id", "sex", "fin_clipped", "exit_date", "exit_reason", "remarks", "created_at", "updated_at", "deleted_at"}, []any{id, nullableReference(item["embryoId"], state.Entities["embryos"]), stringValue(item["fishCode"]), intValue(item["runningNo"]), stringValue(item["dob"]), stringValue(item["donorCellLineId"]), nullableReference(item["siteId"], state.Entities["sites"]), nullableReference(item["fishBoxId"], state.Entities["fish-boxes"]), stringValueOr(item["status"], "ALIVE"), stringValueOr(item["condition"], "NORMAL"), nullableString(item["firstAbnormalOn"]), nullableInt(item["firstAbnormalAgeDays"]), nullableString(item["firstAbnormalStageId"]), stringValueOr(item["sex"], "UNKNOWN"), item["finClipped"] == true, nullableString(item["exitDate"]), nullableFishExitReason(item["exitReason"]), nullableString(item["remarks"]), timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range state.Observations {
		stageID := stageDefinitionID(stringValue(item["stageCode"]))
		if stageID == "" || !referencesAvailable(item, state, "embryoId", "operatorId") {
			continue
		}
		if err := s.upsertCanonical(ctx, tx, "embryo_observation", []string{"id", "client_uuid", "embryo_id", "stage_definition_id", "observed_at", "hpa_actual", "hpa_expected_snapshot", "deviation_h", "outcome", "biological_condition", "operator_id", "device_id", "is_backdated", "override_reason", "notes", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["clientUuid"]), stringValue(item["embryoId"]), stageID, timestampValue(item["observedAt"]), numberValue(item["hpaActual"]), numberValue(item["hpaExpectedSnapshot"]), numberValue(item["deviationH"]), stringValue(item["outcome"]), stringValue(item["condition"]), stringValue(item["operatorId"]), nullableString(item["deviceId"]), item["isBackdated"] == true, nullableString(item["overrideReason"]), nullableString(item["notes"]), timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range state.Entities["embryos"] {
		observationID := nullableString(item["firstAbnormalObservationId"])
		query := "UPDATE embryo SET first_abnormal_observation_id = " + s.placeholder(1) + " WHERE id = " + s.placeholder(2)
		if _, err := tx.ExecContext(ctx, query, observationID, id); err != nil {
			return err
		}
	}
	for id, item := range state.FishObservations {
		if !referencesAvailable(item, state, "cloneFishId", "operatorId") {
			continue
		}
		if err := s.upsertCanonical(ctx, tx, "fish_observation", []string{"id", "client_uuid", "clone_fish_id", "observed_on", "age_days", "outcome", "biological_condition", "operator_id", "device_id", "is_backdated", "notes", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["clientUuid"]), stringValue(item["cloneFishId"]), stringValue(item["observedOn"]), intValue(item["ageDays"]), stringValue(item["outcome"]), stringValue(item["condition"]), stringValue(item["operatorId"]), nullableString(item["deviceId"]), item["isBackdated"] == true, nullableString(item["notes"]), timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range state.Entities["control-arm-counts"] {
		stageID := stageDefinitionID(stringValue(item["stageCode"]))
		if stageID == "" || !referencesAvailable(item, state, "batchId") {
			continue
		}
		if err := s.upsertCanonical(ctx, tx, "control_arm_count", []string{"id", "batch_id", "arm_type", "stage_definition_id", "n_normal", "n_abnormal", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["batchId"]), stringValue(item["armType"]), stageID, intValue(item["nNormal"]), intValue(item["nAbnormal"]), timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range state.Entities["specimens"] {
		if !referencesAvailable(item, state, "cloneFishId") || stringValue(item["specimenCode"]) == "" || stringValue(item["specimenKind"]) == "" || stringValue(item["specimenType"]) == "" {
			continue
		}
		if err := s.upsertCanonical(ctx, tx, "specimen", []string{"id", "clone_fish_id", "specimen_code", "specimen_kind", "specimen_type", "collected_on", "frozen_on", "storage", "notes", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["cloneFishId"]), stringValue(item["specimenCode"]), stringValue(item["specimenKind"]), stringValue(item["specimenType"]), nullableString(item["collectedOn"]), nullableString(item["frozenOn"]), nullableString(item["storage"]), nullableString(item["notes"]), timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for _, item := range state.Audits {
		oldValues, _ := json.Marshal(item["oldValues"])
		newValues, _ := json.Marshal(item["newValues"])
		if err := s.upsertCanonical(ctx, tx, "audit_log", []string{"id", "table_name", "record_id", "action", "old_values", "new_values", "operator_id", "device_id", "occurred_at"}, []any{stringValue(item["id"]), stringValue(item["tableName"]), stringValue(item["recordId"]), stringValue(item["action"]), string(oldValues), string(newValues), nullableReference(item["operatorId"], state.Entities["operators"]), nullableString(item["deviceId"]), timestampValue(item["occurredAt"])}, []string{"id"}); err != nil {
			return err
		}
	}
	return nil
}

func (s *SQLRepository) syncTimingProfiles(ctx context.Context, tx *sql.Tx, state *State) error {
	ids := make([]string, 0, len(state.Entities["timing-profiles"]))
	for id := range state.Entities["timing-profiles"] {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		profile := state.Entities["timing-profiles"][id]
		protocolID := stringValueOr(profile["protocolId"], "01900000-0000-7000-8000-000000000001")
		clearCurrent := "UPDATE stage_timing_profile SET is_current = " + s.placeholder(1) + " WHERE protocol_id = " + s.placeholder(2)
		if _, err := tx.ExecContext(ctx, clearCurrent, false, protocolID); err != nil {
			return err
		}
		if err := s.upsertCanonical(ctx, tx, "stage_timing_profile", []string{"id", "protocol_id", "version", "name", "reference_temp_c", "auto_temp_adjust", "source_note", "is_current", "created_by_operator_id", "created_at", "updated_at", "deleted_at"}, []any{id, protocolID, intValue(profile["version"]), stringValueOr(profile["name"], "Timing profile"), nullableNumber(profile["referenceTempC"]), profile["autoTempAdjust"] == true, nullableString(profile["sourceNote"]), false, nullableReference(profile["createdByOperatorId"], state.Entities["operators"]), timestampValue(profile["createdAt"]), timestampValue(profile["updatedAt"]), profile["deletedAt"]}, []string{"id"}); err != nil {
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
				entryID = newUUID()
			}
			if err := s.upsertCanonical(ctx, tx, "stage_timing", []string{"id", "protocol_id", "profile_id", "stage_definition_id", "expected_hpa", "created_at", "updated_at", "deleted_at"}, []any{entryID, protocolID, id, stageID, numberValue(entry["expectedHpa"]), timestampValue(profile["createdAt"]), timestampValue(profile["updatedAt"]), nil}, []string{"profile_id", "stage_definition_id"}); err != nil {
				return err
			}
		}
	}
	for _, id := range ids {
		profile := state.Entities["timing-profiles"][id]
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

func (s *SQLRepository) upsertCanonical(ctx context.Context, tx *sql.Tx, table string, columns []string, values []any, conflict []string) error {
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

func referencesAvailable(item map[string]any, state *State, fields ...string) bool {
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
		if state.Entities[resource][id] == nil {
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
	case string:
		var parsed float64
		_, _ = fmt.Sscan(number, &parsed)
		return parsed
	default:
		return 0
	}
}

func stageDefinitionID(code string) string {
	order := domain.StageNumber(code)
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

func (s *SQLRepository) Close() error { return s.db.Close() }

var _ Store = (*SQLRepository)(nil)

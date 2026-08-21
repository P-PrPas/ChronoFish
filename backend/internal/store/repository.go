package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
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

// Delta is the request-scoped unit of work exchanged by HTTP and the SQL
// repository. Before/After contain only aggregates touched by this request;
// foreign keys are checked against the same SQL transaction, never against a
// live in-memory map. This keeps writes proportional to the mutation rather
// than to the total number of embryos/observations in the installation.
type Delta struct {
	Before State
	After  State
	Audits []map[string]any
	// AssignedFish contains numbers allocated by the database transaction for
	// newly promoted fish. It lets the transport reconcile its response after
	// commit while the durable idempotency replay receives the same values.
	AssignedFish map[string]int
}

type SQLRepository struct {
	db     *sql.DB
	driver string
}

// LoadResources refreshes only the canonical aggregates needed by one request.
// It is deliberately separate from Load: startup and ordinary reads must not
// materialise five years of observations or audit history just to answer a
// small master-data request.
func (s *SQLRepository) LoadResources(ctx context.Context, state *State, resources ...string) error {
	if state.Entities == nil {
		state.Entities = make(map[string]map[string]map[string]any)
	}
	for _, resource := range resources {
		table := canonicalTable(resource)
		if table == "" {
			continue
		}
		state.Entities[resource] = make(map[string]map[string]any)
		if err := s.loadTable(ctx, state, table, resource); err != nil {
			return fmt.Errorf("load %s: %w", table, err)
		}
	}
	stageCodes := map[string]string(nil)
	if containsString(resources, "embryos") || containsString(resources, "fish") || containsString(resources, "observations") || containsString(resources, "fish-observations") || containsString(resources, "control-arm-counts") {
		var err error
		stageCodes, err = s.loadStageCodes(ctx)
		if err != nil {
			return fmt.Errorf("load stage definitions: %w", err)
		}
	}
	if containsString(resources, "timing-profiles") {
		for _, profile := range state.Entities["timing-profiles"] {
			profile["entries"] = []any{}
		}
		if err := s.loadTimingEntries(ctx, state); err != nil {
			return fmt.Errorf("load timing entries: %w", err)
		}
	}
	if containsString(resources, "observations") {
		if state.Observations == nil {
			state.Observations = make(map[string]map[string]any)
		}
		state.Observations = make(map[string]map[string]any)
		if err := s.loadObservationTable(ctx, state, "embryo_observation", state.Observations, stageCodes); err != nil {
			return fmt.Errorf("load embryo observations: %w", err)
		}
	}
	if containsString(resources, "fish-observations") {
		if state.FishObservations == nil {
			state.FishObservations = make(map[string]map[string]any)
		}
		state.FishObservations = make(map[string]map[string]any)
		if err := s.loadObservationTable(ctx, state, "fish_observation", state.FishObservations, stageCodes); err != nil {
			return fmt.Errorf("load fish observations: %w", err)
		}
	}
	if len(stageCodes) > 0 {
		hydrateDerivedFields(state, stageCodes)
	}
	return nil
}

// hydrateDerivedFields rebuilds denormalised API fields from canonical IDs and
// observations after a restart.  The SQL schema deliberately stores IDs as
// the authority; keeping this small projection derivation here prevents a
// freshly-started instance from disagreeing with one that just handled a
// mutation in memory.
func hydrateDerivedFields(state *State, stageCodes map[string]string) {
	for _, observation := range state.Observations {
		if observation == nil || observation["deletedAt"] != nil {
			continue
		}
		if embryo := state.Entities["embryos"][stringValue(observation["embryoId"])]; embryo != nil {
			observation["injectionLotId"] = embryo["injectionLotId"]
		}
	}
	for _, embryo := range state.Entities["embryos"] {
		if embryo == nil {
			continue
		}
		if code := stageCodes[stringValue(embryo["exitStageId"])]; code != "" {
			embryo["exitStageCode"] = code
		}
		var first map[string]any
		var firstAt time.Time
		for _, observation := range state.Observations {
			if observation == nil || observation["deletedAt"] != nil || stringValue(observation["embryoId"]) != stringValue(embryo["id"]) || stringValue(observation["condition"]) != "ABNORMAL" {
				continue
			}
			observedAt, err := time.Parse(time.RFC3339Nano, stringValue(observation["observedAt"]))
			if err != nil {
				continue
			}
			if first == nil || observedAt.Before(firstAt) || (observedAt.Equal(firstAt) && domain.StageNumber(stringValue(observation["stageCode"])) < domain.StageNumber(stringValue(first["stageCode"]))) {
				first, firstAt = observation, observedAt
			}
		}
		if first == nil {
			continue
		}
		embryo["firstAbnormalObservationId"] = first["id"]
		embryo["firstAbnormalStageCode"] = first["stageCode"]
		embryo["firstAbnormalStageId"] = stageDefinitionID(stringValue(first["stageCode"]))
		embryo["firstAbnormalOn"] = firstAt.In(time.FixedZone("Asia/Bangkok", 7*60*60)).Format("2006-01-02")
	}
	for _, fish := range state.Entities["fish"] {
		if fish == nil {
			continue
		}
		if code := stageCodes[stringValue(fish["firstAbnormalStageId"])]; code != "" {
			fish["firstAbnormalStageCode"] = code
		}
	}
}

// OperatorActive is used for write authentication. Unlike the in-process
// read model it always observes the committed database row, which matters
// when two API instances in front of the same database deactivate an operator.
func (s *SQLRepository) OperatorActive(ctx context.Context, id string) (bool, error) {
	query := "SELECT active FROM operator WHERE id = " + s.placeholder(1) + " AND deleted_at IS NULL"
	var active bool
	if err := s.db.QueryRowContext(ctx, query, id).Scan(&active); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	return active, nil
}

// Store is the persistence/UOW boundary used by the HTTP composition root.
// Commit is the unit of work: canonical mutation, audit rows, and completed
// request idempotency are committed together or none are visible.
type Store interface {
	Load(context.Context, *State) error
	Reserve(context.Context, Mutation) (Mutation, bool, error)
	WaitForCompletion(context.Context, Mutation) (Mutation, error)
	Abort(context.Context, Mutation) error
	Commit(context.Context, *State, *State, *Mutation) error
	Close() error
}

func NewSQLRepository(db *sql.DB, driver string) *SQLRepository {
	if driver == "pgx" {
		driver = "postgres"
	}
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

	// Reference data is small and safe to keep as a process projection. Large
	// operational aggregates are refreshed by route; they are intentionally not
	// loaded during startup.
	if err := s.LoadResources(ctx, state, "sites", "operators", "donor-cell-lines", "recipient-egg-lots", "csof-lots", "treatment-groups", "fish-boxes", "protocols", "timing-profiles"); err != nil {
		return fmt.Errorf("load reference data: %w", err)
	}
	// Audit history and idempotency replay are repository-backed query paths;
	// neither is loaded into the process cache at startup. This keeps startup
	// bounded when the five-year audit/idempotency tables are large.
	return nil
}

func (s *SQLRepository) loadTable(ctx context.Context, state *State, table, resource string) error {
	rows, err := s.db.QueryContext(ctx, "SELECT * FROM "+table+" WHERE deleted_at IS NULL")
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
		FROM stage_timing st JOIN stage_definition sd ON sd.id = st.stage_definition_id
		JOIN stage_timing_profile p ON p.id = st.profile_id
		WHERE st.deleted_at IS NULL AND p.deleted_at IS NULL`)
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
	rows, err := s.db.QueryContext(ctx, "SELECT * FROM "+table+" WHERE deleted_at IS NULL")
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
	rows, err := s.db.QueryContext(ctx, "SELECT * FROM audit_log ORDER BY occurred_at DESC")
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

// AuditQuery is intentionally a narrow read port. It keeps audit history
// paginated and filtered in SQL instead of materialising the whole table.
type AuditQuery struct {
	Table, RecordID, OperatorID string
	From, To                    time.Time
	Limit, Offset               int
}

func (s *SQLRepository) QueryAudits(ctx context.Context, query AuditQuery) ([]map[string]any, bool, error) {
	limit := query.Limit
	if limit < 1 || limit > 500 {
		limit = 100
	}
	if query.Offset < 0 {
		query.Offset = 0
	}
	where := []string{"1 = 1"}
	args := make([]any, 0, 7)
	add := func(sqlText string, value any) {
		where = append(where, sqlText+" "+s.placeholder(len(args)+1))
		args = append(args, value)
	}
	if query.Table != "" {
		add("table_name =", query.Table)
	}
	if query.RecordID != "" {
		add("record_id =", query.RecordID)
	}
	if query.OperatorID != "" {
		add("operator_id =", query.OperatorID)
	}
	if !query.From.IsZero() {
		add("occurred_at >=", query.From.UTC())
	}
	if !query.To.IsZero() {
		add("occurred_at <=", query.To.UTC())
	}
	limitPlaceholder := s.placeholder(len(args) + 1)
	offsetPlaceholder := s.placeholder(len(args) + 2)
	args = append(args, limit, query.Offset)
	sqlText := "SELECT id, table_name, record_id, action, old_values, new_values, operator_id, device_id, occurred_at FROM audit_log WHERE " + strings.Join(where, " AND ") + " ORDER BY occurred_at DESC, id DESC LIMIT " + limitPlaceholder + " OFFSET " + offsetPlaceholder
	rows, err := s.db.QueryContext(ctx, sqlText, args...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := make([]map[string]any, 0, limit)
	for rows.Next() {
		var id, table, record, action string
		var oldValues, newValues, operator, device any
		var occurred any
		if err := rows.Scan(&id, &table, &record, &action, &oldValues, &newValues, &operator, &device, &occurred); err != nil {
			return nil, false, err
		}
		item := map[string]any{"id": id, "tableName": table, "recordId": record, "action": action, "operatorId": databaseValueFor("operator_id", operator), "deviceId": databaseValueFor("device_id", device), "occurredAt": databaseValueFor("occurred_at", occurred)}
		for key, value := range map[string]any{"oldValues": oldValues, "newValues": newValues} {
			decoded := databaseValueFor(key, value)
			if raw := stringValue(decoded); raw != "" {
				var parsed any
				if json.Unmarshal([]byte(raw), &parsed) == nil {
					decoded = parsed
				}
			}
			item[key] = decoded
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	return items, len(items) == limit, nil
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
	if bytes, ok := value.([]byte); ok {
		return string(bytes)
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
	LeaseUntil  time.Time
	LeaseToken  string
	LeaseOwner  bool
}

var ErrIdempotencyConflict = errors.New("idempotency key was already used with a different request")

func (s *SQLRepository) Save(ctx context.Context, state *State) error {
	return s.Commit(ctx, &State{}, state, nil)
}

func (s *SQLRepository) Commit(ctx context.Context, before, after *State, mutation *Mutation) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	rollback := func(cause error) error { _ = tx.Rollback(); return cause }
	if err := s.syncCanonical(ctx, tx, before, after); err != nil {
		return rollback(err)
	}
	if mutation != nil {
		body := string(mutation.Body)
		query := "UPDATE request_idempotency SET status_code = " + s.placeholder(1) + ", content_type = " + s.placeholder(2) + ", response_body = " + s.placeholder(3) + ", completed_at = " + s.placeholder(4) + " WHERE scope = " + s.placeholder(5) + " AND idempotency_key = " + s.placeholder(6) + " AND request_hash = " + s.placeholder(7)
		args := []any{mutation.Status, mutation.ContentType, body, time.Now().UTC(), mutation.Scope, mutation.Key, mutation.RequestHash}
		if mutation.LeaseToken != "" {
			query += " AND lease_token = " + s.placeholder(8)
			args = append(args, mutation.LeaseToken)
		}
		result, err := tx.ExecContext(ctx, query, args...)
		if err != nil {
			return rollback(err)
		}
		if affected, _ := result.RowsAffected(); affected != 1 {
			return rollback(errors.New("idempotency reservation missing"))
		}
	}
	return tx.Commit()
}

func (s *SQLRepository) CommitDelta(ctx context.Context, delta *Delta, mutation *Mutation) error {
	if delta == nil {
		return errors.New("nil mutation delta")
	}
	delta.After.Audits = append([]map[string]any(nil), delta.Audits...)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	rollback := func(cause error) error { _ = tx.Rollback(); return cause }
	if err := s.assignFishNumbersTx(ctx, tx, delta); err != nil {
		return rollback(err)
	}
	if err := s.verifyDeltaVersions(ctx, tx, delta); err != nil {
		return rollback(err)
	}
	if err := s.syncCanonicalChanges(ctx, tx, delta.After, nil); err != nil {
		return rollback(err)
	}
	if mutation != nil {
		mutation.Body = rewriteAssignedFishBody(mutation.Body, delta.AssignedFish)
		query := "UPDATE request_idempotency SET status_code = " + s.placeholder(1) + ", content_type = " + s.placeholder(2) + ", response_body = " + s.placeholder(3) + ", completed_at = " + s.placeholder(4) + " WHERE scope = " + s.placeholder(5) + " AND idempotency_key = " + s.placeholder(6) + " AND request_hash = " + s.placeholder(7) + " AND status_code = 102 AND lease_token = " + s.placeholder(8)
		result, execErr := tx.ExecContext(ctx, query, mutation.Status, mutation.ContentType, string(mutation.Body), time.Now().UTC(), mutation.Scope, mutation.Key, mutation.RequestHash, mutation.LeaseToken)
		if execErr != nil {
			return rollback(execErr)
		}
		if affected, _ := result.RowsAffected(); affected != 1 {
			return rollback(errors.New("idempotency reservation missing"))
		}
	}
	return tx.Commit()
}

const fishSequenceID = "00000000-0000-7000-8000-000000000006"

// assignFishNumbersTx allocates promotion numbers while holding one durable
// singleton row lock. Handlers may suggest a number for a preview, but a
// committed promotion always uses this allocator, so two API instances cannot
// publish the same running_no or fish code.
func (s *SQLRepository) assignFishNumbersTx(ctx context.Context, tx *sql.Tx, delta *Delta) error {
	if delta == nil || len(delta.After.Entities["fish"]) == 0 {
		return nil
	}
	ids := make([]string, 0)
	for id, item := range delta.After.Entities["fish"] {
		if item != nil && item["allocateRunningNo"] == true && delta.Before.Entities["fish"][id] == nil {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	sort.Strings(ids)
	var next int
	lockQuery := "SELECT next_running_no FROM fish_running_sequence WHERE id = " + s.placeholder(1) + " FOR UPDATE"
	if err := tx.QueryRowContext(ctx, lockQuery, fishSequenceID).Scan(&next); err != nil {
		return fmt.Errorf("lock fish running sequence: %w", err)
	}
	if next < 1 {
		next = 1
	}
	if delta.AssignedFish == nil {
		delta.AssignedFish = make(map[string]int, len(ids))
	}
	for _, id := range ids {
		item := delta.After.Entities["fish"][id]
		item["runningNo"] = next
		item["fishCode"] = replaceFishRunningPrefix(stringValue(item["fishCode"]), next)
		delta.AssignedFish[id] = next
		next++
	}
	update := "UPDATE fish_running_sequence SET next_running_no = " + s.placeholder(1) + " WHERE id = " + s.placeholder(2)
	result, err := tx.ExecContext(ctx, update, next, fishSequenceID)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return errors.New("fish running sequence disappeared")
	}
	return nil
}

func replaceFishRunningPrefix(code string, runningNo int) string {
	if strings.HasPrefix(code, "No.") {
		if separator := strings.IndexByte(code, '_'); separator > 3 {
			return fmt.Sprintf("No.%d%s", runningNo, code[separator:])
		}
	}
	return code
}

func rewriteAssignedFishBody(body []byte, assigned map[string]int) []byte {
	if len(assigned) == 0 || len(body) == 0 {
		return body
	}
	var value any
	if json.Unmarshal(body, &value) != nil {
		return body
	}
	var visit func(any)
	visit = func(node any) {
		switch current := node.(type) {
		case map[string]any:
			if id := stringValue(current["id"]); id != "" {
				if number, ok := assigned[id]; ok {
					current["runningNo"] = number
					current["fishCode"] = replaceFishRunningPrefix(stringValue(current["fishCode"]), number)
				}
			}
			for _, child := range current {
				visit(child)
			}
		case []any:
			for _, child := range current {
				visit(child)
			}
		}
	}
	visit(value)
	encoded, err := json.Marshal(value)
	if err != nil {
		return body
	}
	return encoded
}

// RewriteAssignedFishBody is the transport-facing part of the allocator
// seam. The SQL transaction remains the authority; this only updates the
// already-recorded response before it is flushed to the client.
func RewriteAssignedFishBody(body []byte, assigned map[string]int) []byte {
	return rewriteAssignedFishBody(body, assigned)
}

// verifyDeltaVersions fences a request-scoped write set against changes made
// by another API instance after this request read its aggregates. The check
// happens inside the same transaction as the canonical upserts, so a stale
// worker cannot overwrite a newer row and then publish an uncommitted cache
// value. New rows are left to the canonical primary/FK/unique constraints.
func (s *SQLRepository) verifyDeltaVersions(ctx context.Context, tx *sql.Tx, delta *Delta) error {
	if delta == nil {
		return nil
	}
	for resource, records := range delta.Before.Entities {
		table := canonicalTable(resource)
		if table == "" {
			continue
		}
		for id, before := range records {
			if err := s.verifyRecordVersion(ctx, tx, table, id, before); err != nil {
				return err
			}
		}
	}
	for id, before := range delta.Before.Observations {
		if err := s.verifyRecordVersion(ctx, tx, "embryo_observation", id, before); err != nil {
			return err
		}
	}
	for id, before := range delta.Before.FishObservations {
		if err := s.verifyRecordVersion(ctx, tx, "fish_observation", id, before); err != nil {
			return err
		}
	}
	return nil
}

func canonicalTable(resource string) string {
	return map[string]string{
		"sites": "site", "operators": "operator", "donor-cell-lines": "donor_cell_line",
		"recipient-egg-lots": "recipient_egg_lot", "csof-lots": "csof_lot",
		"treatment-groups": "treatment_group", "fish-boxes": "fish_box", "protocols": "protocol",
		"timing-profiles": "stage_timing_profile", "batches": "experiment_batch",
		"injection-lots": "injection_lot", "embryos": "embryo", "fish": "clone_fish",
		"specimens": "specimen", "control-arm-counts": "control_arm_count",
	}[resource]
}

func (s *SQLRepository) verifyRecordVersion(ctx context.Context, tx *sql.Tx, table, id string, before map[string]any) error {
	if id == "" || before == nil {
		return nil
	}
	expected := int64Value(before["rowVersion"])
	if expected < 1 {
		expected = 1
	}
	// Lock the row before checking its monotonic fence. Two transactions that
	// read the same version cannot both proceed: the second SELECT waits for
	// the first commit and then observes the incremented row_version.
	query := "SELECT row_version FROM " + table + " WHERE id = " + s.placeholder(1) + " FOR UPDATE"
	var current int64
	if err := tx.QueryRowContext(ctx, query, id).Scan(&current); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("concurrent mutation conflict: %s/%s disappeared", table, id)
		}
		return err
	}
	if current != expected {
		return fmt.Errorf("concurrent mutation conflict: %s/%s changed", table, id)
	}
	return nil
}

// changedState is the persistence delta for one serialized mutation. The
// complete after-state is retained separately for foreign-key checks, while
// only records that differ from the immutable before snapshot reach SQL.
func changedState(before, after *State) State {
	changes := State{Entities: make(map[string]map[string]map[string]any)}
	if after == nil {
		return changes
	}
	if before == nil {
		before = &State{}
	}
	for resource, records := range after.Entities {
		previous := before.Entities[resource]
		for id, item := range records {
			if old, ok := previous[id]; ok && reflect.DeepEqual(old, item) {
				continue
			}
			if changes.Entities[resource] == nil {
				changes.Entities[resource] = make(map[string]map[string]any)
			}
			changes.Entities[resource][id] = item
		}
	}
	changes.Observations = changedRecords(before.Observations, after.Observations)
	changes.FishObservations = changedRecords(before.FishObservations, after.FishObservations)
	if len(after.Audits) > len(before.Audits) {
		changes.Audits = append([]map[string]any(nil), after.Audits[len(before.Audits):]...)
	} else if !reflect.DeepEqual(before.Audits, after.Audits) {
		changes.Audits = append([]map[string]any(nil), after.Audits...)
	}
	return changes
}

func changedRecords(before, after map[string]map[string]any) map[string]map[string]any {
	changes := make(map[string]map[string]any)
	for id, item := range after {
		if old, ok := before[id]; ok && reflect.DeepEqual(old, item) {
			continue
		}
		changes[id] = item
	}
	return changes
}

func nullableTime(value any) time.Time {
	switch value := value.(type) {
	case time.Time:
		return value.UTC()
	case *time.Time:
		if value != nil {
			return value.UTC()
		}
	case []byte:
		parsed, _ := time.Parse(time.RFC3339Nano, string(value))
		return parsed.UTC()
	case string:
		parsed, _ := time.Parse(time.RFC3339Nano, value)
		return parsed.UTC()
	}
	return time.Time{}
}

func (s *SQLRepository) Reserve(ctx context.Context, mutation Mutation) (Mutation, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Mutation{}, false, err
	}
	rollback := func(cause error) (Mutation, bool, error) { _ = tx.Rollback(); return Mutation{}, false, cause }
	now := time.Now().UTC()
	leaseUntil := now.Add(30 * time.Second)
	leaseToken := mutation.LeaseToken
	if leaseToken == "" {
		leaseToken = newUUID()
	}
	insert := "INSERT INTO request_idempotency (scope, idempotency_key, request_hash, status_code, content_type, response_body, operator_id, device_id, created_at, lease_until, lease_token) VALUES (" + s.placeholder(1) + "," + s.placeholder(2) + "," + s.placeholder(3) + ",102," + s.placeholder(4) + "," + s.placeholder(5) + "," + s.placeholder(6) + "," + s.placeholder(7) + "," + s.placeholder(8) + "," + s.placeholder(9) + "," + s.placeholder(10) + ")"
	if s.driver == "postgres" {
		insert += " ON CONFLICT (scope, idempotency_key) DO NOTHING"
	} else {
		insert += " ON DUPLICATE KEY UPDATE idempotency_key = idempotency_key"
	}
	_, err = tx.ExecContext(ctx, insert, mutation.Scope, mutation.Key, mutation.RequestHash, "", "", mutation.OperatorID, mutation.DeviceID, now, leaseUntil, leaseToken)
	if err != nil {
		return rollback(err)
	}
	// Do not infer ownership from RowsAffected: MySQL's clientFoundRows mode
	// changes its meaning for ON DUPLICATE KEY UPDATE. Ownership is proved by
	// reading back the freshly generated fenced lease token.
	var found Mutation
	var completedAt any
	var leaseValue, tokenValue any
	selectQuery := "SELECT request_hash, status_code, content_type, response_body, completed_at, lease_until, lease_token FROM request_idempotency WHERE scope = " + s.placeholder(1) + " AND idempotency_key = " + s.placeholder(2)
	if err := tx.QueryRowContext(ctx, selectQuery, mutation.Scope, mutation.Key).Scan(&found.RequestHash, &found.Status, &found.ContentType, &found.Body, &completedAt, &leaseValue, &tokenValue); err != nil {
		return rollback(err)
	}
	found.Scope, found.Key = mutation.Scope, mutation.Key
	found.OperatorID, found.DeviceID = mutation.OperatorID, mutation.DeviceID
	if found.RequestHash != mutation.RequestHash {
		return rollback(ErrIdempotencyConflict)
	}
	found.LeaseUntil = nullableTime(leaseValue)
	found.LeaseToken = stringValue(tokenValue)
	created := found.Status == 102 && found.LeaseToken == leaseToken
	if !created && found.Status == 102 && !found.LeaseUntil.IsZero() && !found.LeaseUntil.After(now) {
		update := "UPDATE request_idempotency SET lease_until = " + s.placeholder(1) + ", lease_token = " + s.placeholder(2) + " WHERE scope = " + s.placeholder(3) + " AND idempotency_key = " + s.placeholder(4) + " AND request_hash = " + s.placeholder(5) + " AND status_code = 102 AND lease_until <= " + s.placeholder(6)
		if _, updateErr := tx.ExecContext(ctx, update, leaseUntil, leaseToken, mutation.Scope, mutation.Key, mutation.RequestHash, now); updateErr != nil {
			return rollback(updateErr)
		} else {
			// A concurrent takeover may have won the conditional UPDATE. Read the
			// row again and only proceed when this request owns the token.
			if err := tx.QueryRowContext(ctx, selectQuery, mutation.Scope, mutation.Key).Scan(&found.RequestHash, &found.Status, &found.ContentType, &found.Body, &completedAt, &leaseValue, &tokenValue); err != nil {
				return rollback(err)
			}
			found.LeaseUntil = nullableTime(leaseValue)
			found.LeaseToken = stringValue(tokenValue)
			created = found.Status == 102 && found.LeaseToken == leaseToken
		}
	}
	found.Body = append([]byte(nil), found.Body...)
	if err := tx.Commit(); err != nil {
		return Mutation{}, false, err
	}
	return found, created, nil
}

func (s *SQLRepository) WaitForCompletion(ctx context.Context, mutation Mutation) (Mutation, error) {
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		var found Mutation
		var completedAt, leaseValue, tokenValue any
		query := "SELECT request_hash, status_code, content_type, response_body, completed_at, lease_until, lease_token FROM request_idempotency WHERE scope = " + s.placeholder(1) + " AND idempotency_key = " + s.placeholder(2)
		err := s.db.QueryRowContext(ctx, query, mutation.Scope, mutation.Key).Scan(&found.RequestHash, &found.Status, &found.ContentType, &found.Body, &completedAt, &leaseValue, &tokenValue)
		if err != nil {
			return Mutation{}, err
		}
		if found.RequestHash != mutation.RequestHash {
			return Mutation{}, ErrIdempotencyConflict
		}
		if found.Status != 102 || completedAt != nil {
			found.Scope, found.Key = mutation.Scope, mutation.Key
			found.LeaseToken = stringValue(tokenValue)
			found.Body = append([]byte(nil), found.Body...)
			return found, nil
		}
		if lease := nullableTime(leaseValue); !lease.IsZero() && !lease.After(time.Now().UTC()) {
			reserved, created, reserveErr := s.Reserve(ctx, mutation)
			if reserveErr != nil {
				return Mutation{}, reserveErr
			}
			if created {
				reserved.LeaseOwner = true
				return reserved, nil
			}
		}
		select {
		case <-ctx.Done():
			return Mutation{}, ctx.Err()
		case <-ticker.C:
		}
	}
}

func (s *SQLRepository) Abort(ctx context.Context, mutation Mutation) error {
	query := "DELETE FROM request_idempotency WHERE scope = " + s.placeholder(1) + " AND idempotency_key = " + s.placeholder(2) + " AND request_hash = " + s.placeholder(3) + " AND status_code = 102 AND lease_token = " + s.placeholder(4)
	result, err := s.db.ExecContext(ctx, query, mutation.Scope, mutation.Key, mutation.RequestHash, mutation.LeaseToken)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return errors.New("idempotency lease is no longer owned")
	}
	return nil
}

func (s *SQLRepository) Renew(ctx context.Context, mutation Mutation) error {
	query := "UPDATE request_idempotency SET lease_until = " + s.placeholder(1) + " WHERE scope = " + s.placeholder(2) + " AND idempotency_key = " + s.placeholder(3) + " AND request_hash = " + s.placeholder(4) + " AND status_code = 102 AND lease_token = " + s.placeholder(5)
	result, err := s.db.ExecContext(ctx, query, time.Now().UTC().Add(30*time.Second), mutation.Scope, mutation.Key, mutation.RequestHash, mutation.LeaseToken)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return errors.New("idempotency lease is no longer owned")
	}
	return nil
}

func (s *SQLRepository) syncCanonical(ctx context.Context, tx *sql.Tx, before, state *State) error {
	changes := changedState(before, state)
	return s.syncCanonicalChanges(ctx, tx, changes, state)
}

func (s *SQLRepository) syncCanonicalChanges(ctx context.Context, tx *sql.Tx, changes State, state *State) error {
	for id, item := range changes.Entities["sites"] {
		if err := s.upsertCanonical(ctx, tx, "site", []string{"id", "code", "name", "active", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["code"]), stringValue(item["name"]), item["active"] != false, timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range changes.Entities["operators"] {
		siteID := nullableReference(item["siteId"])
		if err := s.upsertCanonical(ctx, tx, "operator", []string{"id", "site_id", "name", "active", "created_at", "updated_at", "deleted_at"}, []any{id, siteID, stringValue(item["name"]), item["active"] != false, timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range changes.Entities["donor-cell-lines"] {
		if err := s.upsertCanonical(ctx, tx, "donor_cell_line", []string{"id", "strain", "preparation", "batch_code", "active", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["strain"]), stringValue(item["preparation"]), nullableString(item["batchCode"]), item["active"] != false, timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range changes.Entities["recipient-egg-lots"] {
		if err := s.upsertCanonical(ctx, tx, "recipient_egg_lot", []string{"id", "breed", "lot_date", "label", "active", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["breed"]), nullableString(item["lotDate"]), stringValue(item["label"]), item["active"] != false, timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range changes.Entities["csof-lots"] {
		if err := s.upsertCanonical(ctx, tx, "csof_lot", []string{"id", "lot_code", "active", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["lotCode"]), item["active"] != false, timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range changes.Entities["treatment-groups"] {
		if err := s.upsertCanonical(ctx, tx, "treatment_group", []string{"id", "code", "name", "arm_type", "active", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["code"]), nullableString(item["name"]), stringValue(item["armType"]), item["active"] != false, timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range changes.Entities["fish-boxes"] {
		if err := s.upsertCanonical(ctx, tx, "fish_box", []string{"id", "box_code", "site_id", "active", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["boxCode"]), nullableReference(item["siteId"]), item["active"] != false, timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	if err := s.syncTimingProfiles(ctx, tx, state, &changes); err != nil {
		return err
	}
	for id, item := range changes.Entities["batches"] {
		if !s.referencesAvailableTx(ctx, tx, item, "siteId", "operatorId", "protocolId", "timingProfileId", "treatmentGroupId") {
			return fmt.Errorf("batch %s has an invalid foreign-key reference", id)
		}
		profileID := stringValue(item["timingProfileId"])
		if profileID == "" {
			return fmt.Errorf("batch %s has no timing profile", id)
		}
		protocolID := stringValue(item["protocolId"])
		if protocolID == "" {
			return fmt.Errorf("batch %s has no protocol", id)
		}
		if err := s.upsertCanonical(ctx, tx, "experiment_batch", []string{"id", "batch_code", "experiment_date", "day_no", "site_id", "operator_id", "protocol_id", "timing_profile_id", "treatment_group_id", "recipient_egg_lot_id", "csof_lot_id", "clutch_code", "replicate_no", "incubation_temp_c", "notes", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["batchCode"]), stringValue(item["experimentDate"]), nullableInt(item["dayNo"]), stringValue(item["siteId"]), stringValue(item["operatorId"]), protocolID, profileID, stringValue(item["treatmentGroupId"]), nullableReference(item["recipientEggLotId"]), nullableReference(item["csofLotId"]), nullableString(item["clutchCode"]), nullableInt(item["replicateNo"]), nullableNumber(item["incubationTempC"]), nullableString(item["notes"]), timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range changes.Entities["injection-lots"] {
		if !s.referencesAvailableTx(ctx, tx, item, "batchId", "donorCellLineId") {
			return fmt.Errorf("injection lot %s has an invalid foreign-key reference", id)
		}
		if err := s.upsertCanonical(ctx, tx, "injection_lot", []string{"id", "batch_id", "lot_no", "donor_cell_line_id", "enu_power_pct", "enu_pulse_us", "enu_led", "enu_start_at", "enu_finish_at", "activated_at", "n_eggs", "n_activated", "notes", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["batchId"]), stringValue(item["lotNo"]), stringValue(item["donorCellLineId"]), nullableInt(item["enuPowerPct"]), nullableInt(item["enuPulseUs"]), nullableInt(item["enuLed"]), item["enuStartAt"], item["enuFinishAt"], timestampValue(item["activatedAt"]), nullableInt(item["nEggs"]), intValue(item["nActivated"]), nullableString(item["notes"]), timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range changes.Entities["embryos"] {
		if !s.referencesAvailableTx(ctx, tx, item, "injectionLotId") {
			return fmt.Errorf("embryo %s has an invalid foreign-key reference", id)
		}
		if err := s.upsertCanonical(ctx, tx, "embryo", []string{"id", "injection_lot_id", "seq_in_lot", "embryo_code", "well_position", "exit_stage_id", "exit_at", "exit_reason", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["injectionLotId"]), intValue(item["seqInLot"]), stringValue(item["embryoCode"]), nullableString(item["wellPosition"]), nullableString(item["exitStageId"]), item["exitAt"], nullableString(item["exitReason"]), timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range changes.Entities["fish"] {
		if !s.referencesAvailableTx(ctx, tx, item, "donorCellLineId") {
			return fmt.Errorf("fish %s has an invalid foreign-key reference", id)
		}
		if err := s.upsertCanonical(ctx, tx, "clone_fish", []string{"id", "embryo_id", "fish_code", "running_no", "dob", "donor_cell_line_id", "site_id", "fish_box_id", "status", "biological_condition", "first_abnormal_on", "first_abnormal_age_days", "first_abnormal_stage_id", "sex", "fin_clipped", "exit_date", "exit_reason", "remarks", "created_at", "updated_at", "deleted_at"}, []any{id, nullableReference(item["embryoId"]), stringValue(item["fishCode"]), intValue(item["runningNo"]), stringValue(item["dob"]), stringValue(item["donorCellLineId"]), nullableReference(item["siteId"]), nullableReference(item["fishBoxId"]), stringValueOr(item["status"], "ALIVE"), stringValueOr(item["condition"], "NORMAL"), nullableString(item["firstAbnormalOn"]), nullableInt(item["firstAbnormalAgeDays"]), nullableString(item["firstAbnormalStageId"]), stringValueOr(item["sex"], "UNKNOWN"), item["finClipped"] == true, nullableString(item["exitDate"]), nullableFishExitReason(item["exitReason"]), nullableString(item["remarks"]), timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range changes.Observations {
		stageID := stageDefinitionID(stringValue(item["stageCode"]))
		if stageID == "" || !s.referencesAvailableTx(ctx, tx, item, "embryoId", "operatorId") {
			return fmt.Errorf("embryo observation %s has an invalid stage or foreign-key reference", id)
		}
		if err := s.upsertCanonical(ctx, tx, "embryo_observation", []string{"id", "client_uuid", "embryo_id", "stage_definition_id", "observed_at", "hpa_actual", "hpa_expected_snapshot", "deviation_h", "outcome", "biological_condition", "operator_id", "device_id", "is_backdated", "override_reason", "notes", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["clientUuid"]), stringValue(item["embryoId"]), stageID, timestampValue(item["observedAt"]), numberValue(item["hpaActual"]), numberValue(item["hpaExpectedSnapshot"]), numberValue(item["deviationH"]), stringValue(item["outcome"]), stringValue(item["condition"]), stringValue(item["operatorId"]), nullableString(item["deviceId"]), item["isBackdated"] == true, nullableString(item["overrideReason"]), nullableString(item["notes"]), timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range changes.Entities["embryos"] {
		observationID := nullableString(item["firstAbnormalObservationId"])
		query := "UPDATE embryo SET first_abnormal_observation_id = " + s.placeholder(1) + " WHERE id = " + s.placeholder(2)
		if _, err := tx.ExecContext(ctx, query, observationID, id); err != nil {
			return err
		}
	}
	for id, item := range changes.FishObservations {
		if !s.referencesAvailableTx(ctx, tx, item, "cloneFishId", "operatorId") {
			return fmt.Errorf("fish observation %s has an invalid foreign-key reference", id)
		}
		if err := s.upsertCanonical(ctx, tx, "fish_observation", []string{"id", "client_uuid", "clone_fish_id", "observed_on", "age_days", "outcome", "biological_condition", "operator_id", "device_id", "is_backdated", "notes", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["clientUuid"]), stringValue(item["cloneFishId"]), stringValue(item["observedOn"]), intValue(item["ageDays"]), stringValue(item["outcome"]), stringValue(item["condition"]), stringValue(item["operatorId"]), nullableString(item["deviceId"]), item["isBackdated"] == true, nullableString(item["notes"]), timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range changes.Entities["control-arm-counts"] {
		stageID := stageDefinitionID(stringValue(item["stageCode"]))
		if stageID == "" || !s.referencesAvailableTx(ctx, tx, item, "batchId") {
			return fmt.Errorf("control count %s has an invalid stage or foreign-key reference", id)
		}
		if err := s.upsertCanonical(ctx, tx, "control_arm_count", []string{"id", "batch_id", "arm_type", "stage_definition_id", "n_normal", "n_abnormal", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["batchId"]), stringValue(item["armType"]), stageID, intValue(item["nNormal"]), intValue(item["nAbnormal"]), timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for id, item := range changes.Entities["specimens"] {
		if !s.referencesAvailableTx(ctx, tx, item, "cloneFishId") || stringValue(item["specimenCode"]) == "" || stringValue(item["specimenKind"]) == "" || stringValue(item["specimenType"]) == "" {
			return fmt.Errorf("specimen %s has an invalid foreign-key or required field", id)
		}
		if err := s.upsertCanonical(ctx, tx, "specimen", []string{"id", "clone_fish_id", "specimen_code", "specimen_kind", "specimen_type", "collected_on", "frozen_on", "storage", "notes", "created_at", "updated_at", "deleted_at"}, []any{id, stringValue(item["cloneFishId"]), stringValue(item["specimenCode"]), stringValue(item["specimenKind"]), stringValue(item["specimenType"]), nullableString(item["collectedOn"]), nullableString(item["frozenOn"]), nullableString(item["storage"]), nullableString(item["notes"]), timestampValue(item["createdAt"]), timestampValue(item["updatedAt"]), item["deletedAt"]}, []string{"id"}); err != nil {
			return err
		}
	}
	for _, item := range changes.Audits {
		oldValues, _ := json.Marshal(item["oldValues"])
		newValues, _ := json.Marshal(item["newValues"])
		if err := s.upsertCanonical(ctx, tx, "audit_log", []string{"id", "table_name", "record_id", "action", "old_values", "new_values", "operator_id", "device_id", "occurred_at"}, []any{stringValue(item["id"]), stringValue(item["tableName"]), stringValue(item["recordId"]), stringValue(item["action"]), string(oldValues), string(newValues), nullableReference(item["operatorId"]), nullableString(item["deviceId"]), timestampValue(item["occurredAt"])}, []string{"id"}); err != nil {
			return err
		}
	}
	return nil
}

func (s *SQLRepository) syncTimingProfiles(ctx context.Context, tx *sql.Tx, state, changes *State) error {
	ids := make([]string, 0, len(changes.Entities["timing-profiles"]))
	for id := range changes.Entities["timing-profiles"] {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		profile := changes.Entities["timing-profiles"][id]
		protocolID := stringValue(profile["protocolId"])
		if protocolID == "" {
			return fmt.Errorf("timing profile %s has no protocol", id)
		}
		// Serialize version/current transitions per protocol across API
		// instances. The row lock is held until the enclosing mutation commits.
		lockProtocol := "SELECT id FROM protocol WHERE id = " + s.placeholder(1) + " FOR UPDATE"
		var lockedProtocol string
		if err := tx.QueryRowContext(ctx, lockProtocol, protocolID).Scan(&lockedProtocol); err != nil {
			return fmt.Errorf("lock timing protocol %s: %w", protocolID, err)
		}
		clearCurrent := "UPDATE stage_timing_profile SET is_current = " + s.placeholder(1) + " WHERE protocol_id = " + s.placeholder(2)
		if _, err := tx.ExecContext(ctx, clearCurrent, false, protocolID); err != nil {
			return err
		}
		if err := s.upsertCanonical(ctx, tx, "stage_timing_profile", []string{"id", "protocol_id", "version", "name", "reference_temp_c", "auto_temp_adjust", "source_note", "is_current", "created_by_operator_id", "created_at", "updated_at", "deleted_at"}, []any{id, protocolID, intValue(profile["version"]), stringValueOr(profile["name"], "Timing profile"), nullableNumber(profile["referenceTempC"]), profile["autoTempAdjust"] == true, nullableString(profile["sourceNote"]), false, nullableReference(profile["createdByOperatorId"]), timestampValue(profile["createdAt"]), timestampValue(profile["updatedAt"]), profile["deletedAt"]}, []string{"id"}); err != nil {
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
	profileState := state
	if profileState == nil {
		profileState = changes
	}
	for _, id := range ids {
		profile := profileState.Entities["timing-profiles"][id]
		if profile["isCurrent"] != true {
			continue
		}
		protocolID := stringValue(profile["protocolId"])
		if protocolID == "" {
			return fmt.Errorf("timing profile %s has no protocol", id)
		}
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
		if table != "audit_log" {
			updates = append(updates, "row_version = "+table+".row_version + 1")
		}
		query += " ON CONFLICT (" + strings.Join(conflict, ", ") + ") DO UPDATE SET " + strings.Join(updates, ", ")
	} else {
		updates := make([]string, 0, len(columns)-len(conflict))
		for _, column := range columns {
			if !containsString(conflict, column) {
				updates = append(updates, column+" = VALUES("+column+")")
			}
		}
		if table != "audit_log" {
			updates = append(updates, "row_version = row_version + 1")
		}
		query += " ON DUPLICATE KEY UPDATE " + strings.Join(updates, ", ")
	}
	_, err := tx.ExecContext(ctx, query, values...)
	return err
}

func (s *SQLRepository) referencesAvailableTx(ctx context.Context, tx *sql.Tx, item map[string]any, fields ...string) bool {
	for _, field := range fields {
		id := stringValue(item[field])
		if id == "" {
			return false
		}
		var table string
		switch field {
		case "siteId":
			table = "site"
		case "operatorId":
			table = "operator"
		case "treatmentGroupId":
			table = "treatment_group"
		case "protocolId":
			table = "protocol"
		case "timingProfileId":
			table = "stage_timing_profile"
		case "batchId":
			table = "experiment_batch"
		case "donorCellLineId":
			table = "donor_cell_line"
		case "injectionLotId":
			table = "injection_lot"
		case "cloneFishId":
			table = "clone_fish"
		default:
			continue
		}
		query := "SELECT 1 FROM " + table + " WHERE id = " + s.placeholder(1) + " AND deleted_at IS NULL"
		args := []any{id}
		if table != "stage_timing_profile" {
			query += " AND active = " + s.placeholder(2)
			args = append(args, true)
		}
		var found int
		if err := tx.QueryRowContext(ctx, query, args...).Scan(&found); err != nil {
			return false
		}
	}
	return true
}

func nullableReference(value any) any {
	id := stringValue(value)
	if id == "" {
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

func int64Value(value any) int64 {
	switch number := value.(type) {
	case int:
		return int64(number)
	case int8:
		return int64(number)
	case int16:
		return int64(number)
	case int32:
		return int64(number)
	case int64:
		return number
	case uint:
		return int64(number)
	case uint64:
		return int64(number)
	case float64:
		return int64(number)
	case []byte:
		var parsed int64
		_, _ = fmt.Sscan(string(number), &parsed)
		return parsed
	case string:
		var parsed int64
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

package httpapi

import (
	"context"
	"encoding/json"
	"reflect"
	"strconv"
	"strings"

	storepkg "github.com/P-PrPas/ChronoFish/backend/internal/store"
)

// publishCommittedVersions advances only rows in the request write set after
// the SQL transaction has committed. It keeps the in-process read model's
// optimistic fence aligned with the canonical row_version without exposing an
// uncommitted value or reloading the whole database.
func publishCommittedVersions(server *apiServer, delta *storepkg.Delta) {
	if server == nil || delta == nil {
		return
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	bump := func(item map[string]any, before map[string]any) {
		if item == nil {
			return
		}
		if before == nil {
			item["rowVersion"] = int64(1)
			return
		}
		version := int64Value(before["rowVersion"])
		if version < 1 {
			version = 1
		}
		item["rowVersion"] = version + 1
	}
	for resource, records := range delta.After.Entities {
		for id := range records {
			if current := server.entities[resource][id]; current != nil {
				bump(current, delta.Before.Entities[resource][id])
			}
		}
	}
	for id := range delta.After.Observations {
		if current := server.observations[id]; current != nil {
			bump(current, delta.Before.Observations[id])
		}
	}
	for id := range delta.After.FishObservations {
		if current := server.fishObs[id]; current != nil {
			bump(current, delta.Before.FishObservations[id])
		}
	}
	for _, audit := range delta.Audits {
		server.audits = append(server.audits, cloneMap(audit))
	}
}

func int64Value(value any) int64 {
	switch number := value.(type) {
	case int:
		return int64(number)
	case int64:
		return number
	case float64:
		return int64(number)
	case string:
		parsed, _ := strconv.ParseInt(number, 10, 64)
		return parsed
	default:
		return 0
	}
}

type stateStore interface {
	Load(context.Context, *apiServer) error
	Save(context.Context, *apiServer) error
	Close() error
}

type atomicStateStore interface {
	stateStore
	Reserve(context.Context, storepkg.Mutation) (storepkg.Mutation, bool, error)
	WaitForCompletion(context.Context, storepkg.Mutation) (storepkg.Mutation, error)
	Abort(context.Context, storepkg.Mutation) error
	Commit(context.Context, *storepkg.State, *storepkg.State, *storepkg.Mutation) error
}

type deltaStateStore interface {
	CommitDelta(context.Context, *storepkg.Delta, *storepkg.Mutation) error
}

type auditReader interface {
	QueryAudits(context.Context, storepkg.AuditQuery) ([]map[string]any, bool, error)
}

type canonicalReadModel interface {
	RefreshReadModelForRequest(context.Context, *apiServer, string) error
}

type operatorReader interface {
	OperatorActive(context.Context, string) (bool, error)
}

type mutationCacheValue struct {
	body    json.RawMessage
	present bool
}

type mutationCacheJournal struct {
	before  map[string]mutationCacheValue
	pending map[string]json.RawMessage
}

type memoryStateStore struct{}

func (memoryStateStore) Load(context.Context, *apiServer) error { return nil }
func (memoryStateStore) Save(context.Context, *apiServer) error { return nil }
func (memoryStateStore) Close() error                           { return nil }

type sqlStateStore struct {
	repository *storepkg.SQLRepository
}

func openStateStore(ctx context.Context, cfg config) (stateStore, error) {
	if cfg.dbDriver == "memory" {
		return memoryStateStore{}, nil
	}
	repository, err := storepkg.OpenSQLRepository(ctx, storepkg.SQLConfig{
		Driver: cfg.dbDriver, URL: cfg.databaseURL, MigrationsDir: cfg.migrationsDir,
		MaxOpenConns: cfg.maxOpenConns, MaxIdleConns: cfg.maxIdleConns, ConnMaxLifetime: cfg.connMaxLifetime,
	})
	if err != nil {
		return nil, err
	}
	return &sqlStateStore{repository: repository}, nil
}

func stateFromServer(server *apiServer) storepkg.State {
	server.mu.RLock()
	defer server.mu.RUnlock()
	return cloneState(storepkg.State{Entities: server.entities, Audits: server.audits, Observations: server.observations, FishObservations: server.fishObs, Idempotency: server.idempotency, IdempotencyStatus: server.idempotencyStatus, IdempotencyBinary: server.idempotencyBinary, IdempotencyHash: server.idempotencyHash, FishNo: server.fishNo})
}

func restoreDelta(server *apiServer, delta *storepkg.Delta) {
	server.mu.Lock()
	defer server.mu.Unlock()
	for resource, records := range delta.After.Entities {
		for id := range records {
			current := server.entities[resource][id]
			if !reflect.DeepEqual(current, records[id]) {
				continue
			}
			if before := delta.Before.Entities[resource][id]; before != nil {
				server.entities[resource][id] = cloneMap(before)
			} else {
				delete(server.entities[resource], id)
			}
		}
	}
	for id := range delta.After.Observations {
		if !reflect.DeepEqual(server.observations[id], delta.After.Observations[id]) {
			continue
		}
		if before := delta.Before.Observations[id]; before != nil {
			server.observations[id] = cloneMap(before)
		} else {
			delete(server.observations, id)
		}
	}
	for id := range delta.After.FishObservations {
		if !reflect.DeepEqual(server.fishObs[id], delta.After.FishObservations[id]) {
			continue
		}
		if before := delta.Before.FishObservations[id]; before != nil {
			server.fishObs[id] = cloneMap(before)
		} else {
			delete(server.fishObs, id)
		}
	}
	if len(delta.Audits) > 0 {
		ids := make(map[string]struct{}, len(delta.Audits))
		for _, audit := range delta.Audits {
			ids[stringValue(audit["id"])] = struct{}{}
		}
		kept := server.audits[:0]
		for _, audit := range server.audits {
			if _, remove := ids[stringValue(audit["id"])]; !remove {
				kept = append(kept, audit)
			}
		}
		server.audits = kept
	}
}

func snapshotMutationCache(server *apiServer) *mutationCacheJournal {
	return &mutationCacheJournal{before: make(map[string]mutationCacheValue), pending: make(map[string]json.RawMessage)}
}

func publishMutationCache(server *apiServer, journal *mutationCacheJournal) {
	if server == nil || journal == nil || len(journal.pending) == 0 {
		return
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	for key, body := range journal.pending {
		server.idempotency[key] = append(json.RawMessage(nil), body...)
	}
}

func restoreMutationCache(server *apiServer, journal *mutationCacheJournal) {
	if journal == nil {
		return
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	for key, previous := range journal.before {
		if previous.present {
			server.idempotency[key] = append(json.RawMessage(nil), previous.body...)
		} else {
			delete(server.idempotency, key)
		}
	}
}

func cloneState(state storepkg.State) storepkg.State {
	copyState := state
	copyState.Entities = make(map[string]map[string]map[string]any, len(state.Entities))
	for resource, records := range state.Entities {
		copyState.Entities[resource] = make(map[string]map[string]any, len(records))
		for id, item := range records {
			copyState.Entities[resource][id] = cloneMap(item)
		}
	}
	copyState.Audits = make([]map[string]any, len(state.Audits))
	for i, item := range state.Audits {
		copyState.Audits[i] = cloneMap(item)
	}
	copyState.Observations = make(map[string]map[string]any, len(state.Observations))
	for id, item := range state.Observations {
		copyState.Observations[id] = cloneMap(item)
	}
	copyState.FishObservations = make(map[string]map[string]any, len(state.FishObservations))
	for id, item := range state.FishObservations {
		copyState.FishObservations[id] = cloneMap(item)
	}
	copyState.Idempotency = make(map[string]json.RawMessage, len(state.Idempotency))
	for key, body := range state.Idempotency {
		copyState.Idempotency[key] = append(json.RawMessage(nil), body...)
	}
	copyState.IdempotencyStatus = mapsCloneInt(state.IdempotencyStatus)
	copyState.IdempotencyBinary = mapsCloneBool(state.IdempotencyBinary)
	copyState.IdempotencyHash = mapsCloneString(state.IdempotencyHash)
	return copyState
}

func mapsCloneInt(input map[string]int) map[string]int {
	output := make(map[string]int, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}

func mapsCloneBool(input map[string]bool) map[string]bool {
	output := make(map[string]bool, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}

func mapsCloneString(input map[string]string) map[string]string {
	output := make(map[string]string, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}

func applyState(server *apiServer, state storepkg.State) {
	server.mu.Lock()
	defer server.mu.Unlock()
	server.entities = state.Entities
	server.audits = state.Audits
	server.observations = state.Observations
	server.fishObs = state.FishObservations
	server.idempotency = state.Idempotency
	server.idempotencyStatus = state.IdempotencyStatus
	server.idempotencyBinary = state.IdempotencyBinary
	server.idempotencyHash = state.IdempotencyHash
	server.fishNo = state.FishNo
}

func (s *sqlStateStore) Load(ctx context.Context, server *apiServer) error {
	state := stateFromServer(server)
	if err := s.repository.Load(ctx, &state); err != nil {
		return err
	}
	applyState(server, state)
	return nil
}

// RefreshReadModel rehydrates the committed SQL view for a read request. SQL
// is authoritative across API instances; the in-process maps are only a
// derived view and are never the source of a successful write.
func (s *sqlStateStore) RefreshReadModel(ctx context.Context, server *apiServer) error {
	return s.Load(ctx, server)
}

// RefreshReadModelForRequest keeps the process view as a small, committed
// projection. Expensive analytical endpoints still opt into the complete
// projection because they genuinely need the related aggregates; master and
// detail endpoints refresh only their bounded dependency set.
func (s *sqlStateStore) RefreshReadModelForRequest(ctx context.Context, server *apiServer, path string) error {
	resource := strings.Trim(strings.TrimPrefix(path, "/api/v1/"), "/")
	if resource == "audit" {
		// The audit handler uses QueryAudits directly with filters/pagination.
		return nil
	}
	if strings.HasPrefix(resource, "analytics") || strings.HasPrefix(resource, "exports") || resource == "due" {
		return s.Load(ctx, server)
	}
	parts := strings.Split(resource, "/")
	resources := []string{}
	add := func(values ...string) { resources = append(resources, values...) }
	switch parts[0] {
	case "timing-profiles":
		add("protocols", "timing-profiles")
	case "batches":
		add("batches", "injection-lots", "embryos", "donor-cell-lines", "operators", "sites", "protocols", "timing-profiles", "treatment-groups")
	case "injection-lots":
		add("injection-lots", "batches", "embryos", "donor-cell-lines", "timing-profiles", "protocols", "observations")
	case "embryos":
		add("embryos", "injection-lots", "batches", "timing-profiles", "protocols", "operators", "donor-cell-lines", "observations")
	case "fish":
		add("fish", "embryos", "injection-lots", "batches", "donor-cell-lines", "fish-boxes", "fish-observations")
	case "promotions":
		add("embryos", "injection-lots", "batches", "protocols", "timing-profiles", "donor-cell-lines", "fish", "observations")
	case "observations":
		add("embryos", "injection-lots", "batches", "protocols", "timing-profiles", "operators", "donor-cell-lines", "fish", "observations", "fish-observations")
	case "specimens":
		add("specimens", "fish")
	case "control-arm-counts":
		add("control-arm-counts", "batches", "protocols", "timing-profiles")
	case "sites", "operators", "donor-cell-lines", "recipient-egg-lots", "csof-lots", "treatment-groups", "fish-boxes", "protocols":
		add(parts[0])
	default:
		return nil
	}
	state := storepkg.State{Entities: make(map[string]map[string]map[string]any), Observations: make(map[string]map[string]any), FishObservations: make(map[string]map[string]any)}
	if err := s.repository.LoadResources(ctx, &state, resources...); err != nil {
		return err
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	for _, name := range resources {
		if loaded := state.Entities[name]; loaded != nil {
			server.entities[name] = loaded
		}
	}
	if state.Observations != nil && containsResource(resources, "observations") {
		server.observations = state.Observations
	}
	if state.FishObservations != nil && containsResource(resources, "fish-observations") {
		server.fishObs = state.FishObservations
	}
	return nil
}

func containsResource(resources []string, target string) bool {
	for _, resource := range resources {
		if resource == target {
			return true
		}
	}
	return false
}

func (s *sqlStateStore) Save(ctx context.Context, server *apiServer) error {
	state := stateFromServer(server)
	return s.repository.Save(ctx, &state)
}

func (s *sqlStateStore) Reserve(ctx context.Context, mutation storepkg.Mutation) (storepkg.Mutation, bool, error) {
	return s.repository.Reserve(ctx, mutation)
}

func (s *sqlStateStore) WaitForCompletion(ctx context.Context, mutation storepkg.Mutation) (storepkg.Mutation, error) {
	return s.repository.WaitForCompletion(ctx, mutation)
}

func (s *sqlStateStore) Renew(ctx context.Context, mutation storepkg.Mutation) error {
	return s.repository.Renew(ctx, mutation)
}

func (s *sqlStateStore) Abort(ctx context.Context, mutation storepkg.Mutation) error {
	return s.repository.Abort(ctx, mutation)
}

func (s *sqlStateStore) Commit(ctx context.Context, before, after *storepkg.State, mutation *storepkg.Mutation) error {
	return s.repository.Commit(ctx, before, after, mutation)
}

func (s *sqlStateStore) CommitDelta(ctx context.Context, delta *storepkg.Delta, mutation *storepkg.Mutation) error {
	return s.repository.CommitDelta(ctx, delta, mutation)
}

func (s *sqlStateStore) QueryAudits(ctx context.Context, query storepkg.AuditQuery) ([]map[string]any, bool, error) {
	return s.repository.QueryAudits(ctx, query)
}

func (s *sqlStateStore) OperatorActive(ctx context.Context, id string) (bool, error) {
	return s.repository.OperatorActive(ctx, id)
}

var _ auditReader = (*sqlStateStore)(nil)

func (s *sqlStateStore) Close() error { return s.repository.Close() }

var _ stateStore = (*sqlStateStore)(nil)
var _ atomicStateStore = (*sqlStateStore)(nil)

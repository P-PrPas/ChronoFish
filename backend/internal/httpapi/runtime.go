package httpapi

import (
	"context"
	"encoding/json"

	storepkg "github.com/P-PrPas/ChronoFish/backend/internal/store"
)

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

type mutationCacheValue struct {
	body    json.RawMessage
	present bool
}

type mutationCacheJournal struct {
	before map[string]mutationCacheValue
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

func stateReferences(server *apiServer) *storepkg.State {
	server.mu.RLock()
	defer server.mu.RUnlock()
	return &storepkg.State{Entities: server.entities, Audits: server.audits, Observations: server.observations, FishObservations: server.fishObs}
}

func restoreDelta(server *apiServer, delta *storepkg.Delta) {
	server.mu.Lock()
	defer server.mu.Unlock()
	for resource, records := range delta.After.Entities {
		for id := range records {
			if before := delta.Before.Entities[resource][id]; before != nil {
				server.entities[resource][id] = cloneMap(before)
			} else {
				delete(server.entities[resource], id)
			}
		}
	}
	for id := range delta.After.Observations {
		if before := delta.Before.Observations[id]; before != nil {
			server.observations[id] = cloneMap(before)
		} else {
			delete(server.observations, id)
		}
	}
	for id := range delta.After.FishObservations {
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
	return &mutationCacheJournal{before: make(map[string]mutationCacheValue)}
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

func (s *sqlStateStore) Abort(ctx context.Context, mutation storepkg.Mutation) error {
	return s.repository.Abort(ctx, mutation)
}

func (s *sqlStateStore) Commit(ctx context.Context, before, after *storepkg.State, mutation *storepkg.Mutation) error {
	return s.repository.Commit(ctx, before, after, mutation)
}

func (s *sqlStateStore) CommitDelta(ctx context.Context, delta *storepkg.Delta, mutation *storepkg.Mutation) error {
	return s.repository.CommitDelta(ctx, delta, mutation)
}

func (s *sqlStateStore) Close() error { return s.repository.Close() }

var _ stateStore = (*sqlStateStore)(nil)
var _ atomicStateStore = (*sqlStateStore)(nil)

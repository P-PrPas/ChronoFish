package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
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

type atomicStateStore interface {
	stateStore
	Reserve(context.Context, storepkg.Mutation) (storepkg.Mutation, bool, error)
	WaitForCompletion(context.Context, storepkg.Mutation) (storepkg.Mutation, error)
	Abort(context.Context, storepkg.Mutation) error
	Commit(context.Context, *storepkg.State, *storepkg.Mutation) error
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
	driver := "pgx"
	if cfg.dbDriver == "mysql" {
		driver = "mysql"
		if !strings.Contains(strings.ToLower(cfg.databaseURL), "multistatements=") {
			separator := "?"
			if strings.Contains(cfg.databaseURL, "?") {
				separator = "&"
			}
			cfg.databaseURL += separator + "multiStatements=true"
		}
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
	if err := storepkg.RunMigrations(ctx, db, cfg.dbDriver, cfg.migrationsDir); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &sqlStateStore{repository: storepkg.NewSQLRepository(db, cfg.dbDriver)}, nil
}

func stateFromServer(server *apiServer) storepkg.State {
	server.mu.RLock()
	defer server.mu.RUnlock()
	return storepkg.State{Entities: server.entities, Audits: server.audits, Observations: server.observations, FishObservations: server.fishObs, Idempotency: server.idempotency, IdempotencyStatus: server.idempotencyStatus, IdempotencyBinary: server.idempotencyBinary, IdempotencyHash: server.idempotencyHash, FishNo: server.fishNo}
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

func (s *sqlStateStore) Commit(ctx context.Context, state *storepkg.State, mutation *storepkg.Mutation) error {
	return s.repository.Commit(ctx, state, mutation)
}

func (s *sqlStateStore) Close() error { return s.repository.Close() }

var _ stateStore = (*sqlStateStore)(nil)
var _ atomicStateStore = (*sqlStateStore)(nil)

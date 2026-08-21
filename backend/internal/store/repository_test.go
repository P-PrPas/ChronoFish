package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestReserveSameKeyReturnsStoredWinner(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := NewSQLRepository(db, "postgres")
	request := Mutation{Scope: "site:create", Key: "key-1", RequestHash: "hash-1", OperatorID: "operator-1", DeviceID: "device-1", LeaseToken: "token-1"}

	reserve := func(row *sqlmock.Rows, affected int64) (Mutation, bool, error) {
		mock.ExpectBegin()
		mock.ExpectExec("INSERT INTO request_idempotency").WithArgs(
			request.Scope, request.Key, request.RequestHash,
			sqlmock.AnyArg(), sqlmock.AnyArg(), request.OperatorID, request.DeviceID, sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(),
		).WillReturnResult(sqlmock.NewResult(0, affected))
		mock.ExpectQuery("SELECT request_hash, status_code, content_type, response_body, completed_at, lease_until, lease_token").WithArgs(request.Scope, request.Key).WillReturnRows(row)
		mock.ExpectCommit()
		return repo.Reserve(context.Background(), request)
	}

	reserved, created, err := reserve(sqlmock.NewRows([]string{"request_hash", "status_code", "content_type", "response_body", "completed_at", "lease_until", "lease_token"}).AddRow("hash-1", 102, "", "", nil, time.Now().Add(time.Minute), "token-1"), 1)
	if err != nil || !created || reserved.RequestHash != request.RequestHash {
		t.Fatalf("first reservation = %#v, created=%v, err=%v", reserved, created, err)
	}

	winnerBody := `{"id":"winner"}`
	reserved, created, err = reserve(sqlmock.NewRows([]string{"request_hash", "status_code", "content_type", "response_body", "completed_at", "lease_until", "lease_token"}).AddRow("hash-1", 201, "application/json", winnerBody, time.Now(), time.Now().Add(time.Minute), "token-1"), 0)
	if err != nil || created || string(reserved.Body) != winnerBody || reserved.Status != 201 {
		t.Fatalf("replay reservation = %#v, created=%v, err=%v", reserved, created, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestReserveRejectsHashMismatch(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := NewSQLRepository(db, "postgres")
	request := Mutation{Scope: "site:create", Key: "key-1", RequestHash: "new-hash", OperatorID: "operator-1", DeviceID: "device-1"}
	mock.ExpectBegin()
	mock.ExpectExec("INSERT INTO request_idempotency").WithArgs(
		request.Scope, request.Key, request.RequestHash,
		sqlmock.AnyArg(), sqlmock.AnyArg(), request.OperatorID, request.DeviceID, sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(),
	).WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectQuery("SELECT request_hash, status_code, content_type, response_body, completed_at, lease_until, lease_token").WithArgs(request.Scope, request.Key).
		WillReturnRows(sqlmock.NewRows([]string{"request_hash", "status_code", "content_type", "response_body", "completed_at", "lease_until", "lease_token"}).AddRow("winner-hash", 201, "application/json", `{"id":"winner"}`, time.Now(), time.Now().Add(time.Minute), "token-1"))
	mock.ExpectRollback()
	_, _, err = repo.Reserve(context.Background(), request)
	if !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("error = %v, want idempotency conflict", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestReserveExpiredLeaseElectsNewOwner(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := NewSQLRepository(db, "postgres")
	request := Mutation{Scope: "site:create", Key: "lease-key", RequestHash: "lease-hash", OperatorID: "operator-1", DeviceID: "device-1", LeaseToken: "new-token"}
	mock.ExpectBegin()
	mock.ExpectExec("INSERT INTO request_idempotency").WithArgs(request.Scope, request.Key, request.RequestHash, sqlmock.AnyArg(), sqlmock.AnyArg(), request.OperatorID, request.DeviceID, sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectQuery("SELECT request_hash, status_code, content_type, response_body, completed_at, lease_until, lease_token").WithArgs(request.Scope, request.Key).WillReturnRows(sqlmock.NewRows([]string{"request_hash", "status_code", "content_type", "response_body", "completed_at", "lease_until", "lease_token"}).AddRow(request.RequestHash, 102, "", "", nil, time.Now().Add(-time.Minute), "old-token"))
	mock.ExpectExec("UPDATE request_idempotency SET lease_until").WithArgs(sqlmock.AnyArg(), sqlmock.AnyArg(), request.Scope, request.Key, request.RequestHash, sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery("SELECT request_hash, status_code, content_type, response_body, completed_at, lease_until, lease_token").WithArgs(request.Scope, request.Key).WillReturnRows(sqlmock.NewRows([]string{"request_hash", "status_code", "content_type", "response_body", "completed_at", "lease_until", "lease_token"}).AddRow(request.RequestHash, 102, "", "", nil, time.Now().Add(time.Minute), request.LeaseToken))
	mock.ExpectCommit()
	_, created, err := repo.Reserve(context.Background(), request)
	if err != nil || !created {
		t.Fatalf("expired reservation = created %v, err %v; want new owner", created, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestCommitRollsBackWhenResponseCompletionFails(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := NewSQLRepository(db, "postgres")
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("UPDATE request_idempotency SET status_code = $1")).
		WithArgs(201, "application/json", `{"ok":true}`, sqlmock.AnyArg(), "scope", "key", "hash").
		WillReturnError(errors.New("connection dropped"))
	mock.ExpectRollback()
	err = repo.Commit(context.Background(), &State{}, &State{}, &Mutation{
		Scope: "scope", Key: "key", RequestHash: "hash", Status: 201,
		ContentType: "application/json", Body: []byte(`{"ok":true}`),
	})
	if err == nil || !regexp.MustCompile("connection dropped").MatchString(err.Error()) {
		t.Fatalf("error = %v, want commit failure", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestCommitDeltaRejectsStaleLeaseOwner(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := NewSQLRepository(db, "postgres")
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("UPDATE request_idempotency SET status_code = $1")).
		WithArgs(201, "application/json", `{"ok":true}`, sqlmock.AnyArg(), "scope", "key", "hash", "stale-token").
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectRollback()
	err = repo.CommitDelta(context.Background(), &Delta{}, &Mutation{Scope: "scope", Key: "key", RequestHash: "hash", LeaseToken: "stale-token", Status: 201, ContentType: "application/json", Body: []byte(`{"ok":true}`)})
	if err == nil {
		t.Fatal("stale lease owner unexpectedly committed")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestCommitDeltaRejectsStaleCanonicalVersionBeforeUpsert(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := NewSQLRepository(db, "postgres")
	old := "2026-01-01T00:00:00Z"
	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta("SELECT row_version FROM site WHERE id = $1 FOR UPDATE")).
		WithArgs("site-1").
		WillReturnRows(sqlmock.NewRows([]string{"row_version"}).AddRow(int64(2)))
	mock.ExpectRollback()
	delta := &Delta{
		Before: State{Entities: map[string]map[string]map[string]any{"sites": {
			"site-1": {"id": "site-1", "updatedAt": old, "rowVersion": int64(1)},
		}}},
		After: State{Entities: map[string]map[string]map[string]any{"sites": {
			"site-1": {"id": "site-1", "code": "new", "updatedAt": old},
		}}},
	}
	err = repo.CommitDelta(context.Background(), delta, nil)
	if err == nil || !strings.Contains(err.Error(), "concurrent mutation conflict") {
		t.Fatalf("error = %v, want concurrent mutation conflict", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestAbortAndRenewRequireCurrentLeaseToken(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := NewSQLRepository(db, "postgres")
	mutation := Mutation{Scope: "scope", Key: "key", RequestHash: "hash", LeaseToken: "token"}
	mock.ExpectExec(regexp.QuoteMeta("UPDATE request_idempotency SET lease_until = $1")).
		WithArgs(sqlmock.AnyArg(), mutation.Scope, mutation.Key, mutation.RequestHash, mutation.LeaseToken).
		WillReturnResult(sqlmock.NewResult(0, 0))
	if err := repo.Renew(context.Background(), mutation); err == nil {
		t.Fatal("renew unexpectedly succeeded for stale owner")
	}
	mock.ExpectExec(regexp.QuoteMeta("DELETE FROM request_idempotency")).
		WithArgs(mutation.Scope, mutation.Key, mutation.RequestHash, mutation.LeaseToken).
		WillReturnResult(sqlmock.NewResult(0, 0))
	if err := repo.Abort(context.Background(), mutation); err == nil {
		t.Fatal("stale owner unexpectedly aborted reservation")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestChangedStateOnlyContainsMutationDelta(t *testing.T) {
	before := &State{
		Entities: map[string]map[string]map[string]any{
			"sites": {
				"site-1": {"id": "site-1", "code": "unchanged"},
				"site-2": {"id": "site-2", "code": "old"},
			},
		},
	}
	after := &State{
		Entities: map[string]map[string]map[string]any{
			"sites": {
				"site-1": {"id": "site-1", "code": "unchanged"},
				"site-2": {"id": "site-2", "code": "new"},
				"site-3": {"id": "site-3", "code": "created"},
			},
		},
	}
	delta := changedState(before, after)
	if len(delta.Entities["sites"]) != 2 || delta.Entities["sites"]["site-2"]["code"] != "new" || delta.Entities["sites"]["site-3"]["code"] != "created" {
		t.Fatalf("delta = %#v, want only updated and created sites", delta.Entities)
	}
}

func TestStringValueDecodesDriverBytes(t *testing.T) {
	if got := stringValue([]byte("operator-1")); got != "operator-1" {
		t.Fatalf("stringValue = %q, want driver text", got)
	}
}

func TestRewriteAssignedFishBodyReconcilesNestedBulkResponse(t *testing.T) {
	body := []byte(`{"items":[{"status":"created","fish":{"id":"fish-1","runningNo":1,"fishCode":"No.1_Clone2-wt cell-20"}}]}`)
	got := rewriteAssignedFishBody(body, map[string]int{"fish-1": 27})
	var decoded map[string]any
	if err := json.Unmarshal(got, &decoded); err != nil {
		t.Fatal(err)
	}
	fish := decoded["items"].([]any)[0].(map[string]any)["fish"].(map[string]any)
	if int(fish["runningNo"].(float64)) != 27 || fish["fishCode"] != "No.27_Clone2-wt cell-20" {
		t.Fatalf("reconciled fish = %#v", fish)
	}
}

func TestSQLRepositoryNormalizesPGXDriver(t *testing.T) {
	if NewSQLRepository(nil, "pgx").placeholder(2) != "$2" {
		t.Fatal("pgx integration driver must use PostgreSQL placeholders")
	}
}

func TestCommitPersistsOnlyChangedCanonicalRows(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := NewSQLRepository(db, "postgres")
	before := &State{Entities: map[string]map[string]map[string]any{
		"sites": {
			"site-1": {"id": "site-1", "code": "old", "name": "Old", "active": true, "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"},
			"site-2": {"id": "site-2", "code": "untouched", "name": "Untouched", "active": true, "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"},
		},
	},
	}
	after := &State{Entities: map[string]map[string]map[string]any{
		"sites": {
			"site-1": {"id": "site-1", "code": "new", "name": "New", "active": true, "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"},
			"site-2": {"id": "site-2", "code": "untouched", "name": "Untouched", "active": true, "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"},
		},
	},
	}
	mock.ExpectBegin()
	mock.ExpectExec("INSERT INTO site").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	if err := repo.Commit(context.Background(), before, after, nil); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestCommitDeltaPersistsOnlyTouchedRows(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := NewSQLRepository(db, "postgres")
	refs := &State{Entities: map[string]map[string]map[string]any{"sites": {
		"site-1": {"id": "site-1", "code": "LAB", "name": "Lab", "active": true, "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"},
		"site-2": {"id": "site-2", "code": "OTHER", "name": "Other", "active": true, "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"},
	}}}
	delta := &Delta{After: State{Entities: map[string]map[string]map[string]any{"sites": {
		"site-1": refs.Entities["sites"]["site-1"],
	}}}}
	mock.ExpectBegin()
	mock.ExpectExec("INSERT INTO site").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	if err := repo.CommitDelta(context.Background(), delta, nil); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// This test is intentionally opt-in because it needs a migrated PostgreSQL or
// MySQL service. The primary key reservation is the concurrency boundary: the
// database, rather than process memory, elects exactly one creator.
func TestSQLRepositoryConcurrentSameKey(t *testing.T) {
	dsn := os.Getenv("CHRONOFISH_TEST_DATABASE_URL")
	driver := os.Getenv("CHRONOFISH_TEST_DATABASE_DRIVER")
	if dsn == "" || driver == "" {
		t.Skip("set CHRONOFISH_TEST_DATABASE_DRIVER and CHRONOFISH_TEST_DATABASE_URL for an engine integration test")
	}
	db, err := sql.Open(driver, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		t.Skipf("database unavailable: %v", err)
	}
	repo := NewSQLRepository(db, driver)
	request := Mutation{
		Scope: "test:concurrent", Key: newUUID(), RequestHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		OperatorID: "00000000-0000-7000-8000-000000000001", DeviceID: "test-device",
	}
	results := make(chan struct {
		created  bool
		mutation Mutation
		err      error
	}, 2)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			reserved, created, reserveErr := repo.Reserve(ctx, request)
			results <- struct {
				created  bool
				mutation Mutation
				err      error
			}{created: created, mutation: reserved, err: reserveErr}
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	createdCount := 0
	winningMutation := request
	for result := range results {
		if result.err != nil {
			t.Fatal(result.err)
		}
		if result.created {
			createdCount++
		}
		if result.mutation.LeaseToken != "" {
			winningMutation = result.mutation
		}
	}
	if createdCount != 1 {
		t.Fatalf("created count = %d, want exactly one", createdCount)
	}
	if err := repo.Abort(ctx, winningMutation); err != nil {
		t.Fatal(err)
	}
}

func TestSQLRepositoryRowVersionFenceAllowsOneConcurrentUpdate(t *testing.T) {
	dsn := os.Getenv("CHRONOFISH_TEST_DATABASE_URL")
	driver := os.Getenv("CHRONOFISH_TEST_DATABASE_DRIVER")
	if dsn == "" || driver == "" {
		t.Skip("set CHRONOFISH_TEST_DATABASE_DRIVER and CHRONOFISH_TEST_DATABASE_URL for an engine integration test")
	}
	db, err := sql.Open(driver, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		t.Skipf("database unavailable: %v", err)
	}
	repo := NewSQLRepository(db, driver)
	id := newUUID()
	now := time.Now().UTC()
	query := "INSERT INTO site (id, code, name, active, created_at, updated_at, deleted_at) VALUES ($1,$2,$3,$4,$5,$6,$7)"
	if driver == "mysql" {
		query = "INSERT INTO site (id, code, name, active, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?)"
	}
	if _, err := db.ExecContext(ctx, query, id, "fence-"+id[:8], "Fence", true, now, now, nil); err != nil {
		t.Fatal(err)
	}
	defer db.ExecContext(context.Background(), "DELETE FROM site WHERE id = "+repo.placeholder(1), id)
	makeDelta := func(name string) *Delta {
		return &Delta{Before: State{Entities: map[string]map[string]map[string]any{"sites": {id: {"id": id, "code": "fence-" + id[:8], "name": "Fence", "active": true, "rowVersion": int64(1)}}}}, After: State{Entities: map[string]map[string]map[string]any{"sites": {id: {"id": id, "code": "fence-" + id[:8], "name": name, "active": true, "rowVersion": int64(1), "createdAt": now.Format(time.RFC3339), "updatedAt": now.Format(time.RFC3339)}}}}}
	}
	results := make(chan error, 2)
	start := make(chan struct{})
	for _, name := range []string{"Fence A", "Fence B"} {
		go func(name string) { <-start; results <- repo.CommitDelta(ctx, makeDelta(name), nil) }(name)
	}
	close(start)
	first, second := <-results, <-results
	if (first == nil) == (second == nil) {
		t.Fatalf("concurrent row-version results = %v, %v; want exactly one success", first, second)
	}
}

package store

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"regexp"
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
	request := Mutation{Scope: "site:create", Key: "key-1", RequestHash: "hash-1", OperatorID: "operator-1", DeviceID: "device-1"}

	reserve := func(row *sqlmock.Rows) (Mutation, bool, error) {
		mock.ExpectBegin()
		mock.ExpectExec("INSERT INTO request_idempotency").WithArgs(
			request.Scope, request.Key, request.RequestHash,
			sqlmock.AnyArg(), sqlmock.AnyArg(), request.OperatorID, request.DeviceID, sqlmock.AnyArg(),
		).WillReturnResult(sqlmock.NewResult(0, 1))
		mock.ExpectQuery("SELECT request_hash, status_code, content_type, response_body, completed_at").WithArgs(request.Scope, request.Key).WillReturnRows(row)
		mock.ExpectCommit()
		return repo.Reserve(context.Background(), request)
	}

	reserved, created, err := reserve(sqlmock.NewRows([]string{"request_hash", "status_code", "content_type", "response_body", "completed_at"}).AddRow("hash-1", 102, "", "", nil))
	if err != nil || !created || reserved.RequestHash != request.RequestHash {
		t.Fatalf("first reservation = %#v, created=%v, err=%v", reserved, created, err)
	}

	winnerBody := `{"id":"winner"}`
	reserved, created, err = reserve(sqlmock.NewRows([]string{"request_hash", "status_code", "content_type", "response_body", "completed_at"}).AddRow("hash-1", 201, "application/json", winnerBody, time.Now()))
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
		sqlmock.AnyArg(), sqlmock.AnyArg(), request.OperatorID, request.DeviceID, sqlmock.AnyArg(),
	).WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectQuery("SELECT request_hash, status_code, content_type, response_body, completed_at").WithArgs(request.Scope, request.Key).
		WillReturnRows(sqlmock.NewRows([]string{"request_hash", "status_code", "content_type", "response_body", "completed_at"}).AddRow("winner-hash", 201, "application/json", `{"id":"winner"}`, time.Now()))
	mock.ExpectRollback()
	_, _, err = repo.Reserve(context.Background(), request)
	if !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("error = %v, want idempotency conflict", err)
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
	err = repo.Commit(context.Background(), &State{}, &Mutation{
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
		created bool
		err     error
	}, 2)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, created, reserveErr := repo.Reserve(ctx, request)
			results <- struct {
				created bool
				err     error
			}{created: created, err: reserveErr}
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	createdCount := 0
	for result := range results {
		if result.err != nil {
			t.Fatal(result.err)
		}
		if result.created {
			createdCount++
		}
	}
	if createdCount != 1 {
		t.Fatalf("created count = %d, want exactly one", createdCount)
	}
	if err := repo.Abort(ctx, request); err != nil {
		t.Fatal(err)
	}
}

package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"

	storepkg "github.com/P-PrPas/ChronoFish/backend/internal/store"
)

type failingLoadStore struct{}

func (failingLoadStore) Load(context.Context, *apiServer) error {
	return errors.New("database unavailable")
}
func (failingLoadStore) Save(context.Context, *apiServer) error { return nil }
func (failingLoadStore) Close() error                           { return nil }

type failingCommitStore struct{}

func (failingCommitStore) Load(context.Context, *apiServer) error { return nil }
func (failingCommitStore) Save(context.Context, *apiServer) error { return nil }
func (failingCommitStore) Close() error                           { return nil }
func (failingCommitStore) Reserve(_ context.Context, value storepkg.Mutation) (storepkg.Mutation, bool, error) {
	return value, true, nil
}
func (failingCommitStore) WaitForCompletion(context.Context, storepkg.Mutation) (storepkg.Mutation, error) {
	return storepkg.Mutation{}, errors.New("not expected")
}
func (failingCommitStore) Renew(context.Context, storepkg.Mutation) error { return nil }
func (failingCommitStore) Abort(context.Context, storepkg.Mutation) error { return nil }
func (failingCommitStore) Commit(context.Context, *storepkg.State, *storepkg.State, *storepkg.Mutation) error {
	return errors.New("transaction failed")
}
func (failingCommitStore) CommitDelta(context.Context, *storepkg.Delta, *storepkg.Mutation) error {
	return errors.New("transaction failed")
}

func TestHTTPErrorMessagesAreUTF8(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/does-not-exist", nil)
	newHandler("test", "").ServeHTTP(recorder, request)
	if !utf8.Valid(recorder.Body.Bytes()) {
		t.Fatal("error response is not valid UTF-8")
	}
	if !strings.Contains(recorder.Body.String(), "ไม่พบ endpoint") {
		t.Fatalf("error response lost Thai text: %s", recorder.Body.String())
	}
}

func TestDatabaseLoadFailureFailsClosed(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	newHandlerWithConfig("test", "", failingLoadStore{}, "").ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusServiceUnavailable)
	}
}

func TestDatabaseCommitFailureDoesNotPublishMemoryMutation(t *testing.T) {
	handler := newHandlerWithConfig("test", "", failingCommitStore{}, "")
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/sites", strings.NewReader(`{"code":"rollback","name":"Rollback"}`))
	request.Header.Set("X-Operator-Id", "00000000-0000-7000-8000-000000000001")
	request.Header.Set("X-Device-Id", "test-device")
	request.Header.Set("X-Idempotency-Key", "01900000-0000-7000-8000-000000000099")
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusServiceUnavailable)
	}
	readback := httptest.NewRecorder()
	handler.ServeHTTP(readback, httptest.NewRequest(http.MethodGet, "/api/v1/sites", nil))
	if strings.Contains(readback.Body.String(), "rollback") {
		t.Fatalf("failed mutation remained in memory: %s", readback.Body.String())
	}
}

func TestFailedDeltaRollbackPreservesConcurrentFeatureCacheEntries(t *testing.T) {
	server := newAPIServer()
	server.idempotency["other-request"] = []byte(`{"id":"other"}`)
	journal := snapshotMutationCache(server)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/sites", nil).WithContext(context.WithValue(context.Background(), mutationCacheContextKey{}, journal))
	server.setMutationCache(request, "this-request", []byte(`{"id":"this"}`))
	server.idempotency["other-request"] = []byte(`{"id":"other-updated"}`)
	restoreMutationCache(server, journal)
	if _, ok := server.idempotency["this-request"]; ok {
		t.Fatal("failed request cache entry was not rolled back")
	}
	if got := string(server.idempotency["other-request"]); got != `{"id":"other-updated"}` {
		t.Fatalf("unrelated cache entry = %s, want concurrent update preserved", got)
	}
}

func TestConcurrentDifferentMutationsPublishBothRecords(t *testing.T) {
	handler := newHandler("test", "")
	requests := []struct {
		code string
		key  string
	}{
		{"concurrent-a", "01900000-0000-7000-8000-000000000101"},
		{"concurrent-b", "01900000-0000-7000-8000-000000000102"},
	}
	results := make(chan int, len(requests))
	start := make(chan struct{})
	var wait sync.WaitGroup
	for _, input := range requests {
		input := input
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			request := httptest.NewRequest(http.MethodPost, "/api/v1/sites", strings.NewReader(`{"code":"`+input.code+`","name":"`+input.code+`"}`))
			request.Header.Set("X-Operator-Id", "00000000-0000-7000-8000-000000000001")
			request.Header.Set("X-Device-Id", "test-device")
			request.Header.Set("X-Idempotency-Key", input.key)
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)
			results <- recorder.Code
		}()
	}
	close(start)
	wait.Wait()
	close(results)
	for status := range results {
		if status != http.StatusCreated {
			t.Fatalf("concurrent mutation status = %d, want %d", status, http.StatusCreated)
		}
	}
	readback := httptest.NewRecorder()
	handler.ServeHTTP(readback, httptest.NewRequest(http.MethodGet, "/api/v1/sites", nil))
	for _, input := range requests {
		if !strings.Contains(readback.Body.String(), input.code) {
			t.Fatalf("site %q missing after concurrent mutations: %s", input.code, readback.Body.String())
		}
	}
}

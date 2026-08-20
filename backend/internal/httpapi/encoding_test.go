package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
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
func (failingCommitStore) Abort(context.Context, storepkg.Mutation) error { return nil }
func (failingCommitStore) Commit(context.Context, *storepkg.State, *storepkg.Mutation) error {
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

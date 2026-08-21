package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/P-PrPas/ChronoFish/backend/internal/store"
)

func TestUnitOfWorkRecordsOnlyAuditedRows(t *testing.T) {
	work := NewUnitOfWork()
	work.RecordAudit(map[string]any{"id": "audit-1"}, "site", "site-1", nil, map[string]any{"id": "site-1", "code": "LAB"})
	work.RecordAudit(map[string]any{"id": "audit-2"}, "site", "site-2", map[string]any{"id": "site-2", "code": "OLD"}, map[string]any{"id": "site-2", "code": "NEW"})
	delta := work.Delta()
	if len(delta.After.Entities["sites"]) != 2 || len(delta.Before.Entities["sites"]) != 1 {
		t.Fatalf("delta = %#v, want only two touched rows", delta)
	}
	if len(delta.Audits) != 2 {
		t.Fatalf("audit count = %d, want 2", len(delta.Audits))
	}
}

func TestUnitOfWorkRecordsSpecializedRowsAndAllCanonicalTargets(t *testing.T) {
	work := NewUnitOfWork()
	for _, table := range []string{"embryo_observation", "fish_observation"} {
		work.RecordAudit(map[string]any{"id": table}, table, table+"-1", map[string]any{"id": table + "-1"}, map[string]any{"id": table + "-1", "outcome": "ALIVE"})
	}
	for _, table := range []string{
		"site", "operator", "donor_cell_line", "recipient_egg_lot", "csof_lot", "treatment_group",
		"fish_box", "protocol", "stage_timing_profile", "experiment_batch", "injection_lot", "embryo",
		"clone_fish", "specimen", "control_arm_count",
	} {
		work.RecordAudit(map[string]any{"id": table}, table, table+"-1", nil, map[string]any{"id": table + "-1"})
	}
	work.RecordAudit(map[string]any{"id": "unknown"}, "not-a-table", "ignored", nil, map[string]any{"id": "ignored"})
	work.RecordAudit(nil, "site", "deleted", map[string]any{"id": "deleted"}, nil)
	delta := work.Delta()
	if len(delta.After.Observations) != 1 || len(delta.After.FishObservations) != 1 {
		t.Fatalf("specialized delta = %#v", delta)
	}
	if len(delta.After.Entities) != 15 {
		t.Fatalf("canonical resources = %d, want 15", len(delta.After.Entities))
	}
	if delta.Before.Entities["sites"]["deleted"] == nil || delta.After.Entities["sites"]["deleted"] != nil {
		t.Fatal("delete audit did not preserve before-only row")
	}
	if cloneMap(nil) != nil {
		t.Fatal("nil map clone should remain nil")
	}
}

func TestUnitOfWorkKeepsFirstBeforeAndLatestAfter(t *testing.T) {
	work := NewUnitOfWork()
	work.RecordAudit(map[string]any{"id": "a1"}, "clone_fish", "fish-1", map[string]any{"id": "fish-1", "status": "ALIVE"}, map[string]any{"id": "fish-1", "status": "DEAD"})
	work.RecordAudit(map[string]any{"id": "a2"}, "clone_fish", "fish-1", map[string]any{"id": "fish-1", "status": "DEAD"}, map[string]any{"id": "fish-1", "status": "FROZEN"})
	delta := work.Delta()
	if delta.Before.Entities["fish"]["fish-1"]["status"] != "ALIVE" {
		t.Fatalf("before status = %#v, want first value", delta.Before.Entities["fish"]["fish-1"])
	}
	if delta.After.Entities["fish"]["fish-1"]["status"] != "FROZEN" {
		t.Fatalf("after status = %#v, want latest value", delta.After.Entities["fish"]["fish-1"])
	}
}

type fakePersistence struct {
	reserved       store.Mutation
	waitResult     store.Mutation
	created        bool
	reserveErr     error
	waitErr        error
	commitErr      error
	abortErr       error
	renewErr       error
	waitCalls      int
	commitCalls    int
	abortCalls     int
	committedDelta *store.Delta
	renewed        chan struct{}
}

func (f *fakePersistence) Reserve(context.Context, store.Mutation) (store.Mutation, bool, error) {
	return f.reserved, f.created, f.reserveErr
}

func (f *fakePersistence) WaitForCompletion(context.Context, store.Mutation) (store.Mutation, error) {
	f.waitCalls++
	if f.waitResult.Status != 0 {
		return f.waitResult, f.waitErr
	}
	return f.reserved, f.waitErr
}

func (f *fakePersistence) Abort(context.Context, store.Mutation) error {
	f.abortCalls++
	return f.abortErr
}

func (f *fakePersistence) Renew(context.Context, store.Mutation) error {
	if f.renewed != nil {
		select {
		case f.renewed <- struct{}{}:
		default:
		}
	}
	return f.renewErr
}

func (f *fakePersistence) CommitDelta(_ context.Context, delta *store.Delta, _ *store.Mutation) error {
	f.commitCalls++
	f.committedDelta = delta
	return f.commitErr
}

func TestAcquireReturnsOwnerWithoutWaiting(t *testing.T) {
	fake := &fakePersistence{reserved: store.Mutation{Status: 102}, created: true}
	request := store.Mutation{Scope: "scope", Key: "key", RequestHash: "hash"}
	got, owner, err := Acquire(context.Background(), fake, request)
	if err != nil || !owner || got.Status != 102 || fake.waitCalls != 0 {
		t.Fatalf("acquire = %#v, owner=%v, err=%v, waits=%d", got, owner, err, fake.waitCalls)
	}
}

func TestAcquireReplaysCompletedReservation(t *testing.T) {
	fake := &fakePersistence{reserved: store.Mutation{Status: 200, Body: []byte(`{"id":"winner"}`)}}
	got, owner, err := Acquire(context.Background(), fake, store.Mutation{Scope: "scope", Key: "key", RequestHash: "hash"})
	if err != nil || owner || got.Status != 200 || fake.waitCalls != 0 {
		t.Fatalf("completed acquire = %#v, owner=%v, err=%v, waits=%d", got, owner, err, fake.waitCalls)
	}
}

func TestReserveWrapperAndAcquireErrors(t *testing.T) {
	fake := &fakePersistence{reserveErr: errors.New("reserve failed")}
	if _, _, err := Reserve(context.Background(), fake, store.Mutation{}); !errors.Is(err, fake.reserveErr) {
		t.Fatalf("reserve error = %v", err)
	}
	waitError := errors.New("wait failed")
	fake = &fakePersistence{reserved: store.Mutation{Status: 102}, waitErr: waitError}
	if _, _, err := Acquire(context.Background(), fake, store.Mutation{}); !errors.Is(err, waitError) {
		t.Fatalf("wait error = %v", err)
	}
	if err := Abort(context.Background(), nil, store.Mutation{}); err == nil {
		t.Fatal("nil abort persistence must fail")
	}
	fake.abortErr = errors.New("abort failed")
	if err := Abort(context.Background(), fake, store.Mutation{}); !errors.Is(err, fake.abortErr) {
		t.Fatalf("abort error = %v", err)
	}
}

func TestAcquireWaitsForPendingReservationAndReplays(t *testing.T) {
	fake := &fakePersistence{reserved: store.Mutation{Status: 102}, waitResult: store.Mutation{Status: 200, Body: []byte(`{"id":"winner"}`)}}
	// The reservation is pending; the wait call returns the winner.
	fake.created = false
	got, owner, err := Acquire(context.Background(), fake, store.Mutation{Scope: "scope", Key: "key", RequestHash: "hash"})
	if err != nil || owner || got.Status != 200 || fake.waitCalls != 1 {
		t.Fatalf("pending acquire = %#v, owner=%v, err=%v, waits=%d", got, owner, err, fake.waitCalls)
	}
}

func TestMutationCommitAndAbortDelegateTheUnitOfWork(t *testing.T) {
	fake := &fakePersistence{}
	work := NewUnitOfWork()
	mutation := &Mutation{Request: store.Mutation{Scope: "scope", Key: "key"}, Work: work}
	if err := Commit(context.Background(), fake, mutation); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if fake.commitCalls != 1 || fake.committedDelta != work.Delta() {
		t.Fatalf("commit did not receive the request delta: calls=%d", fake.commitCalls)
	}
	if err := Abort(context.Background(), fake, mutation.Request); err != nil {
		t.Fatalf("abort: %v", err)
	}
	if fake.abortCalls != 1 {
		t.Fatalf("abort calls = %d", fake.abortCalls)
	}
	fake.commitErr = errors.New("commit failed")
	if err := Commit(context.Background(), fake, mutation); !errors.Is(err, fake.commitErr) {
		t.Fatalf("commit error = %v", err)
	}
}

func TestMutationRejectsIncompleteCommit(t *testing.T) {
	if err := Commit(context.Background(), &fakePersistence{}, nil); err == nil {
		t.Fatal("nil mutation must fail")
	}
	if err := Commit(context.Background(), &fakePersistence{}, &Mutation{}); err == nil {
		t.Fatal("missing work must fail")
	}
	if _, _, err := Acquire(context.Background(), nil, store.Mutation{}); err == nil {
		t.Fatal("nil persistence must fail")
	}
}

func TestStartLeaseHeartbeatRenewsAndStops(t *testing.T) {
	fake := &fakePersistence{renewed: make(chan struct{}, 1)}
	stop := startLeaseHeartbeat(context.Background(), fake, store.Mutation{LeaseToken: "lease-token"}, time.Millisecond)
	select {
	case <-fake.renewed:
	case <-time.After(250 * time.Millisecond):
		stop()
		t.Fatal("lease heartbeat did not renew")
	}
	stop()
}

func TestStartLeaseHeartbeatNoopsWithoutLease(t *testing.T) {
	stop := StartLeaseHeartbeat(context.Background(), &fakePersistence{}, store.Mutation{})
	stop()
}

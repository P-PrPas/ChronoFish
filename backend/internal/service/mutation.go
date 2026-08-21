// Package service contains the request-scoped mutation boundary. HTTP is
// responsible for decoding and encoding only; this module owns reservation,
// replay, and the atomic canonical/audit/idempotency commit.
package service

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/P-PrPas/ChronoFish/backend/internal/store"
)

type Persistence interface {
	Reserve(context.Context, store.Mutation) (store.Mutation, bool, error)
	WaitForCompletion(context.Context, store.Mutation) (store.Mutation, error)
	Renew(context.Context, store.Mutation) error
	Abort(context.Context, store.Mutation) error
	CommitDelta(context.Context, *store.Delta, *store.Mutation) error
}

// StartLeaseHeartbeat keeps a legitimate long-running request fenced to its
// owner. The returned stop function is idempotent and must be called after
// the use case has produced its response.
func StartLeaseHeartbeat(ctx context.Context, persistence Persistence, mutation store.Mutation) func() {
	return startLeaseHeartbeat(ctx, persistence, mutation, 10*time.Second)
}

func startLeaseHeartbeat(ctx context.Context, persistence Persistence, mutation store.Mutation, interval time.Duration) func() {
	if persistence == nil || mutation.LeaseToken == "" {
		return func() {}
	}
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		defer close(done)
		for {
			select {
			case <-ticker.C:
				_ = persistence.Renew(ctx, mutation)
			case <-stop:
				return
			case <-ctx.Done():
				return
			}
		}
	}()
	return func() {
		select {
		case <-stop:
		default:
			close(stop)
		}
		<-done
	}
}

type Mutation struct {
	Request store.Mutation
	Work    *UnitOfWork
}

// UnitOfWork is the typed request-scoped write set. HTTP handlers may record
// the rows they changed, but persistence owns how that set becomes one SQL
// transaction. It deliberately has no whole-application state or repository
// interface, so a write cannot accidentally persist unrelated rows.
type UnitOfWork struct{ delta store.Delta }

func NewUnitOfWork() *UnitOfWork { return &UnitOfWork{delta: store.Delta{}} }

func (u *UnitOfWork) Delta() *store.Delta { return &u.delta }

func (u *UnitOfWork) RecordAudit(entry map[string]any, table, id string, old, next map[string]any) {
	if u == nil {
		return
	}
	u.delta.Audits = append(u.delta.Audits, cloneMap(entry))
	resource, kind := target(table)
	if kind == "observation" {
		if u.delta.Before.Observations == nil {
			u.delta.Before.Observations = map[string]map[string]any{}
		}
		if u.delta.After.Observations == nil {
			u.delta.After.Observations = map[string]map[string]any{}
		}
		if old != nil && u.delta.Before.Observations[id] == nil {
			u.delta.Before.Observations[id] = cloneMap(old)
		}
		if next != nil {
			u.delta.After.Observations[id] = cloneMap(next)
		}
		return
	}
	if kind == "fishObservation" {
		if u.delta.Before.FishObservations == nil {
			u.delta.Before.FishObservations = map[string]map[string]any{}
		}
		if u.delta.After.FishObservations == nil {
			u.delta.After.FishObservations = map[string]map[string]any{}
		}
		if old != nil && u.delta.Before.FishObservations[id] == nil {
			u.delta.Before.FishObservations[id] = cloneMap(old)
		}
		if next != nil {
			u.delta.After.FishObservations[id] = cloneMap(next)
		}
		return
	}
	if resource == "" {
		return
	}
	if u.delta.Before.Entities == nil {
		u.delta.Before.Entities = map[string]map[string]map[string]any{}
	}
	if u.delta.After.Entities == nil {
		u.delta.After.Entities = map[string]map[string]map[string]any{}
	}
	if u.delta.Before.Entities[resource] == nil {
		u.delta.Before.Entities[resource] = map[string]map[string]any{}
	}
	if u.delta.After.Entities[resource] == nil {
		u.delta.After.Entities[resource] = map[string]map[string]any{}
	}
	if old != nil && u.delta.Before.Entities[resource][id] == nil {
		u.delta.Before.Entities[resource][id] = cloneMap(old)
	}
	if next != nil {
		u.delta.After.Entities[resource][id] = cloneMap(next)
	}
}

func cloneMap(input map[string]any) map[string]any {
	if input == nil {
		return nil
	}
	data, _ := json.Marshal(input)
	var output map[string]any
	_ = json.Unmarshal(data, &output)
	return output
}

func target(table string) (string, string) {
	if table == "embryo_observation" {
		return "", "observation"
	}
	if table == "fish_observation" {
		return "", "fishObservation"
	}
	return map[string]string{
		"site": "sites", "sites": "sites", "operator": "operators", "operators": "operators",
		"donor_cell_line": "donor-cell-lines", "donor-cell-lines": "donor-cell-lines",
		"recipient_egg_lot": "recipient-egg-lots", "recipient-egg-lots": "recipient-egg-lots",
		"csof_lot": "csof-lots", "csof-lots": "csof-lots", "treatment_group": "treatment-groups", "treatment-groups": "treatment-groups",
		"fish_box": "fish-boxes", "fish-boxes": "fish-boxes", "protocol": "protocols", "protocols": "protocols",
		"stage_timing_profile": "timing-profiles", "timing-profiles": "timing-profiles", "experiment_batch": "batches", "batches": "batches",
		"injection_lot": "injection-lots", "injection-lots": "injection-lots", "embryo": "embryos", "embryos": "embryos",
		"clone_fish": "fish", "fish": "fish", "specimen": "specimens", "specimens": "specimens",
		"control_arm_count": "control-arm-counts", "control-arm-counts": "control-arm-counts",
	}[table], "entity"
}

func Reserve(ctx context.Context, persistence Persistence, request store.Mutation) (store.Mutation, bool, error) {
	return Acquire(ctx, persistence, request)
}

// Acquire elects the request owner in the durable idempotency table. A
// replay waits for the owner, while an expired reservation may be taken over
// by the repository's lease policy. Only the owner is allowed to run a use
// case and complete its write set.
func Acquire(ctx context.Context, persistence Persistence, request store.Mutation) (store.Mutation, bool, error) {
	if persistence == nil {
		return store.Mutation{}, false, errors.New("mutation persistence is unavailable")
	}
	reserved, created, err := persistence.Reserve(ctx, request)
	if err != nil || created || reserved.Status != 102 {
		return reserved, created, err
	}
	waitContext, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	reserved, err = persistence.WaitForCompletion(waitContext, request)
	if err != nil {
		return store.Mutation{}, false, err
	}
	return reserved, reserved.LeaseOwner, nil
}

func Commit(ctx context.Context, persistence Persistence, mutation *Mutation) error {
	if persistence == nil || mutation == nil || mutation.Work == nil {
		return errors.New("incomplete mutation unit of work")
	}
	return persistence.CommitDelta(ctx, mutation.Work.Delta(), &mutation.Request)
}

func Abort(ctx context.Context, persistence Persistence, request store.Mutation) error {
	if persistence == nil {
		return errors.New("mutation persistence is unavailable")
	}
	return persistence.Abort(ctx, request)
}

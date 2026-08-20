package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestStageSurvivalUsesSparseImpliedStatesAndDueRiskSet(t *testing.T) {
	s := newAPIServer()
	now := time.Now().UTC()
	s.entities["batches"]["batch-profile"] = map[string]any{"id": "batch-profile", "timingProfileId": "profile-custom"}
	s.entities["timing-profiles"]["profile-custom"] = map[string]any{"id": "profile-custom", "entries": []any{
		map[string]any{"stageCode": stageCode(5), "expectedHpa": 42.0},
		map[string]any{"stageCode": stageCode(26), "expectedHpa": 240.0},
	}}
	s.entities["injection-lots"]["lot-old"] = map[string]any{"id": "lot-old", "batchId": "batch-profile", "activatedAt": now.Add(-200 * time.Hour).Format(time.RFC3339)}
	s.entities["injection-lots"]["lot-new"] = map[string]any{"id": "lot-new", "activatedAt": now.Add(-time.Hour).Format(time.RFC3339)}
	for _, embryo := range []map[string]any{
		{"id": "e-alive", "injectionLotId": "lot-old"},
		{"id": "e-dead", "injectionLotId": "lot-old", "exitStageCode": stageCode(3), "exitReason": "DEAD"},
		{"id": "e-unobserved", "injectionLotId": "lot-old"},
		{"id": "e-not-due", "injectionLotId": "lot-new"},
	} {
		s.entities["embryos"][stringValue(embryo["id"])] = embryo
	}
	s.observations["o-alive"] = map[string]any{"id": "o-alive", "embryoId": "e-alive", "stageCode": stageCode(5), "outcome": "ALIVE"}
	s.observations["o-dead"] = map[string]any{"id": "o-dead", "embryoId": "e-dead", "stageCode": stageCode(3), "outcome": "DEAD"}

	items := s.survivalLocked([]map[string]any{s.entities["embryos"]["e-alive"], s.entities["embryos"]["e-dead"], s.entities["embryos"]["e-unobserved"], s.entities["embryos"]["e-not-due"]})
	byStage := func(stage int) map[string]any { return items[stage-1] }
	if got := intValue(byStage(1)["riskSet"]); got != 4 {
		t.Fatalf("stage 1 risk set = %d, want 4", got)
	}
	if got := intValue(byStage(1)["alive"]); got != 2 {
		t.Fatalf("stage 1 alive = %d, want 2 (unobserved is blank)", got)
	}
	if got := intValue(byStage(3)["alive"]); got != 1 {
		t.Fatalf("stage 3 alive = %d, want 1", got)
	}
	if got := intValue(byStage(3)["nDead"]); got != 1 {
		t.Fatalf("stage 3 nDead = %d, want 1", got)
	}
	if got := floatValue(byStage(3)["surv"]); got != 0.5 {
		t.Fatalf("stage 3 survival = %v, want 0.5", got)
	}
	if got := intValue(byStage(6)["alive"]); got != 0 {
		t.Fatalf("stage 6 alive = %d, want 0 after latest ALIVE at stage 5", got)
	}
	if got := intValue(byStage(26)["riskSet"]); got != 0 {
		t.Fatalf("stage 26 risk set = %d, want 0 because custom profile makes it not due", got)
	}
}

func TestDeleteObservationRequiresReason(t *testing.T) {
	s := newAPIServer()
	s.observations["observation-1"] = map[string]any{"id": "observation-1", "embryoId": "embryo-1", "outcome": "ALIVE"}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodDelete, "/api/v1/observations/embryo/observation-1", nil)
	if !s.updateOrDeleteObservation(recorder, request, "observation-1", false) {
		t.Fatal("delete was not handled")
	}
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusUnprocessableEntity)
	}
	if s.observations["observation-1"]["deletedAt"] != nil {
		t.Fatal("observation was deleted without a reason")
	}
}

func TestCorrectionExpectedSnapshotUsesPinnedTimingProfile(t *testing.T) {
	s := newAPIServer()
	s.entities["batches"]["batch-1"] = map[string]any{"id": "batch-1", "timingProfileId": "profile-1"}
	s.entities["injection-lots"]["lot-1"] = map[string]any{"id": "lot-1", "batchId": "batch-1"}
	s.entities["embryos"]["embryo-1"] = map[string]any{"id": "embryo-1", "injectionLotId": "lot-1"}
	s.entities["timing-profiles"]["profile-1"] = map[string]any{"id": "profile-1", "entries": []any{map[string]any{"stageCode": stageCode(5), "expectedHpa": 42.0}}}
	if got := s.expectedHPAForEmbryoLocked(map[string]any{"embryoId": "embryo-1", "stageCode": stageCode(5), "observedAt": "2026-08-20T00:00:00Z"}); got != 42 {
		t.Fatalf("expected profile HPA = %v, want 42", got)
	}
}

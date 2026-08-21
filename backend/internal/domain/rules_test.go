package domain

import (
	"testing"
	"time"
)

func TestStageNumberAndCalendarAge(t *testing.T) {
	location := time.FixedZone("Asia/Bangkok", 7*60*60)
	if got := StageNumber("stage_09_256C"); got != 9 {
		t.Fatalf("stage number = %d", got)
	}
	if got := AgeDaysOn("2026-08-20", "2026-08-25", location); got != 5 {
		t.Fatalf("age = %d, want 5", got)
	}
	if got := StageNumber("not-a-stage"); got != 0 {
		t.Fatalf("invalid stage number = %d, want 0", got)
	}
}

func TestProtocolStageAndTimingDefaults(t *testing.T) {
	if got := StageCode(1); got != "stage_01_1C" {
		t.Fatalf("stage code = %q", got)
	}
	if got := StageCode(36); got != "stage_36_15D" {
		t.Fatalf("last stage code = %q", got)
	}
	if got := StageLabel(27); got != "Day 6" {
		t.Fatalf("day label = %q", got)
	}
	if got := DefaultExpectedHPA("stage_26_1D"); got != 120 {
		t.Fatalf("default expected HPA = %v", got)
	}
	if got := DefaultExpectedHPA("not-a-stage"); got != 0 {
		t.Fatalf("invalid expected HPA = %v", got)
	}
}

func TestTimingAndDeviationBoundaries(t *testing.T) {
	if got := Round4(1.23456); got != 1.2346 {
		t.Fatalf("round4 = %v", got)
	}
	observed := time.Date(2026, 8, 21, 10, 0, 0, 0, time.UTC)
	if IsBackdated(observed, observed.Add(15*time.Minute)) {
		t.Fatal("exactly 15 minutes must not be backdated")
	}
	if !IsBackdated(observed, observed.Add(15*time.Minute+time.Nanosecond)) {
		t.Fatal("more than 15 minutes must be backdated")
	}
	if got := DeviationLabel(0); got != "ตรงกับสากล" {
		t.Fatalf("zero deviation label = %q", got)
	}
	if got := DeviationLabel(1.5); got != "ช้ากว่าสากล 1 ชม. 30 นาที" {
		t.Fatalf("positive deviation label = %q", got)
	}
	if got := DeviationLabel(-0.25); got != "เร็วกว่าสากล 15 นาที" {
		t.Fatalf("negative deviation label = %q", got)
	}
}

func TestPromotionDecision(t *testing.T) {
	if !PromotionEligible(false, true, 5, 5) {
		t.Fatal("eligible embryo rejected")
	}
	if PromotionEligible(true, true, 6, 5) || PromotionEligible(false, false, 6, 5) {
		t.Fatal("ineligible embryo accepted")
	}
}

func TestPromotionElapsedBoundaryIsStrict(t *testing.T) {
	activated := time.Date(2026, 8, 20, 10, 0, 0, 0, time.UTC)
	if PromotionEligibleAt(false, true, activated, activated.Add(120*time.Hour), 5) {
		t.Fatal("exactly five days must remain pending")
	}
	if !PromotionEligibleAt(false, true, activated, activated.Add(120*time.Hour+time.Nanosecond), 5) {
		t.Fatal("promotion should become eligible after five full days")
	}
}

func TestDomainRulesRejectMalformedAndUnsupportedValues(t *testing.T) {
	location := time.FixedZone("Asia/Bangkok", 7*60*60)
	tests := []struct {
		name string
		got  bool
	}{
		{"stage without number", StageNumber("stage_x_256C") != 0},
		{"stage zero", StageNumber("stage_00_256C") != 0},
		{"stage negative", StageNumber("stage_-1_256C") != 0},
		{"invalid dob", AgeDaysOn("not-a-date", "2026-08-25", location) != 0},
		{"invalid observed date", AgeDaysOn("2026-08-20", "not-a-date", location) != 0},
		{"fish unknown", FishOutcomeValid("UNKNOWN")},
		{"fish empty", FishOutcomeValid("")},
		{"condition unknown", ConditionValid("UNKNOWN")},
		{"condition empty", ConditionValid("")},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.got {
				t.Fatalf("invalid input unexpectedly accepted: %s", test.name)
			}
		})
	}
}

func TestDomainRulesValidOutcomesConditionsAndAges(t *testing.T) {
	for _, outcome := range []string{"ALIVE", "DEAD", "FROZEN", "DISCARDED", "NOT_OBSERVED"} {
		if !FishOutcomeValid(outcome) {
			t.Fatalf("outcome %q rejected", outcome)
		}
	}
	for _, condition := range []string{"NORMAL", "ABNORMAL", "UNDETERMINED"} {
		if !ConditionValid(condition) {
			t.Fatalf("condition %q rejected", condition)
		}
	}
	location := time.FixedZone("Asia/Bangkok", 7*60*60)
	if got := AgeDaysOn("2026-08-25", "2026-08-20", location); got != -5 {
		t.Fatalf("negative age = %d, want -5", got)
	}
	if got := AgeDaysOn("2026-08-20", "2026-08-20", location); got != 0 {
		t.Fatalf("same-day age = %d, want 0", got)
	}
	if got := StageNumber("stage_10_1K"); got != 10 {
		t.Fatalf("stage 10 = %d", got)
	}
}

func TestPromotionRulesRejectInvalidThresholdAndExit(t *testing.T) {
	now := time.Date(2026, 8, 21, 0, 0, 0, 0, time.UTC)
	if PromotionEligibleAt(false, true, now.Add(-24*time.Hour), now, 0) {
		t.Fatal("zero threshold must be rejected")
	}
	if PromotionEligibleAt(true, true, now.Add(-200*time.Hour), now, 5) {
		t.Fatal("exited embryo must be rejected")
	}
	if PromotionEligibleAt(false, false, now.Add(-200*time.Hour), now, 5) {
		t.Fatal("non-alive embryo must be rejected")
	}
	if PromotionEligible(false, true, 4, 5) || PromotionEligible(true, true, 5, 5) {
		t.Fatal("calendar promotion accepted an ineligible embryo")
	}
}

func TestENUWindowWarnsAfterActivationAndRejectsFinishBeforeStart(t *testing.T) {
	activated := time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC)
	warning, err := ENUWindow(activated, time.Time{}, activated.Add(time.Second))
	if err != nil || warning == "" {
		t.Fatalf("warning=%q err=%v, want AC-307 warning", warning, err)
	}
	if warning, err := ENUWindow(activated, time.Time{}, activated); err != nil || warning != "" {
		t.Fatalf("equal finish = warning %q err %v, want accepted without warning", warning, err)
	}
	if _, err := ENUWindow(activated, activated.Add(time.Hour), activated); err == nil {
		t.Fatal("finish before ENU start unexpectedly accepted")
	}
}

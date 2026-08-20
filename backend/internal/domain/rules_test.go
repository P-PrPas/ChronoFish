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

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
}

func TestPromotionDecision(t *testing.T) {
	if !PromotionEligible(false, true, 5, 5) {
		t.Fatal("eligible embryo rejected")
	}
	if PromotionEligible(true, true, 6, 5) || PromotionEligible(false, false, 6, 5) {
		t.Fatal("ineligible embryo accepted")
	}
}

package domain

import (
	"errors"
	"strconv"
	"strings"
	"time"
)

var ErrENUFinishBeforeStart = errors.New("enu finish must be after enu start")

// ENUWindow validates the chronological relation that is safe to enforce at
// entry time. Real lab records may finish after activation (AC-307), so that
// case is a warning, not a rejected write.
func ENUWindow(activated, start, finish time.Time) (warning string, err error) {
	if !start.IsZero() && !finish.IsZero() && !finish.After(start) {
		return "", ErrENUFinishBeforeStart
	}
	if !finish.IsZero() && finish.After(activated) {
		return "enuFinishAt is later than activatedAt; verify the ENU timing before analysis", nil
	}
	return "", nil
}

func StageNumber(code string) int {
	suffix := strings.TrimPrefix(code, "stage_")
	if suffix == code {
		return 0
	}
	part := strings.TrimLeft(strings.SplitN(suffix, "_", 2)[0], "0")
	if part == "" {
		return 0
	}
	number, err := strconv.Atoi(part)
	if err != nil || number < 1 {
		return 0
	}
	return number
}

func AgeDaysOn(dob, observed string, location *time.Location) int {
	start, startErr := time.ParseInLocation("2006-01-02", dob, location)
	end, endErr := time.ParseInLocation("2006-01-02", observed, location)
	if startErr != nil || endErr != nil {
		return 0
	}
	return int(end.Sub(start).Hours() / 24)
}

func PromotionEligible(hasExit, latestAlive bool, ageDays, threshold int) bool {
	return !hasExit && latestAlive && ageDays >= threshold
}

// PromotionEligibleAt uses the protocol's elapsed-time boundary. An embryo
// becomes eligible strictly after the threshold instant, so exactly 120h is
// still pending for the default five-day threshold.
func PromotionEligibleAt(hasExit, latestAlive bool, activatedAt, now time.Time, thresholdDays int) bool {
	if hasExit || !latestAlive || thresholdDays < 1 {
		return false
	}
	return now.After(activatedAt.Add(time.Duration(thresholdDays) * 24 * time.Hour))
}

func FishOutcomeValid(value string) bool {
	return value == "ALIVE" || value == "DEAD" || value == "FROZEN" || value == "DISCARDED" || value == "NOT_OBSERVED"
}

func ConditionValid(value string) bool {
	return value == "NORMAL" || value == "ABNORMAL" || value == "UNDETERMINED"
}

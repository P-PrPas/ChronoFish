package domain

import (
	"strconv"
	"strings"
	"time"
)

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

func FishOutcomeValid(value string) bool {
	return value == "ALIVE" || value == "DEAD" || value == "FROZEN" || value == "DISCARDED"
}

func ConditionValid(value string) bool {
	return value == "NORMAL" || value == "ABNORMAL" || value == "UNDETERMINED"
}

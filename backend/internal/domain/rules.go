package domain

import (
	"errors"
	"fmt"
	"math"
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

func StageCode(order int) string {
	codes := []string{"1C", "2C", "4C", "8C", "16C", "32C", "64C", "128C", "256C", "512C", "1K", "HI", "OB", "SPH", "DO", "30EPI", "50EPI", "GR", "SH", "75EPI", "90EPI", "1D", "2D", "3D", "4D", "5D", "6D", "7D", "8D", "9D", "10D", "11D", "12D", "13D", "14D", "15D"}
	if order < 1 || order > len(codes) {
		return fmt.Sprintf("stage_%02d", order)
	}
	return fmt.Sprintf("stage_%02d_%s", order, codes[order-1])
}

func StageLabel(order int) string {
	if order <= 26 {
		return fmt.Sprintf("Stage %d", order)
	}
	return fmt.Sprintf("Day %d", order-21)
}

func DefaultExpectedHPA(code string) float64 {
	values := []float64{0, .75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.33, 3.66, 4, 4.33, 4.66, 5.25, 5.66, 6, 8, 9, 24, 48, 72, 96, 120, 144, 168, 192, 216, 240, 264, 288, 312, 336, 360}
	order := StageNumber(code)
	if order < 1 || order > len(values) {
		return 0
	}
	return values[order-1]
}

func Round4(value float64) float64 { return math.Round(value*10000) / 10000 }

func IsBackdated(observed, received time.Time) bool {
	return math.Abs(received.Sub(observed).Minutes()) > 15
}

func DeviationLabel(value float64) string {
	if math.Abs(value) < 1.0/60.0 {
		return "ตรงกับสากล"
	}
	minutes := int(math.Round(math.Abs(value) * 60))
	direction := "ช้ากว่าสากล"
	if value < 0 {
		direction = "เร็วกว่าสากล"
	}
	if minutes < 60 {
		return fmt.Sprintf("%s %d นาที", direction, minutes)
	}
	return fmt.Sprintf("%s %d ชม. %d นาที", direction, minutes/60, minutes%60)
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

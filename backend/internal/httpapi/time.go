package httpapi

import (
	"errors"
	"strings"
	"time"
)

var bangkokTZ = time.FixedZone("Asia/Bangkok", 7*60*60)

// parseBangkokInstant is the API boundary for datetime-local values. Stored
// values always carry an offset; a bare local value is accepted only for
// migration compatibility and is interpreted as Bangkok time.
func parseBangkokInstant(value string) (time.Time, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return time.Time{}, errors.New("empty datetime")
	}
	if parsed, err := time.Parse(time.RFC3339, trimmed); err == nil {
		return parsed, nil
	}
	if parsed, err := time.ParseInLocation("2006-01-02T15:04", trimmed, bangkokTZ); err == nil {
		return parsed, nil
	}
	return time.Time{}, errors.New("invalid datetime")
}

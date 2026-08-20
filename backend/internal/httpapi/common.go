package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/P-PrPas/ChronoFish/backend/internal/domain"
)

func (s *apiServer) auditLog(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodGet {
		return false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	writeJSON(w, 200, map[string]any{"items": append([]map[string]any(nil), s.audits...)})
	return true
}

func (s *apiServer) auditLocked(r *http.Request, action, table, id string, old, newValue map[string]any) {
	if old != nil {
		old = cloneMap(old)
	}
	if newValue != nil {
		newValue = cloneMap(newValue)
	}
	entry := map[string]any{"id": uuidV7(), "tableName": table, "recordId": id, "action": action, "oldValues": old, "newValues": newValue, "operatorId": r.Header.Get("X-Operator-Id"), "deviceId": r.Header.Get("X-Device-Id"), "occurredAt": time.Now().UTC().Format(time.RFC3339)}
	s.audits = append(s.audits, entry)
}

func idempotencyKey(r *http.Request, input map[string]any) string {
	key := r.Header.Get("X-Idempotency-Key")
	if key == "" {
		key = stringValue(input["clientUuid"])
	}
	return key
}
func readMap(r *http.Request) (map[string]any, error) {
	var input map[string]any
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		return nil, err
	}
	return input, nil
}
func normalizeMap(input map[string]any) {
	for key, value := range input {
		switch v := value.(type) {
		case string:
			input[key] = strings.TrimSpace(v)
		case map[string]any:
			normalizeMap(v)
		case []any:
			for _, item := range v {
				if child, ok := item.(map[string]any); ok {
					normalizeMap(child)
				}
			}
		}
	}
}
func stringValue(value any) string {
	if value == nil {
		return ""
	}
	return fmt.Sprint(value)
}
func intValue(value any) int {
	switch v := value.(type) {
	case float64:
		return int(v)
	case int:
		return v
	case string:
		n, _ := strconv.Atoi(v)
		return n
	}
	return 0
}
func cloneMap(input map[string]any) map[string]any {
	output := make(map[string]any, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}
func stageNumber(code string) int {
	return domain.StageNumber(code)
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	body, err := json.Marshal(value)
	if err != nil {
		writeAPIError(w, 500, "internal_error", "à¹„à¸¡à¹ˆà¸ªà¸²à¸¡à¸²à¸£à¸–à¸ªà¸£à¹‰à¸²à¸‡à¸„à¸³à¸•à¸­à¸šà¹„à¸”à¹‰")
		return
	}
	writeRaw(w, status, body)
}
func returnJSON(w http.ResponseWriter, value any) { writeJSON(w, 200, value) }
func writeRaw(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
func writeBytes(w http.ResponseWriter, status int, contentType string, body []byte) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", `attachment; filename="chronofish-export.xlsx"`)
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
func writeAPIError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, errorResponse{Error: errorBody{Code: code, Message: message}})
}

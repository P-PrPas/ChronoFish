package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/P-PrPas/ChronoFish/backend/internal/domain"
	"github.com/P-PrPas/ChronoFish/backend/internal/service"
	storepkg "github.com/P-PrPas/ChronoFish/backend/internal/store"
)

type mutationDeltaContextKey struct{}
type mutationCacheContextKey struct{}

func mutationWorkFromRequest(r *http.Request) *service.UnitOfWork {
	if work, ok := r.Context().Value(mutationDeltaContextKey{}).(*service.UnitOfWork); ok {
		return work
	}
	return nil
}

func mutationCacheJournalFromRequest(r *http.Request) *mutationCacheJournal {
	if journal, ok := r.Context().Value(mutationCacheContextKey{}).(*mutationCacheJournal); ok {
		return journal
	}
	return nil
}

func (s *apiServer) mutationCacheGet(r *http.Request, key string) ([]byte, bool) {
	if journal := mutationCacheJournalFromRequest(r); journal != nil {
		if body, ok := journal.pending[key]; ok {
			return append([]byte(nil), body...), true
		}
	}
	body, ok := s.idempotency[key]
	return append([]byte(nil), body...), ok
}

// setMutationCache records only the feature-idempotency key touched by this
// request. It avoids taking a whole-process cache snapshot and lets rollback
// preserve unrelated concurrent writes.
func (s *apiServer) setMutationCache(r *http.Request, key string, body []byte) {
	if journal := mutationCacheJournalFromRequest(r); journal != nil {
		journal.pending[key] = append(json.RawMessage(nil), body...)
		return
	}
	s.idempotency[key] = append(json.RawMessage(nil), body...)
}

func (s *apiServer) auditLog(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodGet {
		return false
	}
	query := r.URL.Query()
	from := parseAuditTime(query.Get("from"))
	to := parseAuditTime(query.Get("to"))
	limit := 100
	if value, err := strconv.Atoi(query.Get("limit")); err == nil && value > 0 {
		if value > 500 {
			value = 500
		}
		limit = value
	}
	offset := 0
	if value, err := strconv.Atoi(query.Get("cursor")); err == nil && value > 0 {
		offset = value
	}
	if reader, ok := s.store.(auditReader); ok {
		items, more, err := reader.QueryAudits(r.Context(), storepkg.AuditQuery{Table: query.Get("table"), RecordID: query.Get("recordId"), OperatorID: query.Get("operatorId"), From: from, To: to, Limit: limit, Offset: offset})
		if err != nil {
			writeAPIError(w, http.StatusServiceUnavailable, "persistence_unavailable", "audit history is temporarily unavailable")
			return true
		}
		var nextCursor any
		if more {
			nextCursor = strconv.Itoa(offset + len(items))
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": items, "nextCursor": nextCursor})
		return true
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	filtered := make([]map[string]any, 0, len(s.audits))
	for index := len(s.audits) - 1; index >= 0; index-- {
		item := s.audits[index]
		if value := query.Get("table"); value != "" && stringValue(item["tableName"]) != value {
			continue
		}
		if value := query.Get("recordId"); value != "" && stringValue(item["recordId"]) != value {
			continue
		}
		if value := query.Get("operatorId"); value != "" && stringValue(item["operatorId"]) != value {
			continue
		}
		occurred := parseAuditTime(stringValue(item["occurredAt"]))
		if !from.IsZero() && (occurred.IsZero() || occurred.Before(from)) {
			continue
		}
		if !to.IsZero() && (occurred.IsZero() || occurred.After(to)) {
			continue
		}
		filtered = append(filtered, cloneMap(item))
	}
	if offset >= len(filtered) {
		writeJSON(w, 200, map[string]any{"items": []map[string]any{}, "nextCursor": nil})
		return true
	}
	end := offset + limit
	if end > len(filtered) {
		end = len(filtered)
	}
	items := filtered[offset:end]
	var nextCursor any
	if end < len(filtered) {
		nextCursor = strconv.Itoa(end)
	}
	writeJSON(w, 200, map[string]any{"items": items, "nextCursor": nextCursor})
	return true
}

func parseAuditTime(value string) time.Time {
	if value == "" {
		return time.Time{}
	}
	for _, layout := range []string{time.RFC3339, "2006-01-02T15:04", "2006-01-02"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed
		}
	}
	return time.Time{}
}

func (s *apiServer) auditLocked(r *http.Request, action, table, id string, old, newValue map[string]any) {
	if old != nil {
		old = cloneMap(old)
	}
	if newValue != nil {
		newValue = cloneMap(newValue)
	}
	entry := map[string]any{"id": uuidV7(), "tableName": table, "recordId": id, "action": action, "oldValues": old, "newValues": newValue, "operatorId": r.Header.Get("X-Operator-Id"), "deviceId": r.Header.Get("X-Device-Id"), "occurredAt": time.Now().UTC().Format(time.RFC3339)}
	if work := mutationWorkFromRequest(r); work != nil {
		work.RecordAudit(entry, table, id, old, newValue)
		return
	}
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

func stageDefinitionID(code string) string {
	order := stageNumber(code)
	if order < 1 || order > 36 {
		return ""
	}
	return fmt.Sprintf("01900001-0000-7000-8000-%012d", order)
}

func numberValue(value any) float64 {
	switch value := value.(type) {
	case float64:
		return value
	case float32:
		return float64(value)
	case int:
		return float64(value)
	case int64:
		return float64(value)
	case string:
		var result float64
		_, _ = fmt.Sscan(value, &result)
		return result
	default:
		return 0
	}
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	body, err := json.Marshal(value)
	if err != nil {
		writeAPIError(w, 500, "internal_error", "ไม่สามารถสร้างคำตอบได้")
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

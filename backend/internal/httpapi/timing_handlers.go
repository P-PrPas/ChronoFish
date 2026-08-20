package httpapi

import (
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"time"
)

func (s *apiServer) protocolStages(w http.ResponseWriter, r *http.Request, id string) bool {
	s.mu.RLock()
	p, ok := s.entities["protocols"][id]
	profile := s.currentTimingProfileLocked(id)
	s.mu.RUnlock()
	if !ok {
		writeAPIError(w, 404, "not_found", "ไม่พบ protocol")
		return true
	}
	_ = p
	if profile == nil {
		writeAPIError(w, 404, "not_found", "no current timing profile")
		return true
	}
	writeJSON(w, 200, map[string]any{"items": profile["entries"]})
	return true
}

func (s *apiServer) currentTiming(w http.ResponseWriter, r *http.Request) bool {
	protocolID := strings.TrimSpace(r.URL.Query().Get("protocolId"))
	if protocolID != "" && !isUUID(protocolID) {
		writeAPIError(w, 400, "invalid_query", "protocolId must be UUID")
		return true
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	profile := s.currentTimingProfileLocked(protocolID)
	if profile != nil {
		writeJSON(w, 200, cloneMap(profile))
		return true
	}
	writeAPIError(w, 404, "not_found", "ยังไม่มี timing profile")
	return true
}

// currentTimingProfileLocked is the single resolver for versioned timing
// profiles. An empty protocol is only accepted for backwards-compatible reads
// when exactly one current profile exists; writes always provide a protocol.
func (s *apiServer) currentTimingProfileLocked(protocolID string) map[string]any {
	var found map[string]any
	for _, profile := range s.entities["timing-profiles"] {
		if profile["isCurrent"] != true || (protocolID != "" && stringValue(profile["protocolId"]) != protocolID) {
			continue
		}
		if found != nil && protocolID == "" {
			return nil
		}
		found = profile
	}
	return found
}

func (s *apiServer) timingCSV(w http.ResponseWriter, r *http.Request) bool {
	if r.Method == http.MethodGet {
		protocolID := strings.TrimSpace(r.URL.Query().Get("protocolId"))
		if !isUUID(protocolID) {
			writeAPIError(w, http.StatusBadRequest, "invalid_query", "protocolId ต้องเป็น UUID")
			return true
		}
		s.mu.RLock()
		profile := s.currentTimingProfileLocked(protocolID)
		s.mu.RUnlock()
		if profile == nil {
			writeAPIError(w, http.StatusNotFound, "not_found", "ไม่พบ timing profile ของ protocol")
			return true
		}
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", "attachment; filename=timing-profile.csv")
		writer := csv.NewWriter(w)
		_ = writer.Write([]string{"stage_order", "stage_code", "label", "expected_hpa"})
		if entries, ok := profile["entries"].([]any); ok {
			for _, v := range entries {
				item, _ := v.(map[string]any)
				_ = writer.Write([]string{fmt.Sprint(item["stageOrder"]), stringValue(item["stageCode"]), stringValue(item["stageLabel"]), fmt.Sprint(item["expectedHpa"])})
			}
		}
		writer.Flush()
		return true
	}
	protocolID := strings.TrimSpace(r.URL.Query().Get("protocolId"))
	input, err := timingCSVInput(r.Body, protocolID)
	if err != nil {
		writeAPIError(w, 422, "validation_error", err.Error())
		return true
	}
	return s.createTiming(w, r, input)
}

func timingCSVInput(body io.Reader, protocolID string) (map[string]any, error) {
	reader := csv.NewReader(io.LimitReader(body, 2<<20))
	reader.FieldsPerRecord = -1
	header, err := reader.Read()
	if err != nil {
		return nil, errors.New("CSV ต้องมี header และอย่างน้อยหนึ่งแถว")
	}
	for i := range header {
		header[i] = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(header[i], "\ufeff")))
	}
	indexes := make(map[string]int, len(header))
	for i, field := range header {
		indexes[field] = i
	}
	for _, field := range []string{"stage_order", "stage_code", "label", "expected_hpa"} {
		if _, ok := indexes[field]; !ok {
			return nil, fmt.Errorf("CSV ขาดคอลัมน์ %s", field)
		}
	}
	entries := make([]any, 0, 36)
	seen := make(map[int]bool)
	for rowNo := 2; ; rowNo++ {
		record, readErr := reader.Read()
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return nil, fmt.Errorf("CSV แถว %d ไม่ถูกต้อง: %w", rowNo, readErr)
		}
		value := func(field string) string {
			index := indexes[field]
			if index >= len(record) {
				return ""
			}
			return strings.TrimSpace(record[index])
		}
		order, parseOrderErr := strconv.Atoi(value("stage_order"))
		hpa, parseHPAErr := strconv.ParseFloat(value("expected_hpa"), 64)
		if parseOrderErr != nil || order < 1 || order > 36 || parseHPAErr != nil || hpa < 0 || value("stage_code") == "" || value("label") == "" || seen[order] {
			return nil, fmt.Errorf("CSV แถว %d มี stage หรือ expected_hpa ไม่ถูกต้อง", rowNo)
		}
		seen[order] = true
		entries = append(entries, map[string]any{
			"stageOrder": order, "stageCode": value("stage_code"), "stageLabel": value("label"),
			"code": value("stage_code"), "label": value("label"), "expectedHpa": hpa,
		})
	}
	if len(entries) == 0 {
		return nil, errors.New("CSV ต้องมีข้อมูล timing อย่างน้อยหนึ่งแถว")
	}
	if !isUUID(protocolID) {
		return nil, errors.New("protocolId must be provided for CSV import")
	}
	return map[string]any{
		"protocolId": protocolID,
		"name":       "Imported timing profile", "entries": entries,
	}, nil
}

func (s *apiServer) createTiming(w http.ResponseWriter, r *http.Request, input map[string]any) bool {
	entries, ok := input["entries"].([]any)
	if !ok || len(entries) == 0 || strings.TrimSpace(stringValue(input["name"])) == "" {
		writeAPIError(w, 422, "validation_error", "ต้องระบุ entries ของ timing profile")
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	protocolID := stringValue(input["protocolId"])
	if !isUUID(protocolID) || s.entities["protocols"][protocolID] == nil {
		writeAPIError(w, 422, "validation_error", "protocolId ไม่ถูกต้องหรือไม่พบ protocol")
		return true
	}
	id := uuidV7()
	// Version numbers are scoped to a protocol. Start with the complete current
	// profile so partial CSV/API overrides cannot silently delete stages.
	var previous map[string]any
	version := 0
	for _, old := range s.entities["timing-profiles"] {
		if stringValue(old["protocolId"]) != protocolID {
			continue
		}
		if intValue(old["version"]) > version {
			version = intValue(old["version"])
		}
		if old["isCurrent"] == true {
			previous = old
		}
	}
	if previous == nil {
		writeAPIError(w, 422, "validation_error", "protocol has no current timing profile")
		return true
	}
	baseEntries := make(map[int]map[string]any)
	if oldEntries, ok := previous["entries"].([]any); ok {
		for _, raw := range oldEntries {
			if entry, ok := raw.(map[string]any); ok {
				baseEntries[intValue(entry["stageOrder"])] = cloneMap(entry)
			}
		}
	}
	for _, raw := range entries {
		entry, ok := raw.(map[string]any)
		if !ok {
			writeAPIError(w, 422, "validation_error", "timing entry ไม่ถูกต้อง")
			return true
		}
		stageCode := stringValue(entry["stageCode"])
		if stageCode == "" {
			stageCode = stringValue(entry["code"])
		}
		order := stageNumber(stageCode)
		if requestedOrder := intValue(entry["stageOrder"]); requestedOrder > 0 && requestedOrder != order {
			writeAPIError(w, 422, "validation_error", "stageOrder and stageCode must match")
			return true
		}
		if order < 1 || order > 36 || stageCode == "" {
			writeAPIError(w, 422, "validation_error", "stageOrder และ stageCode ไม่สอดคล้องกัน")
			return true
		}
		if _, ok := entry["expectedHpa"].(float64); !ok {
			if _, ok := entry["expectedHpa"].(int); !ok {
				writeAPIError(w, 422, "validation_error", "expectedHpa ต้องเป็นตัวเลข")
				return true
			}
		}
		if numberValue(entry["expectedHpa"]) < 0 {
			writeAPIError(w, 422, "validation_error", "expectedHpa ต้องไม่น้อยกว่า 0")
			return true
		}
		if stringValue(entry["id"]) == "" {
			entry["id"] = uuidV7()
		}
		entry["stageCode"], entry["stageOrder"] = stageCode, order
		if stringValue(entry["stageLabel"]) == "" {
			entry["stageLabel"] = entry["label"]
		}
		if stringValue(entry["stageLabel"]) == "" {
			entry["stageLabel"] = stageLabel(order)
		}
		entry["code"], entry["label"] = entry["stageCode"], entry["stageLabel"]
		baseEntries[order] = cloneMap(entry)
	}
	merged := make([]any, 0, len(baseEntries))
	for order := 1; order <= 36; order++ {
		entry := baseEntries[order]
		if entry == nil {
			writeAPIError(w, 422, "validation_error", "timing profile must contain all 36 stages")
			return true
		}
		merged = append(merged, entry)
	}
	profile := cloneMap(input)
	profile["id"], profile["version"], profile["isCurrent"], profile["createdAt"], profile["updatedAt"], profile["entries"] = id, version+1, true, time.Now().UTC().Format(time.RFC3339), time.Now().UTC().Format(time.RFC3339), merged
	profile["createdByOperatorId"] = r.Header.Get("X-Operator-Id")
	for _, old := range s.entities["timing-profiles"] {
		if stringValue(old["protocolId"]) == protocolID {
			before := cloneMap(old)
			old["isCurrent"] = false
			if !reflect.DeepEqual(before, old) {
				s.auditLocked(r, "UPDATE", "stage_timing_profile", stringValue(old["id"]), before, old)
			}
		}
	}
	s.entities["timing-profiles"][id] = profile
	s.auditLocked(r, "INSERT", "stage_timing_profile", id, nil, profile)
	writeJSON(w, 201, profile)
	return true
}

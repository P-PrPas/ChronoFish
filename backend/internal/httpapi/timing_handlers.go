package httpapi

import (
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func (s *apiServer) protocolStages(w http.ResponseWriter, r *http.Request, id string) bool {
	s.mu.RLock()
	p, ok := s.entities["protocols"][id]
	profile := s.entities["timing-profiles"]["01900000-0000-7000-8000-000000000002"]
	s.mu.RUnlock()
	if !ok {
		writeAPIError(w, 404, "not_found", "ไม่พบ protocol")
		return true
	}
	_ = p
	writeJSON(w, 200, map[string]any{"items": profile["entries"]})
	return true
}

func (s *apiServer) currentTiming(w http.ResponseWriter) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, profile := range s.entities["timing-profiles"] {
		if profile["isCurrent"] == true {
			writeJSON(w, 200, cloneMap(profile))
			return true
		}
	}
	writeAPIError(w, 404, "not_found", "ยังไม่มี timing profile")
	return true
}

func (s *apiServer) timingCSV(w http.ResponseWriter, r *http.Request) bool {
	if r.Method == http.MethodGet {
		protocolID := strings.TrimSpace(r.URL.Query().Get("protocolId"))
		if !isUUID(protocolID) {
			writeAPIError(w, http.StatusBadRequest, "invalid_query", "protocolId ต้องเป็น UUID")
			return true
		}
		s.mu.RLock()
		profile := s.entities["timing-profiles"]["01900000-0000-7000-8000-000000000002"]
		if profile != nil && stringValue(profile["protocolId"]) != protocolID {
			profile = nil
		}
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
	input, err := timingCSVInput(r.Body)
	if err != nil {
		writeAPIError(w, 422, "validation_error", err.Error())
		return true
	}
	return s.createTiming(w, r, input)
}

func timingCSVInput(body io.Reader) (map[string]any, error) {
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
	return map[string]any{
		"protocolId": "01900000-0000-7000-8000-000000000001",
		"name":       "Imported timing profile", "entries": entries,
	}, nil
}

func (s *apiServer) createTiming(w http.ResponseWriter, r *http.Request, input map[string]any) bool {
	entries, ok := input["entries"].([]any)
	if !ok || len(entries) == 0 {
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
	profile := cloneMap(input)
	profile["id"], profile["version"], profile["isCurrent"], profile["createdAt"], profile["updatedAt"] = id, len(s.entities["timing-profiles"])+1, true, time.Now().UTC().Format(time.RFC3339), time.Now().UTC().Format(time.RFC3339)
	profile["createdByOperatorId"] = r.Header.Get("X-Operator-Id")
	for _, raw := range entries {
		entry, ok := raw.(map[string]any)
		if !ok || stringValue(entry["stageCode"]) == "" || stringValue(entry["stageLabel"]) == "" {
			writeAPIError(w, 422, "validation_error", "timing entry ไม่ถูกต้อง")
			return true
		}
		order := intValue(entry["stageOrder"])
		if order < 1 || order > 36 || stageNumber(stringValue(entry["stageCode"])) != order {
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
		if stringValue(entry["stageCode"]) == "" {
			entry["stageCode"] = entry["code"]
		}
		if stringValue(entry["stageLabel"]) == "" {
			entry["stageLabel"] = entry["label"]
		}
	}
	for _, old := range s.entities["timing-profiles"] {
		old["isCurrent"] = false
	}
	s.entities["timing-profiles"][id] = profile
	s.auditLocked(r, "INSERT", "stage_timing_profile", id, nil, profile)
	writeJSON(w, 201, profile)
	return true
}

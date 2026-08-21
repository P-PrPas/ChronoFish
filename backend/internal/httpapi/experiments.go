package httpapi

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

func (s *apiServer) createBatch(w http.ResponseWriter, r *http.Request) bool {
	input, err := readMap(r)
	if err != nil {
		writeAPIError(w, 400, "invalid_json", "ข้อมูล JSON ไม่ถูกต้อง")
		return true
	}
	normalizeMap(input)
	for _, field := range []string{"experimentDate", "siteId", "operatorId", "protocolId", "treatmentGroupId"} {
		if stringValue(input[field]) == "" {
			writeAPIError(w, 422, "validation_error", "ต้องระบุ "+field)
			return true
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for resource, field := range map[string]string{"sites": "siteId", "operators": "operatorId", "protocols": "protocolId", "treatment-groups": "treatmentGroupId"} {
		ref := s.entities[resource][stringValue(input[field])]
		if ref == nil || ref["active"] == false {
			writeAPIError(w, http.StatusUnprocessableEntity, "validation_error", "ไม่พบ "+field+" ที่ active")
			return true
		}
	}
	profileID := stringValue(input["timingProfileId"])
	if profileID == "" {
		if current := s.currentTimingProfileLocked(stringValue(input["protocolId"])); current != nil {
			profileID = stringValue(current["id"])
		}
	}
	if profile := s.entities["timing-profiles"][profileID]; profile == nil || profile["deletedAt"] != nil || stringValue(profile["protocolId"]) != stringValue(input["protocolId"]) || profile["isCurrent"] != true && stringValue(input["timingProfileId"]) == "" {
		writeAPIError(w, http.StatusUnprocessableEntity, "validation_error", "ไม่พบ timing profile")
		return true
	}
	key := idempotencyKey(r, input)
	if body, ok := s.idempotency["batch:"+key]; key != "" && ok {
		writeRaw(w, http.StatusOK, body)
		return true
	}
	for _, existing := range s.entities["batches"] {
		if strings.EqualFold(strings.TrimSpace(stringValue(existing["batchCode"])), strings.TrimSpace(stringValue(input["batchCode"]))) && stringValue(input["batchCode"]) != "" {
			writeAPIError(w, http.StatusConflict, "conflict", "batchCode ซ้ำกับรายการที่มีอยู่แล้ว")
			return true
		}
	}
	id := uuidV7()
	now := time.Now().UTC().Format(time.RFC3339)
	code := stringValue(input["batchCode"])
	dayNo := intValue(input["dayNo"])
	if dayNo < 1 {
		dayNo = 1
		for _, existing := range s.entities["batches"] {
			if existing["deletedAt"] != nil || existing["active"] == false || stringValue(existing["operatorId"]) != stringValue(input["operatorId"]) || stringValue(existing["protocolId"]) != stringValue(input["protocolId"]) || stringValue(existing["treatmentGroupId"]) != stringValue(input["treatmentGroupId"]) {
				continue
			}
			if candidate := intValue(existing["dayNo"]) + 1; candidate > dayNo {
				dayNo = candidate
			}
		}
	}
	if code == "" {
		operatorPart := stringValue(s.entities["operators"][stringValue(input["operatorId"])]["name"])
		if operatorPart == "" {
			operatorPart = stringValue(input["operatorId"])
		}
		treatmentPart := stringValue(s.entities["treatment-groups"][stringValue(input["treatmentGroupId"])]["code"])
		if treatmentPart == "" {
			treatmentPart = stringValue(input["treatmentGroupId"])
		}
		code = fmt.Sprintf("%d_%s_%s", dayNo, sanitizeBatchPart(operatorPart), sanitizeBatchPart(treatmentPart))
	}
	batch := cloneMap(input)
	batch["id"], batch["batchCode"], batch["dayNo"], batch["timingProfileId"], batch["createdAt"], batch["updatedAt"], batch["active"] = id, code, dayNo, profileID, now, now, true
	s.entities["batches"][id] = batch
	s.auditLocked(r, "INSERT", "experiment_batch", id, nil, batch)
	if key != "" {
		body, _ := json.Marshal(batch)
		s.setMutationCache(r, "batch:"+key, body)
	}
	writeJSON(w, 201, batch)
	return true
}

func sanitizeBatchPart(value string) string {
	value = strings.TrimSpace(value)
	value = strings.ReplaceAll(value, " ", "-")
	return value
}

func (s *apiServer) batchRoute(w http.ResponseWriter, r *http.Request, p []string) bool {
	if len(p) == 0 {
		if r.Method == http.MethodGet {
			return s.listEntity(w, r, "batches")
		}
		if r.Method == http.MethodPost {
			return s.createBatch(w, r)
		}
		return false
	}
	if len(p) >= 2 {
		switch p[1] {
		case "injection-lots":
			if len(p) == 2 && r.Method == http.MethodPost {
				return s.createLot(w, r, p[0])
			}
		case "duplicate":
			if len(p) == 2 && r.Method == http.MethodPost {
				return s.duplicateBatch(w, r, p[0])
			}
		case "control-arm-counts":
			if len(p) == 2 && (r.Method == http.MethodGet || r.Method == http.MethodPut) {
				return s.controlCounts(w, r, p[0])
			}
		}
	}
	if len(p) == 1 {
		return s.entity(w, r, "batches", p)
	}
	return false
}

func (s *apiServer) createLot(w http.ResponseWriter, r *http.Request, batchID string) bool {
	input, err := readMap(r)
	if err != nil {
		writeAPIError(w, 400, "invalid_json", "ข้อมูล JSON ไม่ถูกต้อง")
		return true
	}
	normalizeMap(input)
	if stringValue(input["lotNo"]) == "" || stringValue(input["donorCellLineId"]) == "" || stringValue(input["activatedAt"]) == "" {
		writeAPIError(w, 422, "validation_error", "ต้องระบุ lotNo, donorCellLineId และ activatedAt")
		return true
	}
	activated, err := time.Parse(time.RFC3339, stringValue(input["activatedAt"]))
	if err != nil {
		writeAPIError(w, 422, "validation_error", "activatedAt ต้องเป็น RFC3339")
		return true
	}
	for _, field := range []string{"enuStartAt", "enuFinishAt"} {
		if value := stringValue(input[field]); value != "" {
			if _, parseErr := parseBangkokInstant(value); parseErr != nil {
				writeAPIError(w, 422, "validation_error", field+" must be RFC3339 with timezone offset")
				return true
			}
		}
	}
	if finish := stringValue(input["enuFinishAt"]); finish != "" {
		finishAt, finishErr := parseBangkokInstant(finish)
		if finishErr != nil || !finishAt.After(activated) {
			writeAPIError(w, 422, "validation_error", "enuFinishAt must be after activatedAt")
			return true
		}
		if start := stringValue(input["enuStartAt"]); start != "" {
			startAt, startErr := parseBangkokInstant(start)
			if startErr != nil || !finishAt.After(startAt) {
				writeAPIError(w, 422, "validation_error", "enuFinishAt must be after enuStartAt")
				return true
			}
		}
	}
	n := intValue(input["nActivated"])
	if n < 0 || n > 96 {
		writeAPIError(w, 422, "validation_error", "nActivated ต้องอยู่ระหว่าง 0 ถึง 96")
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	batch, ok := s.entities["batches"][batchID]
	if !ok || batch["active"] == false || batch["deletedAt"] != nil {
		writeAPIError(w, 404, "not_found", "ไม่พบ batch")
		return true
	}
	if donor := s.entities["donor-cell-lines"][stringValue(input["donorCellLineId"])]; donor == nil || donor["active"] == false {
		writeAPIError(w, http.StatusUnprocessableEntity, "validation_error", "ไม่พบ donor cell line ที่ active")
		return true
	}
	for _, existing := range s.entities["injection-lots"] {
		if stringValue(existing["batchId"]) == batchID && strings.EqualFold(strings.TrimSpace(stringValue(existing["lotNo"])), strings.TrimSpace(stringValue(input["lotNo"]))) && existing["deletedAt"] == nil {
			writeAPIError(w, http.StatusConflict, "conflict", "lotNo ซ้ำใน batch")
			return true
		}
	}
	lotID := uuidV7()
	now := time.Now().UTC().Format(time.RFC3339)
	code := stringValue(batch["batchCode"])
	lot := cloneMap(input)
	lot["id"], lot["batchId"], lot["createdAt"], lot["updatedAt"], lot["active"] = lotID, batchID, now, now, true
	embryos := make([]map[string]any, 0, n)
	positions, _ := input["wellPositions"].([]any)
	for i := 1; i <= n; i++ {
		embryoID := uuidV7()
		embryo := map[string]any{"id": embryoID, "injectionLotId": lotID, "seqInLot": i, "embryoCode": fmt.Sprintf("%s_%s_%d", code, stringValue(input["lotNo"]), i), "wellPosition": nil, "active": true, "createdAt": now, "updatedAt": now}
		if i <= len(positions) {
			embryo["wellPosition"] = positions[i-1]
		}
		s.entities["embryos"][embryoID] = embryo
		embryos = append(embryos, embryo)
	}
	s.entities["injection-lots"][lotID] = lot
	s.auditLocked(r, "INSERT", "injection_lot", lotID, nil, lot)
	for _, embryo := range embryos {
		s.auditLocked(r, "INSERT", "embryo", stringValue(embryo["id"]), nil, embryo)
	}
	result := cloneMap(lot)
	result["embryos"] = embryos
	_ = activated
	writeJSON(w, 201, result)
	return true
}

func (s *apiServer) lotEmbryos(w http.ResponseWriter, r *http.Request, lotID string, rest []string) bool {
	if r.Method == http.MethodGet {
		s.mu.RLock()
		items := make([]map[string]any, 0)
		lot := s.entities["injection-lots"][lotID]
		if lot == nil || lot["active"] == false || lot["deletedAt"] != nil {
			s.mu.RUnlock()
			writeAPIError(w, http.StatusNotFound, "not_found", "ไม่พบ injection lot")
			return true
		}
		aliveOnly := r.URL.Query().Get("aliveOnly") == "true"
		for _, embryo := range s.entities["embryos"] {
			if stringValue(embryo["injectionLotId"]) == lotID && embryo["active"] != false && embryo["deletedAt"] == nil && (!aliveOnly || embryo["exitReason"] == nil) {
				items = append(items, cloneMap(embryo))
			}
		}
		s.mu.RUnlock()
		sortItems(items)
		writeJSON(w, 200, map[string]any{"items": items})
		return true
	}
	if r.Method == http.MethodPost {
		input, err := readMap(r)
		if err != nil {
			writeAPIError(w, 400, "invalid_json", "ข้อมูล JSON ไม่ถูกต้อง")
			return true
		}
		n := intValue(input["count"])
		if n < 1 || n > 96 {
			writeAPIError(w, 422, "validation_error", "count ต้องอยู่ระหว่าง 1 ถึง 96")
			return true
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		lot, ok := s.entities["injection-lots"][lotID]
		if !ok || lot["active"] == false || lot["deletedAt"] != nil {
			writeAPIError(w, http.StatusNotFound, "not_found", "ไม่พบ injection lot")
			return true
		}
		batch := s.entities["batches"][stringValue(lot["batchId"])]
		if batch == nil {
			writeAPIError(w, http.StatusConflict, "invalid_state", "injection lot ไม่มี batch ที่ถูกต้อง")
			return true
		}
		maxSeq := 0
		for _, embryo := range s.entities["embryos"] {
			if stringValue(embryo["injectionLotId"]) == lotID && intValue(embryo["seqInLot"]) > maxSeq {
				maxSeq = intValue(embryo["seqInLot"])
			}
		}
		created := make([]any, 0, n)
		for i := 0; i < n; i++ {
			id := uuidV7()
			seq := maxSeq + i + 1
			embryo := map[string]any{"id": id, "injectionLotId": lotID, "seqInLot": seq, "embryoCode": fmt.Sprintf("%s_%s_%d", stringValue(batch["batchCode"]), stringValue(lot["lotNo"]), seq), "active": true, "createdAt": time.Now().UTC().Format(time.RFC3339), "updatedAt": time.Now().UTC().Format(time.RFC3339)}
			s.entities["embryos"][id] = embryo
			created = append(created, embryo)
			s.auditLocked(r, "INSERT", "embryo", id, nil, embryo)
		}
		writeJSON(w, 201, map[string]any{"items": created})
		return true
	}
	return false
}

func (s *apiServer) duplicateBatch(w http.ResponseWriter, r *http.Request, id string) bool {
	input, err := readMap(r)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_json", "ข้อมูล JSON ไม่ถูกต้อง")
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	old, ok := s.entities["batches"][id]
	if !ok || old["active"] == false || old["deletedAt"] != nil {
		writeAPIError(w, 404, "not_found", "ไม่พบ batch")
		return true
	}
	copy := cloneMap(old)
	delete(copy, "id")
	delete(copy, "batchCode")
	date := stringValue(input["experimentDate"])
	if _, err := time.Parse("2006-01-02", date); err != nil {
		writeAPIError(w, http.StatusUnprocessableEntity, "validation_error", "experimentDate ต้องเป็น YYYY-MM-DD")
		return true
	}
	copy["experimentDate"] = date
	copy["dayNo"] = input["dayNo"]
	copy["batchCode"] = ""
	copy["copyInjectionLots"] = input["copyInjectionLots"] == true
	copy["sourceBatchId"] = id
	if body, err := json.Marshal(copy); err == nil {
		r.Body = io.NopCloser(strings.NewReader(string(body)))
	}
	return s.createBatchLocked(w, r, copy)
}

func (s *apiServer) createBatchLocked(w http.ResponseWriter, r *http.Request, input map[string]any) bool {
	id := uuidV7()
	now := time.Now().UTC().Format(time.RFC3339)
	sourceBatchID := stringValue(input["sourceBatchId"])
	copyInjectionLots := input["copyInjectionLots"] == true
	batch := cloneMap(input)
	delete(batch, "sourceBatchId")
	delete(batch, "copyInjectionLots")
	dayNo := intValue(batch["dayNo"])
	if dayNo < 1 {
		dayNo = s.nextBatchDayNoLocked(batch)
	}
	operatorPart := sanitizeBatchPart(stringValue(s.entities["operators"][stringValue(batch["operatorId"])]["name"]))
	treatmentPart := sanitizeBatchPart(stringValue(s.entities["treatment-groups"][stringValue(batch["treatmentGroupId"])]["code"]))
	batchCode := fmt.Sprintf("%d_%s_%s", dayNo, operatorPart, treatmentPart)
	if operatorPart == "" {
		operatorPart = stringValue(batch["operatorId"])
	}
	if treatmentPart == "" {
		treatmentPart = stringValue(batch["treatmentGroupId"])
	}
	batchCode = fmt.Sprintf("%d_%s_%s", dayNo, operatorPart, treatmentPart)
	for _, existing := range s.entities["batches"] {
		if existing["active"] != false && strings.EqualFold(stringValue(existing["batchCode"]), batchCode) {
			batchCode += "_" + id[:8]
			break
		}
	}
	batch["id"], batch["batchCode"], batch["dayNo"], batch["createdAt"], batch["updatedAt"], batch["active"] = id, batchCode, dayNo, now, now, true
	s.entities["batches"][id] = batch
	s.auditLocked(r, "INSERT", "experiment_batch", id, nil, batch)
	if copyInjectionLots && sourceBatchID != "" {
		for _, oldLot := range s.entities["injection-lots"] {
			if stringValue(oldLot["batchId"]) != sourceBatchID || oldLot["deletedAt"] != nil || oldLot["active"] == false {
				continue
			}
			lot := cloneMap(oldLot)
			lot["id"], lot["batchId"], lot["activatedAt"], lot["nActivated"], lot["createdAt"], lot["updatedAt"] = uuidV7(), id, nil, 0, now, now
			s.entities["injection-lots"][stringValue(lot["id"])] = lot
			s.auditLocked(r, "INSERT", "injection_lot", stringValue(lot["id"]), nil, lot)
		}
	}
	writeJSON(w, 201, batch)
	return true
}

// nextBatchDayNoLocked returns the next sequence number in the experiment
// series. It must not derive day_no from the calendar day of experimentDate.
func (s *apiServer) nextBatchDayNoLocked(input map[string]any) int {
	next := 1
	for _, existing := range s.entities["batches"] {
		if existing["deletedAt"] != nil || existing["active"] == false {
			continue
		}
		if stringValue(existing["operatorId"]) != stringValue(input["operatorId"]) ||
			stringValue(existing["protocolId"]) != stringValue(input["protocolId"]) ||
			stringValue(existing["treatmentGroupId"]) != stringValue(input["treatmentGroupId"]) {
			continue
		}
		if candidate := intValue(existing["dayNo"]) + 1; candidate > next {
			next = candidate
		}
	}
	return next
}

func (s *apiServer) controlCounts(w http.ResponseWriter, r *http.Request, batchID string) bool {
	if r.Method == http.MethodGet {
		s.mu.RLock()
		defer s.mu.RUnlock()
		items := []map[string]any{}
		for _, item := range s.entities["control-arm-counts"] {
			if stringValue(item["batchId"]) == batchID {
				items = append(items, cloneMap(item))
			}
		}
		writeJSON(w, 200, map[string]any{"items": items})
		return true
	}
	input, err := readMap(r)
	if err != nil {
		writeAPIError(w, 400, "invalid_json", "ข้อมูล JSON ไม่ถูกต้อง")
		return true
	}
	raw, ok := input["items"].([]any)
	if !ok {
		writeAPIError(w, 422, "validation_error", "items is required")
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	batch, ok := s.entities["batches"][batchID]
	if !ok || batch["active"] == false || batch["deletedAt"] != nil {
		writeAPIError(w, 404, "not_found", "batch not found")
		return true
	}
	seen := make(map[string]bool)
	result := make([]map[string]any, 0, len(raw))
	for _, v := range raw {
		item, ok := v.(map[string]any)
		if !ok {
			writeAPIError(w, 422, "validation_error", "each control count must be an object")
			return true
		}
		arm := stringValue(item["armType"])
		stage := stringValue(item["stageCode"])
		if arm != "NATURAL_BREEDING" && arm != "IVF" {
			writeAPIError(w, 422, "validation_error", "armType must be NATURAL_BREEDING or IVF")
			return true
		}
		if stageNumber(stage) < 1 || stageNumber(stage) > 36 {
			writeAPIError(w, 422, "validation_error", "stageCode is invalid")
			return true
		}
		if !nonNegativeWhole(item["nNormal"]) || !nonNegativeWhole(item["nAbnormal"]) {
			writeAPIError(w, 422, "validation_error", "counts must be non-negative integers")
			return true
		}
		naturalKey := arm + "|" + stage
		if seen[naturalKey] {
			writeAPIError(w, 422, "validation_error", "duplicate armType and stageCode")
			return true
		}
		seen[naturalKey] = true
		var existing map[string]any
		for _, candidate := range s.entities["control-arm-counts"] {
			if candidate["deletedAt"] == nil && stringValue(candidate["batchId"]) == batchID && stringValue(candidate["armType"]) == arm && stringValue(candidate["stageCode"]) == stage {
				existing = candidate
				break
			}
		}
		now := time.Now().UTC().Format(time.RFC3339)
		if existing == nil {
			item = cloneMap(item)
			item["id"], item["batchId"], item["createdAt"], item["updatedAt"] = uuidV7(), batchID, now, now
			s.entities["control-arm-counts"][stringValue(item["id"])] = item
			s.auditLocked(r, "INSERT", "control_arm_count", stringValue(item["id"]), nil, item)
		} else {
			before := cloneMap(existing)
			existing["nNormal"], existing["nAbnormal"], existing["updatedAt"] = intValue(item["nNormal"]), intValue(item["nAbnormal"]), now
			s.auditLocked(r, "UPDATE", "control_arm_count", stringValue(existing["id"]), before, existing)
			item = existing
		}
		result = append(result, cloneMap(item))
	}
	if r.Method == http.MethodPut {
		now := time.Now().UTC().Format(time.RFC3339)
		for _, existing := range s.entities["control-arm-counts"] {
			if stringValue(existing["batchId"]) != batchID || existing["deletedAt"] != nil {
				continue
			}
			if !seen[stringValue(existing["armType"])+"|"+stringValue(existing["stageCode"])] {
				before := cloneMap(existing)
				existing["deletedAt"], existing["updatedAt"] = now, now
				s.auditLocked(r, "UPDATE", "control_arm_count", stringValue(existing["id"]), before, existing)
			}
		}
	}
	writeJSON(w, 200, map[string]any{"items": result})
	return true
}

func nonNegativeWhole(value any) bool {
	switch number := value.(type) {
	case int:
		return number >= 0
	case float64:
		return number >= 0 && number == float64(int(number))
	case json.Number:
		parsed, err := number.Int64()
		return err == nil && parsed >= 0
	default:
		return false
	}
}

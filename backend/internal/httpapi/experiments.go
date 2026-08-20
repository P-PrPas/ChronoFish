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
		profileID = "01900000-0000-7000-8000-000000000002"
	}
	if profile := s.entities["timing-profiles"][profileID]; profile == nil || profile["deletedAt"] != nil {
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
	if code == "" {
		code = fmt.Sprintf("%s_%s_%s", stringValue(input["experimentDate"]), stringValue(input["operatorId"]), stringValue(input["treatmentGroupId"]))
	}
	batch := cloneMap(input)
	batch["id"], batch["batchCode"], batch["timingProfileId"], batch["createdAt"], batch["updatedAt"], batch["active"] = id, code, profileID, now, now, true
	s.entities["batches"][id] = batch
	s.auditLocked(r, "INSERT", "experiment_batch", id, nil, batch)
	if key != "" {
		body, _ := json.Marshal(batch)
		s.idempotency["batch:"+key] = body
	}
	writeJSON(w, 201, batch)
	return true
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
			if len(p) == 2 && (r.Method == http.MethodGet || r.Method == http.MethodPut || r.Method == http.MethodPost) {
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
	n := intValue(input["nActivated"])
	if n < 0 || n > 96 {
		writeAPIError(w, 422, "validation_error", "nActivated ต้องอยู่ระหว่าง 0 ถึง 96")
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	batch, ok := s.entities["batches"][batchID]
	if !ok {
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
		if s.entities["injection-lots"][lotID] == nil {
			s.mu.RUnlock()
			writeAPIError(w, http.StatusNotFound, "not_found", "ไม่พบ injection lot")
			return true
		}
		aliveOnly := r.URL.Query().Get("aliveOnly") == "true"
		for _, embryo := range s.entities["embryos"] {
			if stringValue(embryo["injectionLotId"]) == lotID && embryo["active"] != false && (!aliveOnly || embryo["exitReason"] == nil) {
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
		if !ok || lot["active"] == false {
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
		}
		writeJSON(w, 201, map[string]any{"items": created})
		return true
	}
	return false
}

func (s *apiServer) duplicateBatch(w http.ResponseWriter, r *http.Request, id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	old, ok := s.entities["batches"][id]
	if !ok {
		writeAPIError(w, 404, "not_found", "ไม่พบ batch")
		return true
	}
	copy := cloneMap(old)
	delete(copy, "id")
	delete(copy, "batchCode")
	if body, err := json.Marshal(copy); err == nil {
		r.Body = io.NopCloser(strings.NewReader(string(body)))
	}
	return s.createBatchLocked(w, r, copy)
}

func (s *apiServer) createBatchLocked(w http.ResponseWriter, r *http.Request, input map[string]any) bool {
	id := uuidV7()
	now := time.Now().UTC().Format(time.RFC3339)
	batch := cloneMap(input)
	batch["id"], batch["batchCode"], batch["experimentDate"], batch["createdAt"], batch["updatedAt"], batch["active"] = id, fmt.Sprintf("copy_%s", id[:8]), time.Now().UTC().Format("2006-01-02"), now, now, true
	s.entities["batches"][id] = batch
	s.auditLocked(r, "INSERT", "experiment_batch", id, nil, batch)
	writeJSON(w, 201, batch)
	return true
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
	raw, _ := input["items"].([]any)
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, v := range raw {
		item, ok := v.(map[string]any)
		if !ok {
			continue
		}
		item["id"] = uuidV7()
		item["batchId"] = batchID
		item["createdAt"] = time.Now().UTC().Format(time.RFC3339)
		s.entities["control-arm-counts"][stringValue(item["id"])] = item
	}
	writeJSON(w, 200, map[string]any{"items": raw})
	return true
}

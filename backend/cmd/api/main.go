package main

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var version = "dev"

type healthResponse struct {
	Status  string `json:"status"`
	Version string `json:"version"`
}

type errorResponse struct {
	Error errorBody `json:"error"`
}

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Details any    `json:"details,omitempty"`
}

type apiServer struct {
	buildVersion string
	mu           sync.RWMutex
	entities     map[string]map[string]map[string]any
	audits       []map[string]any
	observations map[string]map[string]any
	fishObs      map[string]map[string]any
	idempotency  map[string]json.RawMessage
	fishNo       int
}

func newAPIServer() *apiServer {
	s := &apiServer{
		buildVersion: version,
		entities:     make(map[string]map[string]map[string]any),
		audits:       make([]map[string]any, 0),
		observations: make(map[string]map[string]any),
		fishObs:      make(map[string]map[string]any),
		idempotency:  make(map[string]json.RawMessage),
		fishNo:       1,
	}
	for _, resource := range []string{"sites", "operators", "donor-cell-lines", "recipient-egg-lots", "csof-lots", "treatment-groups", "fish-boxes", "protocols", "timing-profiles", "batches", "injection-lots", "embryos", "fish", "specimens", "control-arm-counts"} {
		s.entities[resource] = make(map[string]map[string]any)
	}
	s.seedProtocol()
	return s
}

func (s *apiServer) seedProtocol() {
	now := "2026-01-01T00:00:00Z"
	protocol := map[string]any{"id": "01900000-0000-7000-8000-000000000001", "name": "SCNT standard", "stage1MaxAgeDays": 5, "active": true, "createdAt": now, "updatedAt": now}
	s.entities["protocols"][protocol["id"].(string)] = protocol
	entries := make([]any, 0, 36)
	for i := 1; i <= 36; i++ {
		code := stageCode(i)
		entries = append(entries, map[string]any{"id": uuidV7(), "protocolId": protocol["id"], "stageOrder": i, "code": code, "label": stageLabel(i), "shortLabel": stageLabel(i), "phase": "LARVAL", "stageScope": map[bool]string{true: "STAGE_1", false: "STAGE_2"}[i <= 26], "expectedHpa": expectedHPA(code)})
	}
	profile := map[string]any{"id": "01900000-0000-7000-8000-000000000002", "protocolId": protocol["id"], "version": 1, "name": "ZFIN 28.5C (default)", "isCurrent": true, "entries": entries, "createdAt": now, "updatedAt": now}
	s.entities["timing-profiles"][profile["id"].(string)] = profile
}

func stageLabel(order int) string {
	if order <= 26 {
		return fmt.Sprintf("Stage %d", order)
	}
	return fmt.Sprintf("Day %d", order-21)
}

func stageCode(order int) string {
	codes := []string{"1C", "2C", "4C", "8C", "16C", "32C", "64C", "128C", "256C", "512C", "1K", "HI", "OB", "SPH", "DO", "30EPI", "50EPI", "GR", "SH", "75EPI", "90EPI", "1D", "2D", "3D", "4D", "5D", "6D", "7D", "8D", "9D", "10D", "11D", "12D", "13D", "14D", "15D"}
	if order < 1 || order > len(codes) {
		return fmt.Sprintf("stage_%02d", order)
	}
	return fmt.Sprintf("stage_%02d_%s", order, codes[order-1])
}

func expectedHPA(code string) float64 {
	n := 0
	if suffix := strings.TrimPrefix(code, "stage_"); suffix != code {
		stageNo := strings.SplitN(suffix, "_", 2)[0]
		n, _ = strconv.Atoi(strings.TrimLeft(stageNo, "0"))
	}
	values := []float64{0, .75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.33, 3.66, 4, 4.33, 4.66, 5.25, 5.66, 6, 8, 9, 24, 48, 72, 96, 120, 144, 168, 192, 216, 240, 264, 288, 312, 336, 360}
	if n >= 1 && n <= len(values) {
		return values[n-1]
	}
	return 0
}

func (s *apiServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/api/v1/health" && r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, healthResponse{Status: "ok", Version: s.buildVersion})
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/api/v1/") {
		writeAPIError(w, http.StatusNotFound, "not_found", "เส้นทางนี้ไม่มีอยู่ใน API")
		return
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		if r.Header.Get("X-Operator-Id") == "" || r.Header.Get("X-Device-Id") == "" {
			writeAPIError(w, http.StatusBadRequest, "missing_context", "ทุกการบันทึกต้องมี X-Operator-Id และ X-Device-Id")
			return
		}
	}
	if r.Body != nil {
		r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/")
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if handled := s.route(w, r, parts); !handled {
		writeAPIError(w, http.StatusNotFound, "not_found", "ไม่พบ endpoint ที่ร้องขอ")
	}
}

func (s *apiServer) route(w http.ResponseWriter, r *http.Request, p []string) bool {
	if len(p) == 0 {
		return false
	}
	if p[0] == "audit-log" {
		return s.auditLog(w, r)
	}
	if p[0] == "due-checkpoints" {
		return s.dueCheckpoints(w, r)
	}
	if p[0] == "analytics" {
		return s.analytics(w, r, p[1:])
	}
	if p[0] == "exports" {
		return s.exports(w, r, p[1:])
	}
	if p[0] == "observations" {
		return s.observationsRoute(w, r, p[1:])
	}
	if p[0] == "promotions" {
		return s.promotions(w, r, p[1:])
	}
	if p[0] == "fish" && len(p) > 1 && p[1] == "roll-call" {
		return s.rollCall(w, r)
	}
	if p[0] == "injection-lots" && len(p) >= 3 && p[2] == "embryos" {
		return s.lotEmbryos(w, r, p[1], p[3:])
	}
	if p[0] == "injection-lots" && len(p) >= 4 && p[2] == "checkpoints" {
		return s.checkpoint(w, r, p[1], p[3])
	}
	if p[0] == "batches" && len(p) == 1 && r.Method == http.MethodPost {
		return s.createBatch(w, r)
	}
	if p[0] == "batches" && len(p) >= 3 && p[2] == "injection-lots" {
		return s.createLot(w, r, p[1])
	}
	if p[0] == "batches" && len(p) >= 3 && p[2] == "duplicate" {
		return s.duplicateBatch(w, r, p[1])
	}
	if p[0] == "batches" && len(p) >= 3 && p[2] == "control-arm-counts" {
		return s.controlCounts(w, r, p[1])
	}
	if p[0] == "specimens" {
		return false
	}
	if p[0] == "fish" && len(p) >= 3 && p[2] == "specimens" {
		return s.specimens(w, r, p[1])
	}
	if p[0] == "fish" {
		return s.entity(w, r, "fish", p[1:])
	}
	if p[0] == "timing-profiles" && len(p) == 2 && p[1] == "csv" {
		return s.timingCSV(w, r)
	}
	if p[0] == "timing-profiles" && len(p) == 1 && r.Method == http.MethodPost {
		input, err := readMap(r)
		if err != nil {
			writeAPIError(w, http.StatusBadRequest, "invalid_json", "ข้อมูล JSON ไม่ถูกต้อง")
			return true
		}
		return s.createTiming(w, r, input)
	}
	if p[0] == "protocols" && len(p) >= 3 && p[2] == "stages" {
		return s.protocolStages(w, r, p[1])
	}
	if p[0] == "protocols" && len(p) == 2 && p[1] != "" {
		return s.protocolStages(w, r, p[1])
	}
	resource := p[0]
	if _, ok := s.entities[resource]; !ok {
		return false
	}
	return s.entity(w, r, resource, p[1:])
}

func (s *apiServer) entity(w http.ResponseWriter, r *http.Request, resource string, p []string) bool {
	if resource == "protocols" && r.Method == http.MethodGet && len(p) == 0 {
		return s.listEntity(w, r, resource)
	}
	if resource == "timing-profiles" && r.Method == http.MethodGet && r.URL.Path == "/api/v1/timing-profiles/current" {
		return s.currentTiming(w)
	}
	if len(p) == 0 {
		if r.Method == http.MethodGet {
			return s.listEntity(w, r, resource)
		}
		if r.Method == http.MethodPost {
			return s.createEntity(w, r, resource)
		}
		return false
	}
	id := p[0]
	if r.Method == http.MethodGet {
		return s.getEntity(w, resource, id)
	}
	if r.Method == http.MethodPatch {
		return s.patchEntity(w, r, resource, id)
	}
	if r.Method == http.MethodDelete {
		return s.patchEntity(w, r, resource, id)
	}
	return false
}

func (s *apiServer) listEntity(w http.ResponseWriter, r *http.Request, resource string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	includeInactive := r.URL.Query().Get("includeInactive") == "true"
	items := make([]map[string]any, 0, len(s.entities[resource]))
	for _, item := range s.entities[resource] {
		if !includeInactive && item["active"] == false {
			continue
		}
		items = append(items, cloneMap(item))
	}
	sortItems(items)
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
	return true
}

func (s *apiServer) getEntity(w http.ResponseWriter, resource, id string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.entities[resource][id]
	if !ok {
		writeAPIError(w, http.StatusNotFound, "not_found", "ไม่พบรายการที่ร้องขอ")
		return true
	}
	result := cloneMap(item)
	if resource == "batches" {
		lots := make([]map[string]any, 0)
		for _, lot := range s.entities["injection-lots"] {
			if stringValue(lot["batchId"]) == id {
				detail := cloneMap(lot)
				embryos := make([]map[string]any, 0)
				for _, embryo := range s.entities["embryos"] {
					if stringValue(embryo["injectionLotId"]) == stringValue(lot["id"]) && embryo["active"] != false {
						embryos = append(embryos, cloneMap(embryo))
					}
				}
				sortItems(embryos)
				detail["embryos"] = embryos
				lots = append(lots, detail)
			}
		}
		sortItems(lots)
		result["injectionLots"] = lots
	}
	if resource == "injection-lots" {
		embryos := make([]map[string]any, 0)
		for _, embryo := range s.entities["embryos"] {
			if stringValue(embryo["injectionLotId"]) == id && embryo["active"] != false {
				embryos = append(embryos, cloneMap(embryo))
			}
		}
		sortItems(embryos)
		result["embryos"] = embryos
	}
	if resource == "fish" {
		observations := make([]map[string]any, 0)
		for _, observation := range s.fishObs {
			if stringValue(observation["cloneFishId"]) == id && observation["deletedAt"] == nil {
				observations = append(observations, cloneMap(observation))
			}
		}
		result["observations"] = observations
		specimens := make([]map[string]any, 0)
		for _, specimen := range s.entities["specimens"] {
			if stringValue(specimen["cloneFishId"]) == id {
				specimens = append(specimens, cloneMap(specimen))
			}
		}
		result["specimens"] = specimens
	}
	writeJSON(w, http.StatusOK, result)
	return true
}

func (s *apiServer) createEntity(w http.ResponseWriter, r *http.Request, resource string) bool {
	input, err := readMap(r)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_json", "ข้อมูล JSON ไม่ถูกต้อง")
		return true
	}
	normalizeMap(input)
	if err := validateEntity(resource, input); err != nil {
		writeAPIError(w, http.StatusUnprocessableEntity, "validation_error", err.Error())
		return true
	}
	key := idempotencyKey(r, input)
	s.mu.Lock()
	defer s.mu.Unlock()
	if body, ok := s.idempotency[key]; key != "" && ok {
		writeRaw(w, http.StatusOK, body)
		return true
	}
	if duplicateEntity(s.entities[resource], resource, input) {
		writeAPIError(w, http.StatusConflict, "conflict", "ข้อมูลซ้ำกับรายการที่มีอยู่แล้ว")
		return true
	}
	id := stringValue(input["id"])
	if id == "" {
		id = uuidV7()
	}
	now := time.Now().UTC().Format(time.RFC3339)
	item := cloneMap(input)
	item["id"], item["active"], item["createdAt"], item["updatedAt"] = id, true, now, now
	if resource == "fish" {
		if _, ok := item["runningNo"]; !ok {
			item["runningNo"] = s.fishNo
			s.fishNo++
		}
		if _, ok := item["status"]; !ok {
			item["status"] = "ALIVE"
		}
		if _, ok := item["condition"]; !ok {
			item["condition"] = "NORMAL"
		}
		if _, ok := item["sex"]; !ok {
			item["sex"] = "UNKNOWN"
		}
		if _, ok := item["finClipped"]; !ok {
			item["finClipped"] = false
		}
	}
	s.entities[resource][id] = item
	s.auditLocked(r, "INSERT", resource, id, nil, item)
	body, _ := json.Marshal(item)
	if key != "" {
		s.idempotency[key] = body
	}
	writeRaw(w, http.StatusCreated, body)
	return true
}

func (s *apiServer) patchEntity(w http.ResponseWriter, r *http.Request, resource, id string) bool {
	if resource == "timing-profiles" {
		writeAPIError(w, http.StatusConflict, "immutable", "timing profile เดิมแก้ไขไม่ได้ ให้สร้าง version ใหม่")
		return true
	}
	input := map[string]any{}
	if r.Method != http.MethodDelete {
		var err error
		input, err = readMap(r)
		if err != nil {
			writeAPIError(w, http.StatusBadRequest, "invalid_json", "ข้อมูล JSON ไม่ถูกต้อง")
			return true
		}
	}
	normalizeMap(input)
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.entities[resource][id]
	if !ok {
		writeAPIError(w, http.StatusNotFound, "not_found", "ไม่พบรายการที่ร้องขอ")
		return true
	}
	old := cloneMap(item)
	for key, value := range input {
		if key != "id" {
			item[key] = value
		}
	}
	if active, ok := input["active"].(bool); ok && !active {
		item["deletedAt"] = time.Now().UTC().Format(time.RFC3339)
	}
	if r.Method == http.MethodDelete {
		item["active"] = false
		item["deletedAt"] = time.Now().UTC().Format(time.RFC3339)
	}
	item["updatedAt"] = time.Now().UTC().Format(time.RFC3339)
	s.auditLocked(r, "UPDATE", resource, id, old, item)
	writeJSON(w, http.StatusOK, cloneMap(item))
	return true
}

func validateEntity(resource string, input map[string]any) error {
	required := map[string][]string{
		"sites": {"code", "name"}, "operators": {"name"}, "donor-cell-lines": {"strain", "preparation"},
		"recipient-egg-lots": {"breed", "label"}, "csof-lots": {"lotCode"}, "treatment-groups": {"code", "armType"}, "fish-boxes": {"boxCode"},
		"fish": {"fishCode", "dob", "donorCellLineId"},
	}
	for _, field := range required[resource] {
		if stringValue(input[field]) == "" {
			return fmt.Errorf("ต้องระบุ %s", field)
		}
	}
	if resource == "donor-cell-lines" && stringValue(input["preparation"]) != "DISSOCIATED" && stringValue(input["preparation"]) != "CHUNKS" {
		return errors.New("preparation ต้องเป็น DISSOCIATED หรือ CHUNKS")
	}
	if resource == "treatment-groups" && stringValue(input["armType"]) != "SCNT" && stringValue(input["armType"]) != "NATURAL_BREEDING" && stringValue(input["armType"]) != "IVF" {
		return errors.New("armType ไม่ถูกต้อง")
	}
	return nil
}

func duplicateEntity(items map[string]map[string]any, resource string, input map[string]any) bool {
	fields := map[string][]string{
		"sites": {"code"}, "operators": {"name"}, "donor-cell-lines": {"strain", "preparation", "batchCode"}, "recipient-egg-lots": {"label"}, "csof-lots": {"lotCode"}, "treatment-groups": {"code"},
	}
	for _, item := range items {
		if item["active"] == false {
			continue
		}
		matches := true
		for _, field := range fields[resource] {
			if strings.ToLower(strings.TrimSpace(stringValue(item[field]))) != strings.ToLower(strings.TrimSpace(stringValue(input[field]))) {
				matches = false
				break
			}
		}
		if matches && len(fields[resource]) > 0 {
			return true
		}
	}
	return false
}

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
	profileID := stringValue(input["timingProfileId"])
	if profileID == "" {
		profileID = "01900000-0000-7000-8000-000000000002"
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
		for _, embryo := range s.entities["embryos"] {
			if stringValue(embryo["injectionLotId"]) == lotID && embryo["active"] != false {
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
		if n < 1 {
			writeAPIError(w, 422, "validation_error", "count ต้องมากกว่า 0")
			return true
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		for i := 0; i < n; i++ {
			id := uuidV7()
			s.entities["embryos"][id] = map[string]any{"id": id, "injectionLotId": lotID, "seqInLot": len(s.entities["embryos"]) + 1, "embryoCode": fmt.Sprintf("%s_%d", lotID, i+1), "active": true}
		}
		writeJSON(w, 201, map[string]any{"items": []any{}})
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
		s.mu.RLock()
		profile := s.entities["timing-profiles"]["01900000-0000-7000-8000-000000000002"]
		s.mu.RUnlock()
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", "attachment; filename=timing-profile.csv")
		writer := csv.NewWriter(w)
		_ = writer.Write([]string{"stage_code", "expected_hpa"})
		if entries, ok := profile["entries"].([]any); ok {
			for _, v := range entries {
				item, _ := v.(map[string]any)
				_ = writer.Write([]string{stringValue(item["code"]), fmt.Sprint(item["expectedHpa"])})
			}
		}
		writer.Flush()
		return true
	}
	input, err := readMap(r)
	if err != nil {
		writeAPIError(w, 400, "invalid_json", "ข้อมูล JSON ไม่ถูกต้อง")
		return true
	}
	return s.createTiming(w, r, input)
}

func (s *apiServer) createTiming(w http.ResponseWriter, r *http.Request, input map[string]any) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := uuidV7()
	profile := cloneMap(input)
	profile["id"], profile["version"], profile["isCurrent"], profile["createdAt"], profile["updatedAt"] = id, len(s.entities["timing-profiles"])+1, true, time.Now().UTC().Format(time.RFC3339), time.Now().UTC().Format(time.RFC3339)
	for _, old := range s.entities["timing-profiles"] {
		old["isCurrent"] = false
	}
	s.entities["timing-profiles"][id] = profile
	s.auditLocked(r, "INSERT", "stage_timing_profile", id, nil, profile)
	writeJSON(w, 201, profile)
	return true
}

func (s *apiServer) dueCheckpoints(w http.ResponseWriter, r *http.Request) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	now := time.Now().UTC()
	items := []map[string]any{}
	upcoming := []map[string]any{}
	for _, lot := range s.entities["injection-lots"] {
		activated, err := time.Parse(time.RFC3339, stringValue(lot["activatedAt"]))
		if err != nil {
			continue
		}
		for stage := 1; stage <= 26; stage++ {
			code := stageCode(stage)
			due := activated.Add(time.Duration(expectedHPA(code) * float64(time.Hour)))
			observed := false
			for _, o := range s.observations {
				if stringValue(o["injectionLotId"]) == stringValue(lot["id"]) && stringValue(o["stageCode"]) == code && o["deletedAt"] == nil {
					observed = true
				}
			}
			if !observed {
				minutes := int(now.Sub(due).Minutes())
				if minutes >= 0 {
					items = append(items, map[string]any{"injectionLotId": lot["id"], "batchCode": s.entities["batches"][stringValue(lot["batchId"])]["batchCode"], "lotNo": lot["lotNo"], "stageCode": code, "stageLabel": stageLabel(stage), "stageOrder": stage, "dueAt": due.Format(time.RFC3339), "minutesLate": minutes})
				} else if len(upcoming) == 0 || stringValue(upcoming[len(upcoming)-1]["injectionLotId"]) != stringValue(lot["id"]) {
					upcoming = append(upcoming, map[string]any{"injectionLotId": lot["id"], "batchCode": s.entities["batches"][stringValue(lot["batchId"])]["batchCode"], "lotNo": lot["lotNo"], "stageCode": code, "stageLabel": stageLabel(stage), "stageOrder": stage, "dueAt": due.Format(time.RFC3339), "minutesLate": minutes})
				}
			}
		}
	}
	sortItems(items)
	sortItems(upcoming)
	writeJSON(w, 200, map[string]any{"overdue": items, "upcoming": upcoming, "pendingPromotionCount": s.pendingCountLocked(now)})
	return true
}

func (s *apiServer) checkpoint(w http.ResponseWriter, r *http.Request, lotID, stageCode string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	lot, ok := s.entities["injection-lots"][lotID]
	if !ok {
		writeAPIError(w, 404, "not_found", "ไม่พบ injection lot")
		return true
	}
	batch := s.entities["batches"][stringValue(lot["batchId"])]
	embryos := []map[string]any{}
	for _, e := range s.entities["embryos"] {
		if stringValue(e["injectionLotId"]) == lotID && e["active"] != false && e["exitReason"] == nil {
			condition := "NORMAL"
			for _, observation := range s.observations {
				if stringValue(observation["embryoId"]) == stringValue(e["id"]) && observation["deletedAt"] == nil && stringValue(observation["condition"]) != "" {
					condition = stringValue(observation["condition"])
				}
			}
			embryos = append(embryos, map[string]any{"embryoId": e["id"], "embryoCode": e["embryoCode"], "wellPosition": e["wellPosition"], "defaultCondition": condition, "firstAbnormalStageLabel": e["firstAbnormalStageCode"]})
		}
	}
	activated := stringValue(lot["activatedAt"])
	expected := expectedHPA(stageCode)
	writeJSON(w, 200, map[string]any{"injectionLotId": lotID, "batchCode": batch["batchCode"], "lotNo": lot["lotNo"], "stage": map[string]any{"code": stageCode, "label": stageLabel(stageNumber(stageCode)), "stageOrder": stageNumber(stageCode)}, "activatedAt": activated, "expectedHpa": expected, "dueAt": activated, "totalEmbryos": len(embryos), "embryos": embryos})
	return true
}

func (s *apiServer) observationsRoute(w http.ResponseWriter, r *http.Request, p []string) bool {
	if len(p) == 0 {
		return false
	}
	if p[0] == "embryo" {
		if len(p) == 1 && r.Method == http.MethodPost {
			return s.createEmbryoObservations(w, r)
		}
		if len(p) == 2 {
			return s.updateOrDeleteObservation(w, r, p[1], false)
		}
	}
	if p[0] == "fish" {
		if len(p) == 1 && r.Method == http.MethodPost {
			return s.createFishObservations(w, r)
		}
		if len(p) == 2 {
			return s.updateOrDeleteObservation(w, r, p[1], true)
		}
	}
	return false
}

func (s *apiServer) createEmbryoObservations(w http.ResponseWriter, r *http.Request) bool {
	input, err := readMap(r)
	if err != nil {
		writeAPIError(w, 400, "invalid_json", "ข้อมูล JSON ไม่ถูกต้อง")
		return true
	}
	raw, ok := input["observations"].([]any)
	if !ok {
		writeAPIError(w, 422, "validation_error", "ต้องระบุ observations")
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	results := make([]any, 0, len(raw))
	staged := make([]map[string]any, 0, len(raw))
	for _, value := range raw {
		item, ok := value.(map[string]any)
		if !ok {
			writeAPIError(w, 422, "validation_error", "รูปแบบ observation ไม่ถูกต้อง")
			return true
		}
		client := stringValue(item["clientUuid"])
		if client == "" {
			writeAPIError(w, 422, "validation_error", "ต้องระบุ clientUuid")
			return true
		}
		if old, ok := s.idempotency["embryo:"+client]; ok {
			var oldResult any
			_ = json.Unmarshal(old, &oldResult)
			results = append(results, oldResult)
			continue
		}
		if err := s.validateEmbryoObservation(item); err != nil {
			writeAPIError(w, 422, "validation_error", err.Error())
			return true
		}
		embryo := s.entities["embryos"][stringValue(item["embryoId"])]
		lot := s.entities["injection-lots"][stringValue(embryo["injectionLotId"])]
		observedAt, _ := time.Parse(time.RFC3339, stringValue(item["observedAt"]))
		activated, _ := time.Parse(time.RFC3339, stringValue(lot["activatedAt"]))
		actual := observedAt.Sub(activated).Hours()
		expected := expectedHPA(stringValue(item["stageCode"]))
		id := uuidV7()
		result := map[string]any{"clientUuid": client, "id": id, "status": "CREATED", "hpaActual": actual, "hpaExpected": expected, "deviationH": actual - expected, "deviationLabel": deviationLabel(actual - expected)}
		obs := cloneMap(item)
		obs["id"], obs["injectionLotId"], obs["hpaActual"], obs["hpaExpectedSnapshot"], obs["deviationH"], obs["operatorId"], obs["createdAt"] = id, lot["id"], actual, expected, actual-expected, r.Header.Get("X-Operator-Id"), time.Now().UTC().Format(time.RFC3339)
		staged = append(staged, obs)
		results = append(results, result)
	}
	for _, obs := range staged {
		s.observations[stringValue(obs["id"])] = obs
		s.auditLocked(r, "INSERT", "embryo_observation", stringValue(obs["id"]), nil, obs)
		outcome := stringValue(obs["outcome"])
		if outcome == "DEAD" || outcome == "DEGENERATED" {
			e := s.entities["embryos"][stringValue(obs["embryoId"])]
			e["exitReason"], e["exitAt"] = outcome, obs["observedAt"]
		} else if outcome == "ALIVE" && stringValue(obs["overrideReason"]) != "" {
			e := s.entities["embryos"][stringValue(obs["embryoId"])]
			delete(e, "exitReason")
			delete(e, "exitAt")
		}
		if stringValue(obs["condition"]) == "ABNORMAL" {
			e := s.entities["embryos"][stringValue(obs["embryoId"])]
			if e["firstAbnormalStageCode"] == nil {
				e["firstAbnormalStageCode"] = obs["stageCode"]
			}
		}
	}
	for i, result := range results {
		item, _ := result.(map[string]any)
		body, _ := json.Marshal(item)
		s.idempotency["embryo:"+stringValue(item["clientUuid"])] = body
		results[i] = item
	}
	writeJSON(w, 200, map[string]any{"results": results})
	return true
}

func (s *apiServer) validateEmbryoObservation(item map[string]any) error {
	for _, f := range []string{"embryoId", "stageCode", "observedAt", "outcome", "condition"} {
		if stringValue(item[f]) == "" {
			return fmt.Errorf("ต้องระบุ %s", f)
		}
	}
	embryo, ok := s.entities["embryos"][stringValue(item["embryoId"])]
	if !ok {
		return errors.New("ไม่พบ embryo")
	}
	lot := s.entities["injection-lots"][stringValue(embryo["injectionLotId"])]
	observed, err := time.Parse(time.RFC3339, stringValue(item["observedAt"]))
	if err != nil {
		return errors.New("observedAt ต้องเป็น RFC3339")
	}
	activated, err := time.Parse(time.RFC3339, stringValue(lot["activatedAt"]))
	if err != nil || observed.Before(activated) {
		return errors.New("observedAt ต้องไม่ก่อน activatedAt")
	}
	if observed.After(time.Now().UTC().Add(5 * time.Minute)) {
		return errors.New("observedAt ห้ามอยู่ในอนาคตเกิน 5 นาที")
	}
	outcome := stringValue(item["outcome"])
	if outcome != "ALIVE" && outcome != "DEAD" && outcome != "DEGENERATED" && outcome != "NOT_OBSERVED" {
		return errors.New("outcome ไม่ถูกต้อง")
	}
	condition := stringValue(item["condition"])
	if condition != "NORMAL" && condition != "ABNORMAL" && condition != "UNDETERMINED" {
		return errors.New("condition ไม่ถูกต้อง")
	}
	if outcome == "ALIVE" && embryo["exitReason"] != nil && stringValue(item["overrideReason"]) == "" {
		return errors.New("ต้องระบุ overrideReason เมื่อต้องการบันทึก ALIVE หลังมี exit event")
	}
	for _, old := range s.observations {
		if stringValue(old["embryoId"]) == stringValue(item["embryoId"]) && stringValue(old["stageCode"]) == stringValue(item["stageCode"]) && old["deletedAt"] == nil {
			return errors.New("มี observation ของ embryo และ stage นี้แล้ว")
		}
	}
	return nil
}

func deviationLabel(value float64) string {
	minutes := int(value * 60)
	if minutes >= 0 {
		return fmt.Sprintf("ช้ากว่าสากล %d นาที", minutes)
	}
	return fmt.Sprintf("เร็วกว่าสากล %d นาที", -minutes)
}

func (s *apiServer) updateOrDeleteObservation(w http.ResponseWriter, r *http.Request, id string, fish bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	collection := s.observations
	table := "embryo_observation"
	if fish {
		collection, table = s.fishObs, "fish_observation"
	}
	old, ok := collection[id]
	if !ok {
		writeAPIError(w, 404, "not_found", "ไม่พบ observation")
		return true
	}
	before := cloneMap(old)
	if r.Method == http.MethodDelete {
		if strings.TrimSpace(r.URL.Query().Get("reason")) == "" {
			writeAPIError(w, http.StatusUnprocessableEntity, "validation_error", "ต้องระบุ reason สำหรับการลบ observation")
			return true
		}
		old["deletedAt"] = time.Now().UTC().Format(time.RFC3339)
		s.auditLocked(r, "DELETE", table, id, before, old)
		writeJSON(w, 200, map[string]any{"status": "DELETED"})
		return true
	}
	input, err := readMap(r)
	if err != nil {
		writeAPIError(w, 400, "invalid_json", "ข้อมูล JSON ไม่ถูกต้อง")
		return true
	}
	if stringValue(input["overrideReason"]) == "" {
		writeAPIError(w, 422, "validation_error", "ต้องระบุ overrideReason")
		return true
	}
	for k, v := range input {
		if k != "id" {
			old[k] = v
		}
	}
	old["updatedAt"] = time.Now().UTC().Format(time.RFC3339)
	s.auditLocked(r, "UPDATE", table, id, before, old)
	writeJSON(w, 200, old)
	return true
}

func (s *apiServer) rollCall(w http.ResponseWriter, r *http.Request) bool {
	date := r.URL.Query().Get("date")
	if date == "" {
		date = time.Now().UTC().Format("2006-01-02")
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := []map[string]any{}
	for _, fish := range s.entities["fish"] {
		if stringValue(fish["status"]) != "ALIVE" {
			continue
		}
		dob, _ := time.Parse("2006-01-02", stringValue(fish["dob"]))
		observed, already := false, false
		for _, o := range s.fishObs {
			if stringValue(o["cloneFishId"]) == stringValue(fish["id"]) && stringValue(o["observedOn"]) == date && o["deletedAt"] == nil {
				observed = true
			}
		}
		already = observed
		items = append(items, map[string]any{"fishId": fish["id"], "fishCode": fish["fishCode"], "ageDays": int(time.Since(dob).Hours() / 24), "status": fish["status"], "condition": fish["condition"], "alreadyRecorded": already})
	}
	sortItems(items)
	writeJSON(w, 200, map[string]any{"date": date, "items": items})
	return true
}

func (s *apiServer) createFishObservations(w http.ResponseWriter, r *http.Request) bool {
	input, err := readMap(r)
	if err != nil {
		writeAPIError(w, 400, "invalid_json", "ข้อมูล JSON ไม่ถูกต้อง")
		return true
	}
	raw, ok := input["observations"].([]any)
	if !ok {
		writeAPIError(w, 422, "validation_error", "ต้องระบุ observations")
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	results := []any{}
	for _, value := range raw {
		item, ok := value.(map[string]any)
		if !ok {
			continue
		}
		client := stringValue(item["clientUuid"])
		if body, ok := s.idempotency["fish:"+client]; ok {
			var result any
			_ = json.Unmarshal(body, &result)
			results = append(results, result)
			continue
		}
		fish, ok := s.entities["fish"][stringValue(item["cloneFishId"])]
		if !ok {
			writeAPIError(w, 422, "validation_error", "ไม่พบปลา")
			return true
		}
		id := uuidV7()
		item["id"] = id
		item["operatorId"] = r.Header.Get("X-Operator-Id")
		s.fishObs[id] = item
		outcome := stringValue(item["outcome"])
		if outcome == "DEAD" || outcome == "FROZEN" || outcome == "DISCARDED" {
			fish["status"], fish["exitDate"], fish["exitReason"] = outcome, item["observedOn"], outcome
		}
		result := map[string]any{"clientUuid": client, "id": id, "status": "CREATED", "ageDays": ageDays(stringValue(fish["dob"])), "fishClosed": outcome != "ALIVE"}
		body, _ := json.Marshal(result)
		s.idempotency["fish:"+client] = body
		results = append(results, result)
		s.auditLocked(r, "INSERT", "fish_observation", id, nil, item)
	}
	writeJSON(w, 200, map[string]any{"results": results})
	return true
}

func ageDays(value string) int {
	dob, err := time.Parse("2006-01-02", value)
	if err != nil {
		return 0
	}
	return int(time.Since(dob).Hours() / 24)
}

func (s *apiServer) pendingCountLocked(now time.Time) int {
	count := 0
	for _, e := range s.entities["embryos"] {
		if e["exitReason"] != nil {
			continue
		}
		lot := s.entities["injection-lots"][stringValue(e["injectionLotId"])]
		activated, err := time.Parse(time.RFC3339, stringValue(lot["activatedAt"]))
		if err == nil && now.Sub(activated) >= 5*24*time.Hour {
			count++
		}
	}
	return count
}

func (s *apiServer) promotions(w http.ResponseWriter, r *http.Request, p []string) bool {
	if len(p) == 1 && p[0] == "pending" {
		s.mu.RLock()
		defer s.mu.RUnlock()
		items := []map[string]any{}
		now := time.Now().UTC()
		for _, e := range s.entities["embryos"] {
			if e["exitReason"] != nil || s.fishForEmbryoLocked(stringValue(e["id"])) != nil {
				continue
			}
			lot := s.entities["injection-lots"][stringValue(e["injectionLotId"])]
			activated, err := time.Parse(time.RFC3339, stringValue(lot["activatedAt"]))
			if err == nil && now.Sub(activated) >= 5*24*time.Hour {
				items = append(items, map[string]any{"embryoId": e["id"], "embryoCode": e["embryoCode"], "dob": activated.Format("2006-01-02"), "ageDays": int(now.Sub(activated).Hours() / 24), "suggestedFishCode": "No." + strconv.Itoa(s.fishNo), "suggestedRunningNo": s.fishNo})
			}
		}
		writeJSON(w, 200, map[string]any{"items": items})
		return true
	}
	if len(p) == 0 && r.Method == http.MethodPost {
		return s.createPromotions(w, r)
	}
	return false
}

func (s *apiServer) fishForEmbryoLocked(embryoID string) map[string]any {
	for _, fish := range s.entities["fish"] {
		if stringValue(fish["embryoId"]) == embryoID {
			return fish
		}
	}
	return nil
}

func (s *apiServer) createPromotions(w http.ResponseWriter, r *http.Request) bool {
	input, err := readMap(r)
	if err != nil {
		writeAPIError(w, 400, "invalid_json", "ข้อมูล JSON ไม่ถูกต้อง")
		return true
	}
	raw, _ := input["promotions"].([]any)
	s.mu.Lock()
	defer s.mu.Unlock()
	results := []any{}
	for _, value := range raw {
		item, ok := value.(map[string]any)
		if !ok {
			continue
		}
		client := stringValue(item["clientUuid"])
		if body, ok := s.idempotency["promotion:"+client]; ok {
			var result any
			_ = json.Unmarshal(body, &result)
			results = append(results, result)
			continue
		}
		embryo, ok := s.entities["embryos"][stringValue(item["embryoId"])]
		if !ok || embryo["exitReason"] != nil {
			writeAPIError(w, 422, "validation_error", "embryo ไม่พร้อมเลื่อนขั้น")
			return true
		}
		lot := s.entities["injection-lots"][stringValue(embryo["injectionLotId"])]
		activated, _ := time.Parse(time.RFC3339, stringValue(lot["activatedAt"]))
		id := uuidV7()
		fishCode := stringValue(item["fishCode"])
		if fishCode == "" {
			fishCode = "No." + strconv.Itoa(s.fishNo)
		}
		fish := map[string]any{"id": id, "embryoId": embryo["id"], "embryoCode": embryo["embryoCode"], "fishCode": fishCode, "runningNo": s.fishNo, "dob": activated.Format("2006-01-02"), "donorCellLineId": lot["donorCellLineId"], "status": "ALIVE", "condition": "NORMAL", "sex": "UNKNOWN", "finClipped": false, "active": true}
		if embryo["firstAbnormalStageCode"] != nil {
			fish["condition"] = "ABNORMAL"
			fish["firstAbnormalStageCode"] = embryo["firstAbnormalStageCode"]
		}
		s.fishNo++
		s.entities["fish"][id] = fish
		embryo["exitReason"], embryo["exitAt"] = "PROMOTED", time.Now().UTC().Format(time.RFC3339)
		result := map[string]any{"clientUuid": client, "id": id, "status": "CREATED", "fish": fish}
		body, _ := json.Marshal(result)
		s.idempotency["promotion:"+client] = body
		results = append(results, result)
		s.auditLocked(r, "INSERT", "clone_fish", id, nil, fish)
	}
	writeJSON(w, 200, map[string]any{"results": results})
	return true
}

func (s *apiServer) specimens(w http.ResponseWriter, r *http.Request, fishID string) bool {
	if r.Method == http.MethodGet {
		s.mu.RLock()
		defer s.mu.RUnlock()
		items := []map[string]any{}
		for _, item := range s.entities["specimens"] {
			if stringValue(item["cloneFishId"]) == fishID {
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
	s.mu.Lock()
	defer s.mu.Unlock()
	id := uuidV7()
	input["id"], input["cloneFishId"], input["createdAt"] = id, fishID, time.Now().UTC().Format(time.RFC3339)
	s.entities["specimens"][id] = input
	if input["markFinClipped"] == true {
		if fish := s.entities["fish"][fishID]; fish != nil {
			fish["finClipped"] = true
		}
	}
	s.auditLocked(r, "INSERT", "specimen", id, nil, input)
	writeJSON(w, 201, input)
	return true
}

func (s *apiServer) analytics(w http.ResponseWriter, r *http.Request, p []string) bool {
	if r.Method != http.MethodGet {
		return false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	switch strings.Join(p, "/") {
	case "kpi":
		returnJSON(w, map[string]any{"stage1": map[string]any{"nBatches": len(s.entities["batches"]), "nEggs": 0, "nActivated": len(s.entities["embryos"]), "nReachedShield": 0, "nReachedDay1": 0, "nPromoted": len(s.entities["fish"]), "pctNormal": 0, "pctAbnormal": 0}, "stage2": map[string]any{"nFish": len(s.entities["fish"]), "nAlive": countFish(s.entities["fish"], "ALIVE"), "nDead": countFish(s.entities["fish"], "DEAD"), "nFrozen": countFish(s.entities["fish"], "FROZEN"), "nDiscarded": countFish(s.entities["fish"], "DISCARDED"), "meanAgeDaysAlive": nil}})
	case "funnel", "survival", "timing-deviation", "abnormality-onset", "fish-survival", "observation-gaps", "pipeline":
		writeJSON(w, 200, map[string]any{"items": []any{}})
	default:
		return false
	}
	return true
}

func countFish(items map[string]map[string]any, status string) int {
	count := 0
	for _, item := range items {
		if stringValue(item["status"]) == status {
			count++
		}
	}
	return count
}

func sortItems(items []map[string]any) {
	sort.Slice(items, func(i, j int) bool {
		left := stringValue(items[i]["code"])
		if left == "" {
			left = stringValue(items[i]["batchCode"])
		}
		if left == "" {
			left = stringValue(items[i]["fishCode"])
		}
		if left == "" {
			left = stringValue(items[i]["id"])
		}
		right := stringValue(items[j]["code"])
		if right == "" {
			right = stringValue(items[j]["batchCode"])
		}
		if right == "" {
			right = stringValue(items[j]["fishCode"])
		}
		if right == "" {
			right = stringValue(items[j]["id"])
		}
		return strings.ToLower(left) < strings.ToLower(right)
	})
}

func (s *apiServer) exports(w http.ResponseWriter, r *http.Request, p []string) bool {
	if len(p) == 0 {
		return false
	}
	if p[0] == "r-table" {
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", "attachment; filename=chronofish-r-table.csv")
		writer := csv.NewWriter(w)
		_ = writer.Write([]string{"fish_code", "dob", "status", "condition"})
		s.mu.RLock()
		for _, fish := range s.entities["fish"] {
			_ = writer.Write([]string{stringValue(fish["fishCode"]), stringValue(fish["dob"]), stringValue(fish["status"]), stringValue(fish["condition"])})
		}
		s.mu.RUnlock()
		writer.Flush()
		return true
	}
	if p[0] == "excel" && r.Method == http.MethodPost {
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", "attachment; filename=chronofish-export.csv")
		_, _ = io.WriteString(w, "table,record_id\n")
		return true
	}
	return false
}

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
	suffix := strings.TrimPrefix(code, "stage_")
	n, _ := strconv.Atoi(strings.TrimLeft(strings.SplitN(suffix, "_", 2)[0], "0"))
	if n == 0 {
		n = 1
	}
	return n
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
func writeAPIError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, errorResponse{Error: errorBody{Code: code, Message: message}})
}

func uuidV7() string {
	var b [16]byte
	now := time.Now().UnixMilli()
	binary.BigEndian.PutUint64(b[:8], uint64(now))
	if _, err := rand.Read(b[8:]); err != nil {
		copy(b[8:], []byte(hex.EncodeToString([]byte(strconv.FormatInt(now, 10)))))
	}
	b[6] = (b[6] & 0x0f) | 0x70
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", binary.BigEndian.Uint32(b[:4]), binary.BigEndian.Uint16(b[4:6]), binary.BigEndian.Uint16(b[6:8]), binary.BigEndian.Uint16(b[8:10]), b[10:])
}

func newHandler(buildVersion, allowedOrigins string) http.Handler {
	server := newAPIServer()
	server.buildVersion = buildVersion
	handler := http.HandlerFunc(server.ServeHTTP)
	return withSecurity(withCORS(handler, allowedOrigins))
}

func withSecurity(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		defer func() {
			if recovered := recover(); recovered != nil {
				writeAPIError(w, 500, "internal_error", "เกิดข้อผิดพลาดภายในระบบ")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func withCORS(next http.Handler, allowedOrigins string) http.Handler {
	allowed := make(map[string]struct{})
	for _, origin := range strings.Split(allowedOrigins, ",") {
		if origin = strings.TrimSpace(origin); origin != "" {
			allowed[origin] = struct{}{}
		}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			w.Header().Add("Vary", "Origin")
		}
		if _, ok := allowed[origin]; ok {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Operator-Id, X-Device-Id, X-Idempotency-Key")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "-healthcheck" {
		response, err := http.Get("http://127.0.0.1:" + envOr("PORT", "8080") + "/api/v1/health")
		if err != nil || response.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		_ = response.Body.Close()
		return
	}
	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	server := &http.Server{Addr: ":" + cfg.port, Handler: newHandler(version, cfg.allowedOrigins), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
	log.Printf("ChronoFish API %s listening on %s", version, server.Addr)
	log.Fatal(server.ListenAndServe())
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

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
	if p[0] == "batches" {
		return s.batchRoute(w, r, p[1:])
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
	if resource == "protocols" && r.Method != http.MethodGet {
		writeAPIError(w, http.StatusMethodNotAllowed, "read_only", "protocol และ stage เป็นข้อมูลอ้างอิงแบบอ่านอย่างเดียว")
		return true
	}
	if resource == "protocols" && r.Method == http.MethodGet && len(p) == 0 {
		return s.listEntity(w, r, resource)
	}
	if resource == "timing-profiles" && r.Method == http.MethodGet && r.URL.Path == "/api/v1/timing-profiles/current" {
		return s.currentTiming(w, r)
	}
	if resource == "timing-profiles" && r.Method == http.MethodGet && len(p) == 0 && strings.TrimSpace(r.URL.Query().Get("protocolId")) == "" {
		writeAPIError(w, http.StatusBadRequest, "invalid_query", "protocolId is required")
		return true
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
		if !includeInactive && (item["active"] == false || item["deletedAt"] != nil) {
			continue
		}
		result := cloneMap(item)
		if resource == "fish" {
			s.enrichFishLocked(result)
			if !fishMatchesQuery(result, r.URL.Query()) {
				continue
			}
		}
		items = append(items, result)
	}
	if resource == "timing-profiles" {
		if protocolID := r.URL.Query().Get("protocolId"); protocolID != "" {
			filtered := items[:0]
			for _, item := range items {
				if stringValue(item["protocolId"]) == protocolID {
					filtered = append(filtered, item)
				}
			}
			items = filtered
		}
		sort.SliceStable(items, func(i, j int) bool { return intValue(items[i]["version"]) > intValue(items[j]["version"]) })
	} else {
		sortItems(items)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
	return true
}

func (s *apiServer) enrichFishLocked(fish map[string]any) {
	if fish == nil {
		return
	}
	embryo := s.entities["embryos"][stringValue(fish["embryoId"])]
	lot := s.entities["injection-lots"][stringValue(embryo["injectionLotId"])]
	if lot == nil {
		return
	}
	if donor := s.entities["donor-cell-lines"][stringValue(lot["donorCellLineId"])]; donor != nil {
		fish["strain"] = donor["strain"]
	}
	if batch := s.entities["batches"][stringValue(lot["batchId"])]; batch != nil {
		fish["treatmentGroupId"] = batch["treatmentGroupId"]
	}
}

func fishMatchesQuery(fish map[string]any, query map[string][]string) bool {
	first := func(key string) string {
		values := query[key]
		if len(values) == 0 {
			return ""
		}
		return values[0]
	}
	if value := first("siteId"); value != "" && stringValue(fish["siteId"]) != value {
		return false
	}
	if value := first("boxId"); value == "" {
		value = first("fishBoxId")
		if value != "" && stringValue(fish["fishBoxId"]) != value {
			return false
		}
	} else if stringValue(fish["fishBoxId"]) != value {
		return false
	}
	if value := first("status"); value != "" && stringValue(fish["status"]) != value {
		return false
	}
	if value := first("strain"); value != "" && !strings.Contains(strings.ToLower(stringValue(fish["strain"])), strings.ToLower(value)) {
		return false
	}
	if value := first("treatmentGroupId"); value != "" && stringValue(fish["treatmentGroupId"]) != value {
		return false
	}
	if value := first("dobFrom"); value != "" && stringValue(fish["dob"]) < value {
		return false
	}
	if value := first("dobTo"); value != "" && stringValue(fish["dob"]) > value {
		return false
	}
	return true
}

func (s *apiServer) getEntity(w http.ResponseWriter, resource, id string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.entities[resource][id]
	if !ok || item["deletedAt"] != nil || item["active"] == false {
		writeAPIError(w, http.StatusNotFound, "not_found", "ไม่พบรายการที่ร้องขอ")
		return true
	}
	result := cloneMap(item)
	if resource == "batches" {
		lots := make([]map[string]any, 0)
		for _, lot := range s.entities["injection-lots"] {
			if stringValue(lot["batchId"]) == id && lot["active"] != false && lot["deletedAt"] == nil {
				detail := cloneMap(lot)
				embryos := make([]map[string]any, 0)
				for _, embryo := range s.entities["embryos"] {
					if stringValue(embryo["injectionLotId"]) == stringValue(lot["id"]) && embryo["active"] != false && embryo["deletedAt"] == nil {
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
			if stringValue(embryo["injectionLotId"]) == id && embryo["active"] != false && embryo["deletedAt"] == nil {
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
			if stringValue(specimen["cloneFishId"]) == id && specimen["deletedAt"] == nil && specimen["active"] != false {
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
	for resource, field := range map[string]string{"operators": "siteId", "fish": "donorCellLineId"} {
		if stringValue(input[field]) == "" {
			continue
		}
		refResource := resource
		if resource == "operators" {
			refResource = "sites"
		} else {
			refResource = "donor-cell-lines"
		}
		ref := s.entities[refResource][stringValue(input[field])]
		if ref == nil || ref["active"] == false {
			writeAPIError(w, http.StatusUnprocessableEntity, "validation_error", "ไม่พบ "+field+" ที่ active")
			return true
		}
	}
	if err := validateEntityReferencesLocked(s, resource, input); err != nil {
		writeAPIError(w, 422, "validation_error", err.Error())
		return true
	}
	if resource == "fish" {
		if _, err := time.ParseInLocation("2006-01-02", stringValue(input["dob"]), bangkokLocation()); err != nil {
			writeAPIError(w, http.StatusUnprocessableEntity, "validation_error", "dob ต้องเป็นวันที่ YYYY-MM-DD")
			return true
		}
		if runningNo := intValue(input["runningNo"]); runningNo > 0 {
			for _, existing := range s.entities["fish"] {
				if intValue(existing["runningNo"]) == runningNo {
					writeAPIError(w, http.StatusConflict, "conflict", "runningNo ซ้ำ")
					return true
				}
			}
		}
		for field, refResource := range map[string]string{"siteId": "sites", "fishBoxId": "fish-boxes"} {
			if stringValue(input[field]) == "" {
				continue
			}
			ref := s.entities[refResource][stringValue(input[field])]
			if ref == nil || ref["active"] == false {
				writeAPIError(w, http.StatusUnprocessableEntity, "validation_error", "ไม่พบ "+field+" ที่ active")
				return true
			}
		}
	}
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
		s.setMutationCache(r, key, body)
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
	merged := cloneMap(item)
	for key, value := range input {
		if key != "id" {
			merged[key] = value
		}
	}
	if r.Method == http.MethodDelete {
		merged["active"] = false
	}
	if err := validateEntity(resource, merged); err != nil {
		writeAPIError(w, 422, "validation_error", err.Error())
		return true
	}
	if err := validateEntityReferencesLocked(s, resource, merged); err != nil {
		writeAPIError(w, 422, "validation_error", err.Error())
		return true
	}
	if resource == "embryos" {
		if stage := stringValue(merged["exitStageCode"]); stage != "" && (stageNumber(stage) < 1 || stageNumber(stage) > 36) {
			writeAPIError(w, 422, "validation_error", "exitStageCode is invalid")
			return true
		}
	}
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
	if r.Method == http.MethodDelete && resource == "embryos" {
		w.WriteHeader(http.StatusNoContent)
		return true
	}
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

func validateEntityReferencesLocked(s *apiServer, resource string, input map[string]any) error {
	references := map[string]map[string]string{
		"operators":      {"siteId": "sites"},
		"fish-boxes":     {"siteId": "sites"},
		"fish":           {"donorCellLineId": "donor-cell-lines", "siteId": "sites", "fishBoxId": "fish-boxes", "embryoId": "embryos"},
		"batches":        {"siteId": "sites", "operatorId": "operators", "protocolId": "protocols", "timingProfileId": "timing-profiles", "treatmentGroupId": "treatment-groups", "recipientEggLotId": "recipient-egg-lots", "csofLotId": "csof-lots"},
		"injection-lots": {"batchId": "batches", "donorCellLineId": "donor-cell-lines"},
		"embryos":        {"injectionLotId": "injection-lots"},
		"specimens":      {"cloneFishId": "fish"},
	}
	for field, refResource := range references[resource] {
		value := stringValue(input[field])
		if value == "" {
			continue
		}
		ref := s.entities[refResource][value]
		if ref == nil || ref["active"] == false || ref["deletedAt"] != nil {
			return fmt.Errorf("%s references an inactive or missing %s", field, refResource)
		}
	}
	if resource == "batches" {
		profile := s.entities["timing-profiles"][stringValue(input["timingProfileId"])]
		if profile != nil && stringValue(profile["protocolId"]) != stringValue(input["protocolId"]) {
			return errors.New("timingProfileId must belong to protocolId")
		}
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

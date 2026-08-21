package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/P-PrPas/ChronoFish/backend/internal/domain"
)

func (s *apiServer) promotions(w http.ResponseWriter, r *http.Request, p []string) bool {
	if len(p) == 1 && p[0] == "pending" {
		s.mu.RLock()
		defer s.mu.RUnlock()
		items := []map[string]any{}
		now := time.Now().UTC()
		for _, e := range s.entities["embryos"] {
			if e["active"] == false || e["deletedAt"] != nil || e["exitReason"] != nil || s.fishForEmbryoLocked(stringValue(e["id"])) != nil || s.latestEmbryoObservationLocked(stringValue(e["id"])) == nil || stringValue(s.latestEmbryoObservationLocked(stringValue(e["id"]))["outcome"]) != "ALIVE" {
				continue
			}
			lot := s.entities["injection-lots"][stringValue(e["injectionLotId"])]
			batch := s.entities["batches"][stringValue(lot["batchId"])]
			if lot == nil || lot["active"] == false || lot["deletedAt"] != nil || batch == nil || batch["active"] == false || batch["deletedAt"] != nil {
				continue
			}
			if wanted := firstQuery(r.URL.Query(), "siteId"); wanted != "" && wanted != stringValue(batch["siteId"]) {
				continue
			}
			activated, err := time.Parse(time.RFC3339, stringValue(lot["activatedAt"]))
			if err == nil && domain.PromotionEligibleAt(e["exitReason"] != nil, true, activated, now, s.promotionThresholdLocked(batch)) {
				latest := s.latestEmbryoObservationLocked(stringValue(e["id"]))
				donor := s.entities["donor-cell-lines"][stringValue(lot["donorCellLineId"])]
				strain := stringValue(donor["strain"])
				runningNo := s.nextFishRunningNoLocked() + len(items)
				items = append(items, map[string]any{"embryoId": e["id"], "embryoCode": e["embryoCode"], "batchCode": batch["batchCode"], "siteId": batch["siteId"], "dob": activated.In(bangkokLocation()).Format("2006-01-02"), "ageDays": calendarAge(activated, now), "strain": strain, "condition": latest["condition"], "firstAbnormalOn": e["firstAbnormalOn"], "firstAbnormalAgeDays": e["firstAbnormalAgeDays"], "firstAbnormalStageCode": e["firstAbnormalStageCode"], "firstAbnormalStageLabel": stageLabel(stageNumber(stringValue(e["firstAbnormalStageCode"]))), "suggestedFishCode": s.promotionFishCodeForRunning(e, strain, activated, runningNo), "suggestedRunningNo": runningNo})
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
		if fish["active"] != false && fish["deletedAt"] == nil && stringValue(fish["embryoId"]) == embryoID {
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
	raw, ok := input["promotions"].([]any)
	if !ok || len(raw) == 0 {
		writeAPIError(w, http.StatusUnprocessableEntity, "validation_error", "ต้องระบุ promotions อย่างน้อยหนึ่งรายการ")
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
		if client == "" || !isUUID(client) {
			results = append(results, map[string]any{"clientUuid": client, "status": "rejected", "error": map[string]any{"message": "clientUuid ต้องเป็น UUID"}})
			continue
		}
		if body, ok := s.mutationCacheGet(r, "promotion:"+client); ok {
			var result any
			_ = json.Unmarshal(body, &result)
			results = append(results, result)
			continue
		}
		embryo, ok := s.entities["embryos"][stringValue(item["embryoId"])]
		latest := s.latestEmbryoObservationLocked(stringValue(item["embryoId"]))
		lot := s.entities["injection-lots"][stringValue(embryo["injectionLotId"])]
		batch := s.entities["batches"][stringValue(lot["batchId"])]
		activated, activatedErr := time.Parse(time.RFC3339, stringValue(lot["activatedAt"]))
		eligible := ok && embryo["active"] != false && embryo["deletedAt"] == nil && lot != nil && lot["active"] != false && lot["deletedAt"] == nil && batch != nil && batch["active"] != false && batch["deletedAt"] == nil && activatedErr == nil && domain.PromotionEligibleAt(embryo["exitReason"] != nil, latest != nil && stringValue(latest["outcome"]) == "ALIVE", activated, time.Now().UTC(), s.promotionThresholdLocked(batch))
		if !eligible {
			result := map[string]any{"clientUuid": client, "status": "rejected", "error": map[string]any{"message": "embryo ยังไม่เข้าเกณฑ์เลื่อนขั้น"}}
			body, _ := json.Marshal(result)
			s.setMutationCache(r, "promotion:"+client, body)
			results = append(results, result)
			continue
		}
		if s.fishForEmbryoLocked(stringValue(embryo["id"])) != nil {
			result := map[string]any{"clientUuid": client, "status": "duplicate", "id": s.fishForEmbryoLocked(stringValue(embryo["id"]))["id"]}
			body, _ := json.Marshal(result)
			s.setMutationCache(r, "promotion:"+client, body)
			results = append(results, result)
			continue
		}
		id := uuidV7()
		fishCode := stringValue(item["fishCode"])
		if fishCode == "" {
			donor := s.entities["donor-cell-lines"][stringValue(lot["donorCellLineId"])]
			fishCode = s.promotionFishCodeLocked(embryo, stringValue(donor["strain"]), activated)
		}
		if s.fishCodeExistsLocked(fishCode) {
			result := map[string]any{"clientUuid": client, "status": "rejected", "error": map[string]any{"message": "fishCode ซ้ำกับรายการเดิม"}}
			body, _ := json.Marshal(result)
			s.setMutationCache(r, "promotion:"+client, body)
			results = append(results, result)
			continue
		}
		runningNo := s.nextFishRunningNoLocked()
		fish := map[string]any{"id": id, "embryoId": embryo["id"], "embryoCode": embryo["embryoCode"], "fishCode": fishCode, "runningNo": runningNo, "dob": activated.In(bangkokLocation()).Format("2006-01-02"), "donorCellLineId": lot["donorCellLineId"], "siteId": batch["siteId"], "fishBoxId": item["fishBoxId"], "status": "ALIVE", "condition": stringValue(latest["condition"]), "sex": "UNKNOWN", "finClipped": false, "active": true, "remarks": item["remarks"]}
		for _, field := range []string{"firstAbnormalOn", "firstAbnormalAgeDays", "firstAbnormalStageCode", "firstAbnormalStageId"} {
			if value, exists := embryo[field]; exists {
				fish[field] = value
			}
		}
		if stringValue(embryo["firstAbnormalOn"]) != "" {
			fish["firstAbnormalSource"] = "embryo"
		}
		if fish["condition"] == "" {
			fish["condition"] = "NORMAL"
		}
		if embryo["firstAbnormalStageCode"] != nil {
			fish["condition"] = "ABNORMAL"
			fish["firstAbnormalStageCode"] = embryo["firstAbnormalStageCode"]
		}
		s.fishNo = runningNo + 1
		s.entities["fish"][id] = fish
		beforeEmbryo := cloneMap(embryo)
		embryo["exitReason"], embryo["exitAt"] = "PROMOTED", time.Now().UTC().Format(time.RFC3339)
		result := map[string]any{"clientUuid": client, "id": id, "status": "created", "fish": fish}
		body, _ := json.Marshal(result)
		s.setMutationCache(r, "promotion:"+client, body)
		results = append(results, result)
		s.auditLocked(r, "INSERT", "clone_fish", id, nil, fish)
		s.auditLocked(r, "UPDATE", "embryo", stringValue(embryo["id"]), beforeEmbryo, embryo)
	}
	writeJSON(w, 201, map[string]any{"items": results})
	return true
}

func (s *apiServer) promotionThresholdLocked(batch map[string]any) int {
	if batch == nil {
		return 5
	}
	protocol := s.entities["protocols"][stringValue(batch["protocolId"])]
	if threshold := intValue(protocol["stage1MaxAgeDays"]); threshold > 0 {
		return threshold
	}
	return 5
}

func (s *apiServer) promotionFishCodeLocked(embryo map[string]any, strain string, activated time.Time) string {
	return s.promotionFishCodeForRunning(embryo, strain, activated, s.nextFishRunningNoLocked())
}

func (s *apiServer) promotionFishCodeForRunning(embryo map[string]any, strain string, activated time.Time, runningNo int) string {
	if strain == "" {
		strain = "unknown"
	}
	day := activated.In(bangkokLocation()).Format("02")
	return fmt.Sprintf("No.%d_Clone%d-%s cell-%s", runningNo, intValue(embryo["seqInLot"]), strain, day)
}

func (s *apiServer) nextFishRunningNoLocked() int {
	next := 1
	for _, fish := range s.entities["fish"] {
		if fish["deletedAt"] != nil || fish["active"] == false {
			continue
		}
		if candidate := intValue(fish["runningNo"]) + 1; candidate > next {
			next = candidate
		}
	}
	return next
}

func (s *apiServer) fishCodeExistsLocked(code string) bool {
	for _, fish := range s.entities["fish"] {
		if strings.EqualFold(strings.TrimSpace(stringValue(fish["fishCode"])), strings.TrimSpace(code)) {
			return true
		}
	}
	return false
}

func (s *apiServer) specimens(w http.ResponseWriter, r *http.Request, fishID string) bool {
	if r.Method == http.MethodGet {
		s.mu.RLock()
		defer s.mu.RUnlock()
		items := []map[string]any{}
		for _, item := range s.entities["specimens"] {
			if item["active"] != false && item["deletedAt"] == nil && stringValue(item["cloneFishId"]) == fishID {
				items = append(items, cloneMap(item))
			}
		}
		writeJSON(w, 200, map[string]any{"items": items})
		return true
	}
	s.mu.RLock()
	fishExists := s.entities["fish"][fishID] != nil
	s.mu.RUnlock()
	if !fishExists {
		writeAPIError(w, http.StatusNotFound, "not_found", "ไม่พบปลา")
		return true
	}
	input, err := readMap(r)
	if err != nil {
		writeAPIError(w, 400, "invalid_json", "ข้อมูล JSON ไม่ถูกต้อง")
		return true
	}
	normalizeMap(input)
	for _, field := range []string{"specimenCode", "specimenKind", "specimenType"} {
		if stringValue(input[field]) == "" {
			writeAPIError(w, http.StatusUnprocessableEntity, "validation_error", "ต้องระบุ "+field)
			return true
		}
	}
	if stringValue(input["specimenKind"]) != "CL" && stringValue(input["specimenKind"]) != "RT" && stringValue(input["specimenKind"]) != "DC" {
		writeAPIError(w, http.StatusUnprocessableEntity, "validation_error", "specimenKind ไม่ถูกต้อง")
		return true
	}
	if stringValue(input["specimenType"]) != "WHOLE_EMBRYO" && stringValue(input["specimenType"]) != "CAUDAL_FIN_CLIP" {
		writeAPIError(w, http.StatusUnprocessableEntity, "validation_error", "specimenType ไม่ถูกต้อง")
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	beforeFish := cloneMap(s.entities["fish"][fishID])
	id := uuidV7()
	input["id"], input["cloneFishId"], input["createdAt"] = id, fishID, time.Now().UTC().Format(time.RFC3339)
	s.entities["specimens"][id] = input
	if input["markFinClipped"] == true {
		if fish := s.entities["fish"][fishID]; fish != nil {
			fish["finClipped"] = true
		}
	}
	s.auditLocked(r, "INSERT", "specimen", id, nil, input)
	s.auditChangedFishLocked(r, fishID, beforeFish)
	writeJSON(w, 201, input)
	return true
}

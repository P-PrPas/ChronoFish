package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"reflect"
	"sort"
	"strings"
	"time"

	"github.com/P-PrPas/ChronoFish/backend/internal/domain"
)

func (s *apiServer) dueCheckpoints(w http.ResponseWriter, r *http.Request) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	now := time.Now().UTC()
	query := r.URL.Query()
	items := []map[string]any{}
	upcoming := []map[string]any{}
	observedStages := make(map[string]map[string]struct{})
	for _, observation := range s.observations {
		if observation["deletedAt"] != nil {
			continue
		}
		lotID := stringValue(observation["injectionLotId"])
		stage := stringValue(observation["stageCode"])
		if lotID != "" && stage != "" {
			if observedStages[lotID] == nil {
				observedStages[lotID] = make(map[string]struct{})
			}
			observedStages[lotID][stage] = struct{}{}
		}
	}
	for _, lot := range s.entities["injection-lots"] {
		if lot["active"] == false || lot["deletedAt"] != nil || !s.lotHasActiveEmbryoLocked(stringValue(lot["id"])) {
			continue
		}
		batch := s.entities["batches"][stringValue(lot["batchId"])]
		if batch == nil || batch["active"] == false || batch["deletedAt"] != nil {
			continue
		}
		if wanted := firstQuery(query, "siteId"); wanted != "" && wanted != stringValue(batch["siteId"]) {
			continue
		}
		if wanted := firstQuery(query, "operatorId"); wanted != "" && wanted != stringValue(batch["operatorId"]) {
			continue
		}
		activated, err := time.Parse(time.RFC3339, stringValue(lot["activatedAt"]))
		if err != nil {
			continue
		}
		for stage := 1; stage <= 26; stage++ {
			code := stageCode(stage)
			due := activated.Add(time.Duration(s.expectedHPAForLotLocked(lot, code) * float64(time.Hour)))
			_, observed := observedStages[stringValue(lot["id"])][code]
			if !observed {
				minutes := int(now.Sub(due).Minutes())
				embryosRemaining := s.activeEmbryoCountLocked(stringValue(lot["id"]))
				if minutes >= 0 {
					items = append(items, map[string]any{"injectionLotId": lot["id"], "batchCode": batch["batchCode"], "lotNo": lot["lotNo"], "stageCode": code, "stageLabel": stageLabel(stage), "stageOrder": stage, "dueAt": due.Format(time.RFC3339), "minutesLate": minutes, "urgency": minutes, "embryosRemaining": embryosRemaining})
				} else if len(upcoming) == 0 || stringValue(upcoming[len(upcoming)-1]["injectionLotId"]) != stringValue(lot["id"]) {
					upcoming = append(upcoming, map[string]any{"injectionLotId": lot["id"], "batchCode": batch["batchCode"], "lotNo": lot["lotNo"], "stageCode": code, "stageLabel": stageLabel(stage), "stageOrder": stage, "dueAt": due.Format(time.RFC3339), "minutesLate": minutes, "urgency": minutes, "embryosRemaining": embryosRemaining})
				}
			}
		}
	}
	sort.SliceStable(items, func(i, j int) bool { return intValue(items[i]["minutesLate"]) > intValue(items[j]["minutesLate"]) })
	sort.SliceStable(upcoming, func(i, j int) bool { return stringValue(upcoming[i]["dueAt"]) < stringValue(upcoming[j]["dueAt"]) })
	writeJSON(w, 200, map[string]any{"overdue": items, "upcoming": upcoming, "pendingPromotionCount": s.pendingCountLocked(now)})
	return true
}

func (s *apiServer) lotHasActiveEmbryoLocked(lotID string) bool {
	for _, embryo := range s.entities["embryos"] {
		if stringValue(embryo["injectionLotId"]) == lotID && embryo["active"] != false && embryo["deletedAt"] == nil {
			return true
		}
	}
	return false
}

func (s *apiServer) activeEmbryoCountLocked(lotID string) int {
	count := 0
	for _, embryo := range s.entities["embryos"] {
		if stringValue(embryo["injectionLotId"]) == lotID && embryo["active"] != false && embryo["deletedAt"] == nil && embryo["exitReason"] == nil {
			count++
		}
	}
	return count
}

func (s *apiServer) checkpoint(w http.ResponseWriter, r *http.Request, lotID, stageCode string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	lot, ok := s.entities["injection-lots"][lotID]
	if !ok || lot["active"] == false || lot["deletedAt"] != nil {
		writeAPIError(w, 404, "not_found", "ไม่พบ injection lot")
		return true
	}
	batch := s.entities["batches"][stringValue(lot["batchId"])]
	embryos := []map[string]any{}
	for _, e := range s.entities["embryos"] {
		if stringValue(e["injectionLotId"]) == lotID && e["active"] != false && e["exitReason"] == nil {
			condition := "NORMAL"
			if latest := s.latestEmbryoObservationLocked(stringValue(e["id"])); latest != nil && stringValue(latest["condition"]) != "" {
				condition = stringValue(latest["condition"])
			}
			embryos = append(embryos, map[string]any{"embryoId": e["id"], "embryoCode": e["embryoCode"], "wellPosition": e["wellPosition"], "defaultCondition": condition, "firstAbnormalStageLabel": e["firstAbnormalStageCode"]})
		}
	}
	activated := stringValue(lot["activatedAt"])
	expected := s.expectedHPAForLotLocked(lot, stageCode)
	dueAt := activated
	if parsed, err := time.Parse(time.RFC3339, activated); err == nil {
		dueAt = parsed.Add(time.Duration(expected * float64(time.Hour))).Format(time.RFC3339)
	}
	writeJSON(w, 200, map[string]any{"injectionLotId": lotID, "batchCode": batch["batchCode"], "lotNo": lot["lotNo"], "stage": map[string]any{"code": stageCode, "label": stageLabel(stageNumber(stageCode)), "stageOrder": stageNumber(stageCode)}, "activatedAt": activated, "expectedHpa": expected, "dueAt": dueAt, "totalEmbryos": len(embryos), "embryosRemaining": len(embryos), "embryos": embryos})
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
			results = append(results, map[string]any{"status": "rejected", "error": map[string]any{"message": "รูปแบบ observation ไม่ถูกต้อง"}})
			continue
		}
		client := stringValue(item["clientUuid"])
		if client == "" {
			results = append(results, map[string]any{"status": "rejected", "error": map[string]any{"message": "ต้องระบุ clientUuid"}})
			continue
		}
		if old, ok := s.idempotency["embryo:"+client]; ok {
			var oldResult any
			_ = json.Unmarshal(old, &oldResult)
			results = append(results, oldResult)
			continue
		}
		if existing := s.existingEmbryoObservationLocked(stringValue(item["embryoId"]), stringValue(item["stageCode"])); existing != nil {
			results = append(results, map[string]any{"clientUuid": client, "id": existing["id"], "status": "duplicate", "hpaActual": existing["hpaActual"], "hpaExpected": existing["hpaExpectedSnapshot"], "deviationH": existing["deviationH"]})
			continue
		}
		if err := s.validateEmbryoObservation(item); err != nil {
			results = append(results, map[string]any{"clientUuid": client, "status": "rejected", "error": map[string]any{"message": err.Error()}})
			continue
		}
		embryo := s.entities["embryos"][stringValue(item["embryoId"])]
		lot := s.entities["injection-lots"][stringValue(embryo["injectionLotId"])]
		observedAt, _ := time.Parse(time.RFC3339, stringValue(item["observedAt"]))
		activated, _ := time.Parse(time.RFC3339, stringValue(lot["activatedAt"]))
		actual := round4(observedAt.Sub(activated).Hours())
		expected := round4(s.expectedHPAForEmbryoLocked(map[string]any{"embryoId": embryo["id"], "stageCode": item["stageCode"]}))
		deviation := round4(actual - expected)
		id := uuidV7()
		result := map[string]any{"clientUuid": client, "id": id, "status": "created", "hpaActual": actual, "hpaExpected": expected, "deviationH": deviation, "deviationLabel": deviationLabel(deviation)}
		obs := cloneMap(item)
		now := time.Now().UTC()
		obs["id"], obs["injectionLotId"], obs["hpaActual"], obs["hpaExpectedSnapshot"], obs["deviationH"], obs["operatorId"], obs["deviceId"], obs["isBackdated"], obs["createdAt"] = id, lot["id"], actual, expected, deviation, r.Header.Get("X-Operator-Id"), r.Header.Get("X-Device-Id"), isBackdated(observedAt, now), now.Format(time.RFC3339)
		if intervalActual, intervalExpected, intervalDeviation, ok := s.intervalMetricsLocked(stringValue(embryo["id"]), stageNumber(stringValue(item["stageCode"])), actual, expected, ""); ok {
			obs["intervalActual"], obs["intervalExpected"], obs["intervalDeviationH"] = intervalActual, intervalExpected, intervalDeviation
			result["intervalActual"], result["intervalExpected"], result["intervalDeviationH"] = intervalActual, intervalExpected, intervalDeviation
		}
		staged = append(staged, obs)
		results = append(results, result)
	}
	touchedEmbryos := make(map[string]bool)
	for _, obs := range staged {
		s.observations[stringValue(obs["id"])] = obs
		s.auditLocked(r, "INSERT", "embryo_observation", stringValue(obs["id"]), nil, obs)
		touchedEmbryos[stringValue(obs["embryoId"])] = true
	}
	for embryoID := range touchedEmbryos {
		before := cloneMap(s.entities["embryos"][embryoID])
		s.recomputeEmbryoLocked(embryoID)
		s.auditChangedEmbryoLocked(r, embryoID, before)
	}
	for i, result := range results {
		item, _ := result.(map[string]any)
		body, _ := json.Marshal(item)
		s.setMutationCache(r, "embryo:"+stringValue(item["clientUuid"]), body)
		results[i] = item
	}
	writeJSON(w, 200, map[string]any{"results": results})
	return true
}

func (s *apiServer) existingEmbryoObservationLocked(embryoID, stageCode string) map[string]any {
	for _, observation := range s.observations {
		if observation["deletedAt"] == nil && stringValue(observation["embryoId"]) == embryoID && stringValue(observation["stageCode"]) == stageCode {
			return observation
		}
	}
	return nil
}

func (s *apiServer) validateEmbryoObservation(item map[string]any) error {
	for _, f := range []string{"embryoId", "stageCode", "observedAt", "outcome", "condition"} {
		if stringValue(item[f]) == "" {
			return fmt.Errorf("ต้องระบุ %s", f)
		}
	}
	embryo, ok := s.entities["embryos"][stringValue(item["embryoId"])]
	if !ok || embryo["active"] == false || embryo["deletedAt"] != nil {
		return errors.New("ไม่พบ embryo")
	}
	if stageNumber(stringValue(item["stageCode"])) < 1 || stageNumber(stringValue(item["stageCode"])) > 36 {
		return errors.New("stageCode ไม่ถูกต้อง")
	}
	lot := s.entities["injection-lots"][stringValue(embryo["injectionLotId"])]
	if lot == nil || lot["active"] == false || lot["deletedAt"] != nil {
		return errors.New("injection lot is inactive or missing")
	}
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

func legacyDeviationLabel(value float64) string {
	minutes := int(value * 60)
	if minutes >= 0 {
		return fmt.Sprintf("ช้ากว่าสากล %d นาที", minutes)
	}
	return fmt.Sprintf("เร็วกว่าสากล %d นาที", -minutes)
}

func deviationLabel(value float64) string {
	if math.Abs(value) < 1.0/60.0 {
		return "ตรงกับสากล"
	}
	minutes := int(math.Round(math.Abs(value) * 60))
	direction := "ช้ากว่าสากล"
	if value < 0 {
		direction = "เร็วกว่าสากล"
	}
	if minutes < 60 {
		return fmt.Sprintf("%s %d นาที", direction, minutes)
	}
	return fmt.Sprintf("%s %d ชม. %d นาที", direction, minutes/60, minutes%60)
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
		reason := strings.TrimSpace(r.URL.Query().Get("reason"))
		if reason == "" {
			writeAPIError(w, http.StatusUnprocessableEntity, "validation_error", "reason is required")
			return true
		}
		old["deletedAt"] = time.Now().UTC().Format(time.RFC3339)
		old["overrideReason"] = reason
		if fish {
			fishID := stringValue(old["cloneFishId"])
			beforeFish := cloneMap(s.entities["fish"][fishID])
			s.recomputeFishLocked(stringValue(old["cloneFishId"]))
			s.auditChangedFishLocked(r, fishID, beforeFish)
		} else {
			beforeEmbryo := cloneMap(s.entities["embryos"][stringValue(old["embryoId"])])
			s.recomputeEmbryoLocked(stringValue(old["embryoId"]))
			s.auditChangedEmbryoLocked(r, stringValue(old["embryoId"]), beforeEmbryo)
		}
		s.auditLocked(r, "DELETE", table, id, before, old)
		w.WriteHeader(http.StatusNoContent)
		return true
	}
	input, err := readMap(r)
	if err != nil {
		writeAPIError(w, 400, "invalid_json", "ข้อมูล JSON ไม่ถูกต้อง")
		return true
	}
	correctionReason := stringValue(input["correctionReason"])
	if correctionReason == "" {
		correctionReason = stringValue(input["overrideReason"])
	}
	if correctionReason == "" {
		writeAPIError(w, 422, "validation_error", "ต้องระบุ correctionReason")
		return true
	}
	input["overrideReason"] = correctionReason
	if fish {
		if value, ok := input["outcome"]; ok && !validFishOutcome(stringValue(value)) {
			writeAPIError(w, 422, "validation_error", "invalid fish outcome")
			return true
		}
		if value, ok := input["condition"]; ok && !validCondition(stringValue(value)) {
			writeAPIError(w, 422, "validation_error", "invalid condition")
			return true
		}
		if value, ok := input["observedOn"]; ok {
			observedOn, err := time.ParseInLocation("2006-01-02", stringValue(value), bangkokLocation())
			if err != nil {
				writeAPIError(w, 422, "validation_error", "invalid observedOn")
				return true
			}
			if dob := stringValue(s.entities["fish"][stringValue(old["cloneFishId"])]["dob"]); dob != "" && stringValue(value) < dob {
				writeAPIError(w, 422, "validation_error", "observedOn ต้องไม่ก่อนวันเกิดปลา")
				return true
			}
			if observedOn.After(bangkokDateStart(time.Now())) {
				writeAPIError(w, 422, "validation_error", "observedOn ห้ามเป็นวันที่ในอนาคต")
				return true
			}
		}
	} else {
		if value, ok := input["outcome"]; ok && value != nil && stringValue(value) != "ALIVE" && stringValue(value) != "DEAD" && stringValue(value) != "DEGENERATED" && stringValue(value) != "NOT_OBSERVED" {
			writeAPIError(w, 422, "validation_error", "invalid embryo outcome")
			return true
		}
		if value, ok := input["condition"]; ok && value != nil && !validCondition(stringValue(value)) {
			writeAPIError(w, 422, "validation_error", "invalid condition")
			return true
		}
		if value, ok := input["observedAt"]; ok {
			observedAt, parseErr := time.Parse(time.RFC3339, stringValue(value))
			if parseErr != nil {
				writeAPIError(w, 422, "validation_error", "invalid observedAt")
				return true
			}
			embryo := s.entities["embryos"][stringValue(old["embryoId"])]
			lot := s.entities["injection-lots"][stringValue(embryo["injectionLotId"])]
			activated, activatedErr := time.Parse(time.RFC3339, stringValue(lot["activatedAt"]))
			if activatedErr != nil || observedAt.Before(activated) || observedAt.After(time.Now().UTC().Add(5*time.Minute)) {
				writeAPIError(w, 422, "validation_error", "observedAt อยู่นอกช่วง activation ถึงปัจจุบัน")
				return true
			}
		}
	}
	for k, v := range input {
		if k != "id" && k != "correctionReason" {
			old[k] = v
		}
	}
	if !fish {
		if _, observedAtChanged := input["observedAt"]; observedAtChanged {
			old["hpaExpectedSnapshot"] = s.expectedHPAForEmbryoLocked(old)
		}
	}
	if fish {
		if observedOn := stringValue(old["observedOn"]); observedOn != "" {
			old["ageDays"] = ageDaysOn(stringValue(s.entities["fish"][stringValue(old["cloneFishId"])]["dob"]), observedOn)
		}
	} else if observedAt, parseErr := time.Parse(time.RFC3339, stringValue(old["observedAt"])); parseErr == nil {
		if embryo := s.entities["embryos"][stringValue(old["embryoId"])]; embryo != nil {
			if lot := s.entities["injection-lots"][stringValue(embryo["injectionLotId"])]; lot != nil {
				if activated, activatedErr := time.Parse(time.RFC3339, stringValue(lot["activatedAt"])); activatedErr == nil {
					actual := round4(observedAt.Sub(activated).Hours())
					old["hpaActual"] = actual
					old["deviationH"] = round4(actual - numberValue(old["hpaExpectedSnapshot"]))
					if intervalActual, intervalExpected, intervalDeviation, ok := s.intervalMetricsLocked(stringValue(old["embryoId"]), stageNumber(stringValue(old["stageCode"])), actual, numberValue(old["hpaExpectedSnapshot"]), stringValue(old["id"])); ok {
						old["intervalActual"], old["intervalExpected"], old["intervalDeviationH"] = intervalActual, intervalExpected, intervalDeviation
					} else {
						delete(old, "intervalActual")
						delete(old, "intervalExpected")
						delete(old, "intervalDeviationH")
					}
				}
			}
		}
	}
	old["updatedAt"] = time.Now().UTC().Format(time.RFC3339)
	if fish {
		beforeFish := cloneMap(s.entities["fish"][stringValue(old["cloneFishId"])])
		s.recomputeFishLocked(stringValue(old["cloneFishId"]))
		s.auditChangedFishLocked(r, stringValue(old["cloneFishId"]), beforeFish)
	} else {
		beforeEmbryo := cloneMap(s.entities["embryos"][stringValue(old["embryoId"])])
		s.recomputeEmbryoLocked(stringValue(old["embryoId"]))
		s.auditChangedEmbryoLocked(r, stringValue(old["embryoId"]), beforeEmbryo)
	}
	s.auditLocked(r, "UPDATE", table, id, before, old)
	writeJSON(w, 200, old)
	return true
}

func (s *apiServer) auditChangedEmbryoLocked(r *http.Request, id string, before map[string]any) {
	after := s.entities["embryos"][id]
	if after != nil && !reflect.DeepEqual(before, after) {
		s.auditLocked(r, "UPDATE", "embryo", id, before, after)
	}
}

func (s *apiServer) auditChangedFishLocked(r *http.Request, id string, before map[string]any) {
	after := s.entities["fish"][id]
	if after != nil && !reflect.DeepEqual(before, after) {
		s.auditLocked(r, "UPDATE", "clone_fish", id, before, after)
	}
}

func (s *apiServer) expectedHPAForEmbryoLocked(observation map[string]any) float64 {
	embryo := s.entities["embryos"][stringValue(observation["embryoId"])]
	lot := s.entities["injection-lots"][stringValue(embryo["injectionLotId"])]
	return s.expectedHPAForLotLocked(lot, stringValue(observation["stageCode"]))
}

func (s *apiServer) expectedHPAForLotLocked(lot map[string]any, stageCode string) float64 {
	batch := s.entities["batches"][stringValue(lot["batchId"])]
	profile := s.entities["timing-profiles"][stringValue(batch["timingProfileId"])]
	if entries, ok := profile["entries"].([]any); ok {
		for _, value := range entries {
			entry, ok := value.(map[string]any)
			if ok && stringValue(entry["stageCode"]) == stageCode {
				return numberValue(entry["expectedHpa"])
			}
		}
	}
	return expectedHPA(stageCode)
}

// intervalMetricsLocked returns the difference from the nearest earlier
// recorded checkpoint for the same embryo. Missing checkpoints do not invent
// an interval; the next observed checkpoint is compared with the last one
// that actually exists.
func (s *apiServer) intervalMetricsLocked(embryoID string, stage int, actual, expected float64, excludeID string) (float64, float64, float64, bool) {
	var previous map[string]any
	previousStage := 0
	for _, observation := range s.observations {
		if observation["deletedAt"] != nil || stringValue(observation["embryoId"]) != embryoID || stringValue(observation["id"]) == excludeID {
			continue
		}
		candidateStage := stageNumber(stringValue(observation["stageCode"]))
		if candidateStage < 1 || candidateStage >= stage || candidateStage <= previousStage {
			continue
		}
		previous, previousStage = observation, candidateStage
	}
	if previous == nil {
		return 0, 0, 0, false
	}
	intervalActual := round4(actual - numberValue(previous["hpaActual"]))
	intervalExpected := round4(expected - numberValue(previous["hpaExpectedSnapshot"]))
	return intervalActual, intervalExpected, round4(intervalActual - intervalExpected), true
}

func (s *apiServer) recomputeFishLocked(fishID string) {
	fish := s.entities["fish"][fishID]
	if fish == nil {
		return
	}
	latestDate := ""
	latestOutcome := "ALIVE"
	latestCondition := "NORMAL"
	var firstAbnormal map[string]any
	firstAbnormalDate := ""
	var inherited map[string]any
	if embryo := s.entities["embryos"][stringValue(fish["embryoId"])]; embryo != nil && stringValue(embryo["firstAbnormalOn"]) != "" {
		inherited = map[string]any{
			"firstAbnormalOn":        embryo["firstAbnormalOn"],
			"firstAbnormalAgeDays":   embryo["firstAbnormalAgeDays"],
			"firstAbnormalStageCode": embryo["firstAbnormalStageCode"],
			"firstAbnormalStageId":   embryo["firstAbnormalStageId"],
		}
	}
	for _, observation := range s.fishObs {
		if observation["deletedAt"] != nil || stringValue(observation["cloneFishId"]) != fishID {
			continue
		}
		observedOn := stringValue(observation["observedOn"])
		if observedOn >= latestDate {
			latestDate, latestOutcome, latestCondition = observedOn, stringValue(observation["outcome"]), stringValue(observation["condition"])
		}
		if stringValue(observation["condition"]) == "ABNORMAL" && (firstAbnormal == nil || stringValue(observation["observedOn"]) < firstAbnormalDate) {
			firstAbnormal, firstAbnormalDate = observation, stringValue(observation["observedOn"])
		}
	}
	if latestCondition != "" {
		fish["condition"] = latestCondition
	}
	if latestOutcome == "ALIVE" || latestDate == "" {
		fish["status"] = "ALIVE"
		delete(fish, "exitDate")
		delete(fish, "exitReason")
	} else {
		fish["status"], fish["exitDate"], fish["exitReason"] = latestOutcome, latestDate, latestOutcome
	}
	if firstAbnormal != nil {
		inheritedDate := stringValue(inherited["firstAbnormalOn"])
		if inheritedDate == "" || firstAbnormalDate < inheritedDate {
			fish["firstAbnormalOn"] = firstAbnormalDate
			fish["firstAbnormalAgeDays"] = ageDaysOn(stringValue(fish["dob"]), firstAbnormalDate)
			fish["firstAbnormalSource"] = "fish"
		} else if inherited != nil {
			for key, value := range inherited {
				fish[key] = value
			}
			fish["firstAbnormalSource"] = "embryo"
		}
	} else {
		if inherited != nil {
			for key, value := range inherited {
				fish[key] = value
			}
			fish["firstAbnormalSource"] = "embryo"
		} else if stringValue(fish["firstAbnormalSource"]) == "fish" {
			for _, field := range []string{"firstAbnormalOn", "firstAbnormalAgeDays", "firstAbnormalSource", "firstAbnormalStageCode", "firstAbnormalStageId"} {
				delete(fish, field)
			}
		}
	}
}

func (s *apiServer) recomputeEmbryoLocked(embryoID string) {
	embryo := s.entities["embryos"][embryoID]
	if embryo == nil {
		return
	}
	var latest map[string]any
	var latestAt time.Time
	var firstAbnormal map[string]any
	var firstAbnormalAt time.Time
	for _, observation := range s.observations {
		if observation["deletedAt"] != nil || stringValue(observation["embryoId"]) != embryoID {
			continue
		}
		observedAt, _ := time.Parse(time.RFC3339, stringValue(observation["observedAt"]))
		if latest == nil || observedAt.After(latestAt) {
			latest, latestAt = observation, observedAt
		}
		if stringValue(observation["condition"]) == "ABNORMAL" {
			if firstAbnormal == nil || observedAt.Before(firstAbnormalAt) || (observedAt.Equal(firstAbnormalAt) && stageNumber(stringValue(observation["stageCode"])) < stageNumber(stringValue(firstAbnormal["stageCode"]))) {
				firstAbnormal, firstAbnormalAt = observation, observedAt
			}
		}
	}
	if firstAbnormal == nil {
		for _, field := range []string{"firstAbnormalObservationId", "firstAbnormalStageCode", "firstAbnormalStageId", "firstAbnormalOn", "firstAbnormalAgeDays"} {
			delete(embryo, field)
		}
	} else {
		embryo["firstAbnormalObservationId"] = firstAbnormal["id"]
		embryo["firstAbnormalStageCode"] = firstAbnormal["stageCode"]
		embryo["firstAbnormalStageId"] = stageDefinitionID(stringValue(firstAbnormal["stageCode"]))
		embryo["firstAbnormalOn"] = firstAbnormalAt.In(bangkokLocation()).Format("2006-01-02")
		if lot := s.entities["injection-lots"][stringValue(embryo["injectionLotId"])]; lot != nil {
			if activated, err := time.Parse(time.RFC3339, stringValue(lot["activatedAt"])); err == nil {
				embryo["firstAbnormalAgeDays"] = calendarAge(activated, firstAbnormalAt)
			}
		}
	}
	if latest == nil || stringValue(latest["outcome"]) == "ALIVE" || stringValue(latest["outcome"]) == "NOT_OBSERVED" {
		for _, field := range []string{"exitReason", "exitAt", "exitStageCode", "exitStageId"} {
			delete(embryo, field)
		}
	} else {
		embryo["exitReason"], embryo["exitAt"] = latest["outcome"], latest["observedAt"]
		embryo["exitStageCode"] = latest["stageCode"]
		embryo["exitStageId"] = stageDefinitionID(stringValue(latest["stageCode"]))
	}
}

func (s *apiServer) rollCall(w http.ResponseWriter, r *http.Request) bool {
	date := r.URL.Query().Get("date")
	if date == "" {
		date = time.Now().In(bangkokLocation()).Format("2006-01-02")
	}
	if _, err := time.ParseInLocation("2006-01-02", date, bangkokLocation()); err != nil {
		writeAPIError(w, http.StatusUnprocessableEntity, "validation_error", "invalid Bangkok date")
		return true
	}
	siteID, boxID := r.URL.Query().Get("siteId"), r.URL.Query().Get("boxId")
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := []map[string]any{}
	for _, fish := range s.entities["fish"] {
		if fish["active"] == false || fish["deletedAt"] != nil || (siteID != "" && stringValue(fish["siteId"]) != siteID) || (boxID != "" && stringValue(fish["fishBoxId"]) != boxID) {
			continue
		}
		observed, already := false, false
		for _, o := range s.fishObs {
			if stringValue(o["cloneFishId"]) == stringValue(fish["id"]) && stringValue(o["observedOn"]) == date && o["deletedAt"] == nil {
				observed = true
			}
		}
		already = observed
		lotID := ""
		if embryo := s.entities["embryos"][stringValue(fish["embryoId"])]; embryo != nil {
			lotID = stringValue(embryo["injectionLotId"])
		}
		strain := ""
		if embryo := s.entities["embryos"][stringValue(fish["embryoId"])]; embryo != nil {
			if lot := s.entities["injection-lots"][stringValue(embryo["injectionLotId"])]; lot != nil {
				strain = stringValue(s.entities["donor-cell-lines"][stringValue(lot["donorCellLineId"])]["strain"])
			}
		}
		items = append(items, map[string]any{"fishId": fish["id"], "fishCode": fish["fishCode"], "injectionLotId": lotID, "ageDays": ageDaysOn(stringValue(fish["dob"]), date), "status": fish["status"], "condition": fish["condition"], "strain": strain, "alreadyRecorded": already, "firstAbnormalOn": fish["firstAbnormalOn"], "firstAbnormalAgeDays": fish["firstAbnormalAgeDays"]})
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
			results = append(results, map[string]any{"status": "rejected", "error": map[string]any{"message": "รูปแบบ observation ไม่ถูกต้อง"}})
			continue
		}
		client := stringValue(item["clientUuid"])
		if !isUUID(client) || stringValue(item["cloneFishId"]) == "" || stringValue(item["observedOn"]) == "" || stringValue(item["outcome"]) == "" || stringValue(item["condition"]) == "" {
			results = append(results, map[string]any{"clientUuid": client, "status": "rejected", "error": map[string]any{"message": "clientUuid, cloneFishId, observedOn, outcome และ condition เป็นข้อมูลบังคับ"}})
			continue
		}
		if body, ok := s.idempotency["fish:"+client]; ok {
			var result any
			_ = json.Unmarshal(body, &result)
			results = append(results, result)
			continue
		}
		fish, ok := s.entities["fish"][stringValue(item["cloneFishId"])]
		if !ok || fish["active"] == false || fish["deletedAt"] != nil {
			result := map[string]any{"clientUuid": client, "status": "rejected", "error": map[string]any{"message": "ไม่พบปลา"}}
			results = append(results, result)
			continue
		}
		observedOn, dateErr := time.ParseInLocation("2006-01-02", stringValue(item["observedOn"]), bangkokLocation())
		if dateErr != nil || (stringValue(fish["dob"]) != "" && stringValue(item["observedOn"]) < stringValue(fish["dob"])) || observedOn.After(bangkokDateStart(time.Now())) || !validFishOutcome(stringValue(item["outcome"])) || !validCondition(stringValue(item["condition"])) {
			result := map[string]any{"clientUuid": client, "status": "rejected", "error": map[string]any{"message": "วันที่หรือ enum ของ fish observation ไม่ถูกต้อง"}}
			results = append(results, result)
			continue
		}
		if fishObservationExistsLocked(stringValue(item["cloneFishId"]), stringValue(item["observedOn"]), s.fishObs) {
			original := s.fishObservationLocked(stringValue(item["cloneFishId"]), stringValue(item["observedOn"]))
			result := map[string]any{"clientUuid": client, "id": original["id"], "status": "duplicate", "ageDays": original["ageDays"], "outcome": original["outcome"], "condition": original["condition"]}
			body, _ := json.Marshal(result)
			s.setMutationCache(r, "fish:"+client, body)
			results = append(results, result)
			continue
		}
		outcome := stringValue(item["outcome"])
		if outcome == "ALIVE" && stringValue(fish["status"]) != "ALIVE" && stringValue(item["overrideReason"]) == "" {
			result := map[string]any{"clientUuid": client, "status": "rejected", "error": map[string]any{"message": "ต้องระบุ overrideReason เมื่อแก้สถานะปลาที่ปิดแล้ว"}}
			results = append(results, result)
			continue
		}
		id := uuidV7()
		item["id"] = id
		item["operatorId"], item["deviceId"] = r.Header.Get("X-Operator-Id"), r.Header.Get("X-Device-Id")
		if observed, parseErr := time.ParseInLocation("2006-01-02", stringValue(item["observedOn"]), bangkokLocation()); parseErr == nil {
			item["isBackdated"] = fishDateBackdated(observed, time.Now())
		}
		item["ageDays"] = ageDaysOn(stringValue(fish["dob"]), stringValue(item["observedOn"]))
		item["createdAt"] = time.Now().UTC().Format(time.RFC3339)
		s.fishObs[id] = item
		beforeFish := cloneMap(fish)
		s.recomputeFishLocked(stringValue(item["cloneFishId"]))
		s.auditChangedFishLocked(r, stringValue(item["cloneFishId"]), beforeFish)
		result := map[string]any{"clientUuid": client, "id": id, "status": "created", "ageDays": item["ageDays"], "fishClosed": outcome != "ALIVE"}
		body, _ := json.Marshal(result)
		s.setMutationCache(r, "fish:"+client, body)
		results = append(results, result)
		s.auditLocked(r, "INSERT", "fish_observation", id, nil, item)
	}
	writeJSON(w, 200, map[string]any{"results": results})
	return true
}

func validFishOutcome(value string) bool {
	return domain.FishOutcomeValid(value)
}
func validCondition(value string) bool {
	return domain.ConditionValid(value)
}
func fishObservationExistsLocked(fishID, observedOn string, observations map[string]map[string]any) bool {
	for _, observation := range observations {
		if observation["deletedAt"] == nil && stringValue(observation["cloneFishId"]) == fishID && stringValue(observation["observedOn"]) == observedOn {
			return true
		}
	}
	return false
}

func (s *apiServer) fishObservationLocked(fishID, observedOn string) map[string]any {
	for _, observation := range s.fishObs {
		if observation["deletedAt"] == nil && stringValue(observation["cloneFishId"]) == fishID && stringValue(observation["observedOn"]) == observedOn {
			return observation
		}
	}
	return map[string]any{}
}

func ageDays(value string) int {
	today := time.Now().In(bangkokLocation()).Format("2006-01-02")
	return ageDaysOn(value, today)
}

func ageDaysOn(dobValue, observedValue string) int {
	return domain.AgeDaysOn(dobValue, observedValue, bangkokLocation())
}

func calendarAge(start, end time.Time) int {
	return domain.AgeDaysOn(start.In(bangkokLocation()).Format("2006-01-02"), end.In(bangkokLocation()).Format("2006-01-02"), bangkokLocation())
}

func bangkokLocation() *time.Location {
	location, err := time.LoadLocation("Asia/Bangkok")
	if err != nil {
		return time.FixedZone("Asia/Bangkok", 7*60*60)
	}
	return location
}

func bangkokDateStart(value time.Time) time.Time {
	local := value.In(bangkokLocation())
	return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, bangkokLocation())
}

func round4(value float64) float64 {
	return math.Round(value*10000) / 10000
}

func isBackdated(observed, received time.Time) bool {
	return math.Abs(received.Sub(observed).Minutes()) > 15
}

func fishDateBackdated(observed, received time.Time) bool {
	return observed.In(bangkokLocation()).Format("2006-01-02") != received.In(bangkokLocation()).Format("2006-01-02")
}

func (s *apiServer) pendingCountLocked(now time.Time) int {
	count := 0
	for _, e := range s.entities["embryos"] {
		if e["active"] == false || e["deletedAt"] != nil || e["exitReason"] != nil || s.latestEmbryoObservationLocked(stringValue(e["id"])) == nil || stringValue(s.latestEmbryoObservationLocked(stringValue(e["id"]))["outcome"]) != "ALIVE" {
			continue
		}
		lot := s.entities["injection-lots"][stringValue(e["injectionLotId"])]
		batch := s.entities["batches"][stringValue(lot["batchId"])]
		activated, err := time.Parse(time.RFC3339, stringValue(lot["activatedAt"]))
		if lot != nil && lot["active"] != false && lot["deletedAt"] == nil && batch != nil && batch["active"] != false && batch["deletedAt"] == nil && err == nil && domain.PromotionEligibleAt(false, true, activated, now, s.promotionThresholdLocked(batch)) {
			count++
		}
	}
	return count
}

func (s *apiServer) latestEmbryoObservationLocked(embryoID string) map[string]any {
	var latest map[string]any
	var latestAt time.Time
	for _, observation := range s.observations {
		if stringValue(observation["embryoId"]) != embryoID || observation["deletedAt"] != nil {
			continue
		}
		observedAt, err := time.Parse(time.RFC3339, stringValue(observation["observedAt"]))
		if err != nil || latest == nil || observedAt.After(latestAt) {
			latest, latestAt = observation, observedAt
		}
	}
	return latest
}

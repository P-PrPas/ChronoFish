package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/P-PrPas/ChronoFish/backend/internal/domain"
)

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
		writeAPIError(w, 404, "not_found", "à¹„à¸¡à¹ˆà¸žà¸š injection lot")
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
		writeAPIError(w, 400, "invalid_json", "à¸‚à¹‰à¸­à¸¡à¸¹à¸¥ JSON à¹„à¸¡à¹ˆà¸–à¸¹à¸à¸•à¹‰à¸­à¸‡")
		return true
	}
	raw, ok := input["observations"].([]any)
	if !ok {
		writeAPIError(w, 422, "validation_error", "à¸•à¹‰à¸­à¸‡à¸£à¸°à¸šà¸¸ observations")
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	results := make([]any, 0, len(raw))
	staged := make([]map[string]any, 0, len(raw))
	for _, value := range raw {
		item, ok := value.(map[string]any)
		if !ok {
			results = append(results, map[string]any{"status": "rejected", "error": map[string]any{"message": "à¸£à¸¹à¸›à¹à¸šà¸š observation à¹„à¸¡à¹ˆà¸–à¸¹à¸à¸•à¹‰à¸­à¸‡"}})
			continue
		}
		client := stringValue(item["clientUuid"])
		if client == "" {
			results = append(results, map[string]any{"status": "rejected", "error": map[string]any{"message": "à¸•à¹‰à¸­à¸‡à¸£à¸°à¸šà¸¸ clientUuid"}})
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
		actual := observedAt.Sub(activated).Hours()
		expected := expectedHPA(stringValue(item["stageCode"]))
		id := uuidV7()
		result := map[string]any{"clientUuid": client, "id": id, "status": "created", "hpaActual": actual, "hpaExpected": expected, "deviationH": actual - expected, "deviationLabel": deviationLabel(actual - expected)}
		obs := cloneMap(item)
		obs["id"], obs["injectionLotId"], obs["hpaActual"], obs["hpaExpectedSnapshot"], obs["deviationH"], obs["operatorId"], obs["deviceId"], obs["isBackdated"], obs["createdAt"] = id, lot["id"], actual, expected, actual-expected, r.Header.Get("X-Operator-Id"), r.Header.Get("X-Device-Id"), observedAt.Before(time.Now().UTC()), time.Now().UTC().Format(time.RFC3339)
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
		s.recomputeEmbryoLocked(embryoID)
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
			return fmt.Errorf("à¸•à¹‰à¸­à¸‡à¸£à¸°à¸šà¸¸ %s", f)
		}
	}
	embryo, ok := s.entities["embryos"][stringValue(item["embryoId"])]
	if !ok {
		return errors.New("à¹„à¸¡à¹ˆà¸žà¸š embryo")
	}
	if stageNumber(stringValue(item["stageCode"])) < 1 || stageNumber(stringValue(item["stageCode"])) > 36 {
		return errors.New("stageCode à¹„à¸¡à¹ˆà¸–à¸¹à¸à¸•à¹‰à¸­à¸‡")
	}
	lot := s.entities["injection-lots"][stringValue(embryo["injectionLotId"])]
	observed, err := time.Parse(time.RFC3339, stringValue(item["observedAt"]))
	if err != nil {
		return errors.New("observedAt à¸•à¹‰à¸­à¸‡à¹€à¸›à¹‡à¸™ RFC3339")
	}
	activated, err := time.Parse(time.RFC3339, stringValue(lot["activatedAt"]))
	if err != nil || observed.Before(activated) {
		return errors.New("observedAt à¸•à¹‰à¸­à¸‡à¹„à¸¡à¹ˆà¸à¹ˆà¸­à¸™ activatedAt")
	}
	if observed.After(time.Now().UTC().Add(5 * time.Minute)) {
		return errors.New("observedAt à¸«à¹‰à¸²à¸¡à¸­à¸¢à¸¹à¹ˆà¹ƒà¸™à¸­à¸™à¸²à¸„à¸•à¹€à¸à¸´à¸™ 5 à¸™à¸²à¸—à¸µ")
	}
	outcome := stringValue(item["outcome"])
	if outcome != "ALIVE" && outcome != "DEAD" && outcome != "DEGENERATED" && outcome != "NOT_OBSERVED" {
		return errors.New("outcome à¹„à¸¡à¹ˆà¸–à¸¹à¸à¸•à¹‰à¸­à¸‡")
	}
	condition := stringValue(item["condition"])
	if condition != "NORMAL" && condition != "ABNORMAL" && condition != "UNDETERMINED" {
		return errors.New("condition à¹„à¸¡à¹ˆà¸–à¸¹à¸à¸•à¹‰à¸­à¸‡")
	}
	if outcome == "ALIVE" && embryo["exitReason"] != nil && stringValue(item["overrideReason"]) == "" {
		return errors.New("à¸•à¹‰à¸­à¸‡à¸£à¸°à¸šà¸¸ overrideReason à¹€à¸¡à¸·à¹ˆà¸­à¸•à¹‰à¸­à¸‡à¸à¸²à¸£à¸šà¸±à¸™à¸—à¸¶à¸ ALIVE à¸«à¸¥à¸±à¸‡à¸¡à¸µ exit event")
	}
	for _, old := range s.observations {
		if stringValue(old["embryoId"]) == stringValue(item["embryoId"]) && stringValue(old["stageCode"]) == stringValue(item["stageCode"]) && old["deletedAt"] == nil {
			return errors.New("à¸¡à¸µ observation à¸‚à¸­à¸‡ embryo à¹à¸¥à¸° stage à¸™à¸µà¹‰à¹à¸¥à¹‰à¸§")
		}
	}
	return nil
}

func deviationLabel(value float64) string {
	minutes := int(value * 60)
	if minutes >= 0 {
		return fmt.Sprintf("à¸Šà¹‰à¸²à¸à¸§à¹ˆà¸²à¸ªà¸²à¸à¸¥ %d à¸™à¸²à¸—à¸µ", minutes)
	}
	return fmt.Sprintf("à¹€à¸£à¹‡à¸§à¸à¸§à¹ˆà¸²à¸ªà¸²à¸à¸¥ %d à¸™à¸²à¸—à¸µ", -minutes)
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
		writeAPIError(w, 404, "not_found", "à¹„à¸¡à¹ˆà¸žà¸š observation")
		return true
	}
	before := cloneMap(old)
	if r.Method == http.MethodDelete {
		reason := strings.TrimSpace(r.URL.Query().Get("reason"))
		if reason == "" {
			reason = "soft-delete"
		}
		old["deletedAt"] = time.Now().UTC().Format(time.RFC3339)
		old["overrideReason"] = reason
		if fish {
			s.recomputeFishLocked(stringValue(old["cloneFishId"]))
		} else {
			s.recomputeEmbryoLocked(stringValue(old["embryoId"]))
		}
		s.auditLocked(r, "DELETE", table, id, before, old)
		w.WriteHeader(http.StatusNoContent)
		return true
	}
	input, err := readMap(r)
	if err != nil {
		writeAPIError(w, 400, "invalid_json", "à¸‚à¹‰à¸­à¸¡à¸¹à¸¥ JSON à¹„à¸¡à¹ˆà¸–à¸¹à¸à¸•à¹‰à¸­à¸‡")
		return true
	}
	correctionReason := stringValue(input["correctionReason"])
	if correctionReason == "" {
		correctionReason = stringValue(input["overrideReason"])
	}
	if correctionReason == "" {
		writeAPIError(w, 422, "validation_error", "à¸•à¹‰à¸­à¸‡à¸£à¸°à¸šà¸¸ correctionReason")
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
			if observedOn.After(bangkokDateStart(time.Now())) {
				writeAPIError(w, 422, "validation_error", "observedOn à¸«à¹‰à¸²à¸¡à¹€à¸›à¹‡à¸™à¸§à¸±à¸™à¸—à¸µà¹ˆà¹ƒà¸™à¸­à¸™à¸²à¸„à¸•")
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
				writeAPIError(w, 422, "validation_error", "observedAt à¸­à¸¢à¸¹à¹ˆà¸™à¸­à¸à¸Šà¹ˆà¸§à¸‡ activation à¸–à¸¶à¸‡à¸›à¸±à¸ˆà¸ˆà¸¸à¸šà¸±à¸™")
				return true
			}
		}
	}
	for k, v := range input {
		if k != "id" && k != "correctionReason" {
			old[k] = v
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
					actual := observedAt.Sub(activated).Hours()
					old["hpaActual"] = actual
					old["deviationH"] = actual - numberValue(old["hpaExpectedSnapshot"])
				}
			}
		}
	}
	old["updatedAt"] = time.Now().UTC().Format(time.RFC3339)
	if fish {
		s.recomputeFishLocked(stringValue(old["cloneFishId"]))
	} else {
		s.recomputeEmbryoLocked(stringValue(old["embryoId"]))
	}
	s.auditLocked(r, "UPDATE", table, id, before, old)
	writeJSON(w, 200, old)
	return true
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
		inheritedDate := stringValue(fish["firstAbnormalOn"])
		if inheritedDate == "" || firstAbnormalDate < inheritedDate {
			fish["firstAbnormalOn"] = firstAbnormalDate
			fish["firstAbnormalAgeDays"] = ageDaysOn(stringValue(fish["dob"]), firstAbnormalDate)
			fish["firstAbnormalSource"] = "fish"
		}
	} else if stringValue(fish["firstAbnormalSource"]) == "fish" {
		for _, field := range []string{"firstAbnormalOn", "firstAbnormalAgeDays", "firstAbnormalSource"} {
			delete(fish, field)
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
		date = time.Now().UTC().Format("2006-01-02")
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := []map[string]any{}
	for _, fish := range s.entities["fish"] {
		if stringValue(fish["status"]) != "ALIVE" {
			continue
		}
		observed, already := false, false
		for _, o := range s.fishObs {
			if stringValue(o["cloneFishId"]) == stringValue(fish["id"]) && stringValue(o["observedOn"]) == date && o["deletedAt"] == nil {
				observed = true
			}
		}
		already = observed
		items = append(items, map[string]any{"fishId": fish["id"], "fishCode": fish["fishCode"], "ageDays": ageDaysOn(stringValue(fish["dob"]), date), "status": fish["status"], "condition": fish["condition"], "alreadyRecorded": already, "firstAbnormalOn": fish["firstAbnormalOn"], "firstAbnormalAgeDays": fish["firstAbnormalAgeDays"]})
	}
	sortItems(items)
	writeJSON(w, 200, map[string]any{"date": date, "items": items})
	return true
}

func (s *apiServer) createFishObservations(w http.ResponseWriter, r *http.Request) bool {
	input, err := readMap(r)
	if err != nil {
		writeAPIError(w, 400, "invalid_json", "à¸‚à¹‰à¸­à¸¡à¸¹à¸¥ JSON à¹„à¸¡à¹ˆà¸–à¸¹à¸à¸•à¹‰à¸­à¸‡")
		return true
	}
	raw, ok := input["observations"].([]any)
	if !ok {
		writeAPIError(w, 422, "validation_error", "à¸•à¹‰à¸­à¸‡à¸£à¸°à¸šà¸¸ observations")
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	results := []any{}
	for _, value := range raw {
		item, ok := value.(map[string]any)
		if !ok {
			results = append(results, map[string]any{"status": "rejected", "error": map[string]any{"message": "à¸£à¸¹à¸›à¹à¸šà¸š observation à¹„à¸¡à¹ˆà¸–à¸¹à¸à¸•à¹‰à¸­à¸‡"}})
			continue
		}
		client := stringValue(item["clientUuid"])
		if !isUUID(client) || stringValue(item["cloneFishId"]) == "" || stringValue(item["observedOn"]) == "" || stringValue(item["outcome"]) == "" || stringValue(item["condition"]) == "" {
			results = append(results, map[string]any{"clientUuid": client, "status": "rejected", "error": map[string]any{"message": "clientUuid, cloneFishId, observedOn, outcome à¹à¸¥à¸° condition à¹€à¸›à¹‡à¸™à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸šà¸±à¸‡à¸„à¸±à¸š"}})
			continue
		}
		if body, ok := s.idempotency["fish:"+client]; ok {
			var result any
			_ = json.Unmarshal(body, &result)
			results = append(results, result)
			continue
		}
		fish, ok := s.entities["fish"][stringValue(item["cloneFishId"])]
		if !ok {
			result := map[string]any{"clientUuid": client, "status": "rejected", "error": map[string]any{"message": "à¹„à¸¡à¹ˆà¸žà¸šà¸›à¸¥à¸²"}}
			results = append(results, result)
			continue
		}
		observedOn, dateErr := time.ParseInLocation("2006-01-02", stringValue(item["observedOn"]), bangkokLocation())
		if dateErr != nil || observedOn.After(bangkokDateStart(time.Now())) || !validFishOutcome(stringValue(item["outcome"])) || !validCondition(stringValue(item["condition"])) {
			result := map[string]any{"clientUuid": client, "status": "rejected", "error": map[string]any{"message": "à¸§à¸±à¸™à¸—à¸µà¹ˆà¸«à¸£à¸·à¸­ enum à¸‚à¸­à¸‡ fish observation à¹„à¸¡à¹ˆà¸–à¸¹à¸à¸•à¹‰à¸­à¸‡"}}
			results = append(results, result)
			continue
		}
		if fishObservationExistsLocked(stringValue(item["cloneFishId"]), stringValue(item["observedOn"]), s.fishObs) {
			result := map[string]any{"clientUuid": client, "status": "duplicate"}
			body, _ := json.Marshal(result)
			s.idempotency["fish:"+client] = body
			results = append(results, result)
			continue
		}
		outcome := stringValue(item["outcome"])
		if outcome == "ALIVE" && stringValue(fish["status"]) != "ALIVE" && stringValue(item["overrideReason"]) == "" {
			result := map[string]any{"clientUuid": client, "status": "rejected", "error": map[string]any{"message": "à¸•à¹‰à¸­à¸‡à¸£à¸°à¸šà¸¸ overrideReason à¹€à¸¡à¸·à¹ˆà¸­à¹à¸à¹‰à¸ªà¸–à¸²à¸™à¸°à¸›à¸¥à¸²à¸—à¸µà¹ˆà¸›à¸´à¸”à¹à¸¥à¹‰à¸§"}}
			results = append(results, result)
			continue
		}
		id := uuidV7()
		item["id"] = id
		item["operatorId"], item["deviceId"] = r.Header.Get("X-Operator-Id"), r.Header.Get("X-Device-Id")
		if observed, parseErr := time.ParseInLocation("2006-01-02", stringValue(item["observedOn"]), bangkokLocation()); parseErr == nil {
			item["isBackdated"] = observed.Before(bangkokDateStart(time.Now()))
		}
		item["ageDays"] = ageDaysOn(stringValue(fish["dob"]), stringValue(item["observedOn"]))
		item["createdAt"] = time.Now().UTC().Format(time.RFC3339)
		s.fishObs[id] = item
		s.recomputeFishLocked(stringValue(item["cloneFishId"]))
		result := map[string]any{"clientUuid": client, "id": id, "status": "created", "ageDays": item["ageDays"], "fishClosed": outcome != "ALIVE"}
		body, _ := json.Marshal(result)
		s.idempotency["fish:"+client] = body
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

func ageDays(value string) int {
	dob, err := time.Parse("2006-01-02", value)
	if err != nil {
		return 0
	}
	return int(time.Since(dob).Hours() / 24)
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

func (s *apiServer) pendingCountLocked(now time.Time) int {
	count := 0
	for _, e := range s.entities["embryos"] {
		if e["exitReason"] != nil || s.latestEmbryoObservationLocked(stringValue(e["id"])) == nil || stringValue(s.latestEmbryoObservationLocked(stringValue(e["id"]))["outcome"]) != "ALIVE" {
			continue
		}
		lot := s.entities["injection-lots"][stringValue(e["injectionLotId"])]
		activated, err := time.Parse(time.RFC3339, stringValue(lot["activatedAt"]))
		if err == nil && calendarAge(activated, now) >= 5 {
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

package httpapi

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

func (s *apiServer) analytics(w http.ResponseWriter, r *http.Request, p []string) bool {
	if r.Method != http.MethodGet {
		return false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	embryos := s.filteredEmbryos(r.URL.Query())
	switch strings.Join(p, "/") {
	case "kpi":
		returnJSON(w, s.kpiLocked(embryos, r.URL.Query()))
	case "funnel":
		writeJSON(w, 200, map[string]any{"items": s.funnelLocked(embryos)})
	case "survival":
		writeJSON(w, 200, map[string]any{"items": s.survivalLocked(embryos)})
	case "timing-deviation":
		writeJSON(w, 200, map[string]any{"items": s.deviationLocked(embryos)})
	case "abnormality-onset":
		writeJSON(w, 200, map[string]any{"items": s.abnormalityLocked(embryos)})
	case "fish-survival":
		writeJSON(w, 200, map[string]any{"items": s.fishSurvivalLocked(r.URL.Query())})
	case "observation-gaps":
		writeJSON(w, 200, map[string]any{"items": s.gapsLocked(r.URL.Query())})
	case "pipeline":
		writeJSON(w, 200, map[string]any{"items": s.pipelineLocked(embryos, r.URL.Query())})
	default:
		return false
	}
	return true
}

func (s *apiServer) filteredEmbryos(query map[string][]string) []map[string]any {
	items := make([]map[string]any, 0)
	for _, embryo := range s.entities["embryos"] {
		if embryo["active"] == false || embryo["deletedAt"] != nil {
			continue
		}
		lot := s.entities["injection-lots"][stringValue(embryo["injectionLotId"])]
		batch := s.entities["batches"][stringValue(lot["batchId"])]
		if wanted := firstQuery(query, "batchId"); wanted != "" && wanted != stringValue(batch["id"]) {
			continue
		}
		if wanted := firstQuery(query, "siteId"); wanted != "" && wanted != stringValue(batch["siteId"]) {
			continue
		}
		if wanted := firstQuery(query, "operatorId"); wanted != "" && wanted != stringValue(batch["operatorId"]) {
			continue
		}
		if wanted := firstQuery(query, "treatmentGroupId"); wanted != "" && wanted != stringValue(batch["treatmentGroupId"]) {
			continue
		}
		if wanted := firstQuery(query, "donorCellLineId"); wanted != "" && wanted != stringValue(lot["donorCellLineId"]) {
			continue
		}
		if wanted := firstQuery(query, "strain"); wanted != "" && !strings.EqualFold(wanted, stringValue(s.entities["donor-cell-lines"][stringValue(lot["donorCellLineId"])]["strain"])) {
			continue
		}
		if from := firstQuery(query, "dateFrom"); from != "" && stringValue(batch["experimentDate"]) < from {
			continue
		}
		if to := firstQuery(query, "dateTo"); to != "" && stringValue(batch["experimentDate"]) > to {
			continue
		}
		items = append(items, embryo)
	}
	return items
}

func firstQuery(query map[string][]string, key string) string {
	if values := query[key]; len(values) > 0 {
		return values[0]
	}
	return ""
}

func (s *apiServer) kpiLocked(embryos []map[string]any, query map[string][]string) map[string]any {
	normal, abnormal := 0, 0
	for _, embryo := range embryos {
		latest := s.latestEmbryoObservationLocked(stringValue(embryo["id"]))
		if latest != nil && stringValue(latest["condition"]) == "NORMAL" {
			normal++
		}
		if latest != nil && stringValue(latest["condition"]) == "ABNORMAL" {
			abnormal++
		}
	}
	fish := s.filteredFishLocked(query)
	nEggs := 0
	for _, embryo := range embryos {
		lot := s.entities["injection-lots"][stringValue(embryo["injectionLotId"])]
		nEggs += intValue(lot["nEggs"])
	}
	return map[string]any{"stage1": map[string]any{"nBatches": len(s.filteredBatchIDsLocked(query)), "nEggs": nEggs, "nActivated": len(embryos), "nReachedShield": s.reachedStageCountLocked(embryos, 19), "nReachedDay1": s.reachedStageCountLocked(embryos, 22), "nPromoted": len(fish), "pctNormal": percentage(normal, len(embryos)), "pctAbnormal": percentage(abnormal, len(embryos))}, "stage2": map[string]any{"nFish": len(fish), "nAlive": countFish(fish, "ALIVE"), "nDead": countFish(fish, "DEAD"), "nFrozen": countFish(fish, "FROZEN"), "nDiscarded": countFish(fish, "DISCARDED"), "meanAgeDaysAlive": meanFishAge(fish, "ALIVE")}}
}

func (s *apiServer) filteredBatchIDsLocked(query map[string][]string) map[string]bool {
	result := make(map[string]bool)
	for id, batch := range s.entities["batches"] {
		if wanted := firstQuery(query, "batchId"); wanted != "" && wanted != id {
			continue
		}
		if wanted := firstQuery(query, "siteId"); wanted != "" && wanted != stringValue(batch["siteId"]) {
			continue
		}
		if wanted := firstQuery(query, "operatorId"); wanted != "" && wanted != stringValue(batch["operatorId"]) {
			continue
		}
		if wanted := firstQuery(query, "treatmentGroupId"); wanted != "" && wanted != stringValue(batch["treatmentGroupId"]) {
			continue
		}
		if from := firstQuery(query, "dateFrom"); from != "" && stringValue(batch["experimentDate"]) < from {
			continue
		}
		if to := firstQuery(query, "dateTo"); to != "" && stringValue(batch["experimentDate"]) > to {
			continue
		}
		result[id] = true
	}
	return result
}

func (s *apiServer) filteredFishLocked(query map[string][]string) map[string]map[string]any {
	result := make(map[string]map[string]any)
	for id, fish := range s.entities["fish"] {
		if wanted := firstQuery(query, "siteId"); wanted != "" && wanted != stringValue(fish["siteId"]) {
			continue
		}
		if wanted := firstQuery(query, "donorCellLineId"); wanted != "" && wanted != stringValue(fish["donorCellLineId"]) {
			continue
		}
		donor := s.entities["donor-cell-lines"][stringValue(fish["donorCellLineId"])]
		if wanted := firstQuery(query, "strain"); wanted != "" && !strings.EqualFold(wanted, stringValue(donor["strain"])) {
			continue
		}
		if embryoID := stringValue(fish["embryoId"]); embryoID != "" {
			embryo := s.entities["embryos"][embryoID]
			lot := s.entities["injection-lots"][stringValue(embryo["injectionLotId"])]
			batch := s.entities["batches"][stringValue(lot["batchId"])]
			if !s.filteredBatchIDsLocked(query)[stringValue(batch["id"])] {
				continue
			}
		}
		result[id] = fish
	}
	return result
}

func percentage(value, total int) float64 {
	if total == 0 {
		return 0
	}
	return float64(value) * 100 / float64(total)
}
func (s *apiServer) reachedStageCountLocked(embryos []map[string]any, stage int) int {
	count := 0
	for _, embryo := range embryos {
		for _, observation := range s.observations {
			if observation["deletedAt"] == nil && stringValue(observation["embryoId"]) == stringValue(embryo["id"]) && stageNumber(stringValue(observation["stageCode"])) >= stage {
				count++
				break
			}
		}
	}
	return count
}
func (s *apiServer) funnelLocked(embryos []map[string]any) []map[string]any {
	items := make([]map[string]any, 0, 26)
	for stage := 1; stage <= 26; stage++ {
		alive := 0
		for _, embryo := range embryos {
			observation := s.observationAtStageLocked(stringValue(embryo["id"]), stage)
			if observation == nil || stringValue(observation["outcome"]) == "ALIVE" {
				alive++
			}
		}
		items = append(items, map[string]any{"stageOrder": stage, "stageCode": stageCode(stage), "stageLabel": stageLabel(stage), "alive": alive, "riskSet": len(embryos), "pctOfActivated": percentage(alive, len(embryos))})
	}
	return items
}
func (s *apiServer) survivalLocked(embryos []map[string]any) []map[string]any {
	items := make([]map[string]any, 0, 26)
	for stage := 1; stage <= 26; stage++ {
		alive, dead := 0, 0
		for _, embryo := range embryos {
			observation := s.observationAtStageLocked(stringValue(embryo["id"]), stage)
			if observation == nil || stringValue(observation["outcome"]) == "ALIVE" {
				alive++
			} else if stringValue(observation["outcome"]) == "DEAD" || stringValue(observation["outcome"]) == "DEGENERATED" {
				dead++
			}
		}
		risk := len(embryos)
		items = append(items, map[string]any{"stageOrder": stage, "stageLabel": stageLabel(stage), "riskSet": risk, "alive": alive, "nPrev": risk, "nDead": dead, "surv": percentage(alive, risk) / 100, "pctOfDevelopment": percentage(alive, len(embryos))})
	}
	return items
}
func (s *apiServer) deviationLocked(embryos []map[string]any) []map[string]any {
	groups := map[int][]float64{}
	for _, embryo := range embryos {
		for _, observation := range s.observations {
			if observation["deletedAt"] == nil && stringValue(observation["embryoId"]) == stringValue(embryo["id"]) {
				groups[stageNumber(stringValue(observation["stageCode"]))] = append(groups[stageNumber(stringValue(observation["stageCode"]))], floatValue(observation["deviationH"]))
			}
		}
	}
	items := make([]map[string]any, 0, len(groups))
	for stage, values := range groups {
		sort.Float64s(values)
		sum := 0.0
		for _, value := range values {
			sum += value
		}
		median := values[len(values)/2]
		items = append(items, map[string]any{"stageOrder": stage, "stageLabel": stageLabel(stage), "expectedHpa": expectedHPA(stageCode(stage)), "n": len(values), "meanDeviationH": sum / float64(len(values)), "medianDeviationH": median, "sdDeviationH": nil, "minDeviationH": values[0], "maxDeviationH": values[len(values)-1]})
	}
	return items
}
func (s *apiServer) abnormalityLocked(embryos []map[string]any) []map[string]any {
	counts := map[int]int{}
	for _, embryo := range embryos {
		stage := stageNumber(stringValue(embryo["firstAbnormalStageCode"]))
		if stage > 0 {
			counts[stage]++
		}
	}
	items := make([]map[string]any, 0, len(counts))
	for stage, count := range counts {
		items = append(items, map[string]any{"stageOrder": stage, "stageLabel": stageLabel(stage), "count": count})
	}
	return items
}
func (s *apiServer) observationAtStageLocked(embryoID string, stage int) map[string]any {
	for _, observation := range s.observations {
		if observation["deletedAt"] == nil && stringValue(observation["embryoId"]) == embryoID && stageNumber(stringValue(observation["stageCode"])) == stage {
			return observation
		}
	}
	return nil
}
func floatValue(value any) float64 {
	switch value := value.(type) {
	case float64:
		return value
	case int:
		return float64(value)
	case string:
		parsed, _ := strconv.ParseFloat(value, 64)
		return parsed
	}
	return 0
}
func (s *apiServer) meanFishAgeLocked(status string) any {
	return meanFishAge(s.entities["fish"], status)
}
func meanFishAge(fishItems map[string]map[string]any, status string) any {
	sum, count := 0, 0
	for _, fish := range fishItems {
		if stringValue(fish["status"]) == status {
			sum += ageDays(stringValue(fish["dob"]))
			count++
		}
	}
	if count == 0 {
		return nil
	}
	return float64(sum) / float64(count)
}
func (s *apiServer) fishSurvivalLocked(query map[string][]string) []map[string]any {
	fishItems := s.filteredFishLocked(query)
	maxAge := 0
	for _, fish := range fishItems {
		if age := ageDays(stringValue(fish["dob"])); age > maxAge {
			maxAge = age
		}
	}
	items := make([]map[string]any, 0, maxAge+1)
	for age := 0; age <= maxAge; age++ {
		atRisk, alive := 0, 0
		for _, fish := range fishItems {
			dob, err := time.ParseInLocation("2006-01-02", stringValue(fish["dob"]), bangkokLocation())
			if err != nil {
				continue
			}
			observedAge := int(time.Since(dob).Hours() / 24)
			if observedAge >= age {
				atRisk++
				if stringValue(fish["status"]) == "ALIVE" || s.exitAgeLocked(fish) > age {
					alive++
				}
			}
		}
		items = append(items, map[string]any{"ageDays": age, "atRisk": atRisk, "alive": alive, "surv": percentage(alive, atRisk) / 100})
	}
	return items
}
func (s *apiServer) exitAgeLocked(fish map[string]any) int {
	return ageDays(stringValue(fish["exitDate"]))
}
func (s *apiServer) gapsLocked(query map[string][]string) []map[string]any {
	items := make([]map[string]any, 0)
	today := time.Now().UTC().Format("2006-01-02")
	for _, fish := range s.filteredFishLocked(query) {
		latest := ""
		for _, observation := range s.fishObs {
			if observation["deletedAt"] == nil && stringValue(observation["cloneFishId"]) == stringValue(fish["id"]) && stringValue(observation["observedOn"]) > latest {
				latest = stringValue(observation["observedOn"])
			}
		}
		missed := 0
		if latest != "" {
			missed = ageDaysOn(latest, today)
		} else {
			missed = ageDays(stringValue(fish["dob"]))
		}
		if missed > 0 {
			items = append(items, map[string]any{"fishId": fish["id"], "fishCode": fish["fishCode"], "lastObservedOn": latest, "missedDays": missed})
		}
	}
	return items
}
func (s *apiServer) pipelineLocked(embryos []map[string]any, query map[string][]string) []map[string]any {
	start := len(embryos)
	shield := s.reachedStageCountLocked(embryos, 19)
	day1 := s.reachedStageCountLocked(embryos, 22)
	promoted := len(s.filteredFishLocked(query))
	return []map[string]any{{"step": "Activated", "count": start, "pctOfStart": percentage(start, start) / 100}, {"step": "Reached Shield", "count": shield, "pctOfStart": percentage(shield, start) / 100}, {"step": "Reached Day 1", "count": day1, "pctOfStart": percentage(day1, start) / 100}, {"step": "Promoted", "count": promoted, "pctOfStart": percentage(promoted, start) / 100}}
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

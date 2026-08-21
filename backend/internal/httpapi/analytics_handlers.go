package httpapi

import (
	"fmt"
	"math"
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
		if lot == nil || lot["active"] == false || lot["deletedAt"] != nil {
			continue
		}
		batch := s.entities["batches"][stringValue(lot["batchId"])]
		if batch == nil || batch["active"] == false || batch["deletedAt"] != nil {
			continue
		}
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
	fishNormal, fishAbnormal, fishUndetermined := 0, 0, 0
	for _, item := range fish {
		switch strings.ToUpper(stringValue(item["condition"])) {
		case "NORMAL":
			fishNormal++
		case "ABNORMAL":
			fishAbnormal++
		default:
			fishUndetermined++
		}
	}
	nEggs, nActivated := 0, 0
	countedLots := make(map[string]bool)
	for _, embryo := range embryos {
		lot := s.entities["injection-lots"][stringValue(embryo["injectionLotId"])]
		lotID := stringValue(lot["id"])
		if !countedLots[lotID] {
			countedLots[lotID] = true
			nEggs += intValue(lot["nEggs"])
			nActivated += intValue(lot["nActivated"])
		}
	}
	if nActivated == 0 {
		nActivated = len(embryos)
	}
	return map[string]any{"stage1": map[string]any{"nBatches": len(s.filteredBatchIDsLocked(query)), "nEggs": nEggs, "nActivated": nActivated, "nReachedShield": s.reachedStageCountLocked(embryos, 19), "nReachedDay1": s.reachedStageCountLocked(embryos, 22), "nPromoted": len(fish), "pctNormal": percentage(normal, len(embryos)) / 100, "pctAbnormal": percentage(abnormal, len(embryos)) / 100, "controlComparison": s.controlComparisonLocked(embryos, query)}, "stage2": map[string]any{"nFish": len(fish), "nAlive": countFish(fish, "ALIVE"), "nDead": countFish(fish, "DEAD"), "nFrozen": countFish(fish, "FROZEN"), "nDiscarded": countFish(fish, "DISCARDED"), "nNormal": fishNormal, "nAbnormal": fishAbnormal, "nUndetermined": fishUndetermined, "meanAgeDaysAlive": meanFishAge(fish, "ALIVE")}}
}

// controlComparisonLocked returns the three experimental arms used in the
// dashboard and printable report. SCNT is derived from the filtered embryo
// observations; NATURAL_BREEDING and IVF come from their canonical control
// count rows. No arm is relabelled as a normal/abnormal condition.
func (s *apiServer) controlComparisonLocked(embryos []map[string]any, query map[string][]string) []map[string]any {
	rows := make([]map[string]any, 0)
	for _, stage := range []int{19, 22} {
		normal, abnormal := 0, 0
		for _, embryo := range embryos {
			observation := s.observationAtStageLocked(stringValue(embryo["id"]), stage)
			if observation == nil {
				continue
			}
			switch stringValue(observation["condition"]) {
			case "NORMAL":
				normal++
			case "ABNORMAL":
				abnormal++
			}
		}
		rows = append(rows, controlComparisonRow("SCNT", stage, normal, abnormal))
	}
	batchIDs := s.filteredBatchIDsLocked(query)
	for _, id := range sortedIDs(s.entities["control-arm-counts"]) {
		item := s.entities["control-arm-counts"][id]
		if item["deletedAt"] != nil || !batchIDs[stringValue(item["batchId"])] {
			continue
		}
		rows = append(rows, controlComparisonRow(stringValue(item["armType"]), stageNumber(stringValue(item["stageCode"])), intValue(item["nNormal"]), intValue(item["nAbnormal"])))
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if intValue(rows[i]["stageOrder"]) != intValue(rows[j]["stageOrder"]) {
			return intValue(rows[i]["stageOrder"]) < intValue(rows[j]["stageOrder"])
		}
		return stringValue(rows[i]["armType"]) < stringValue(rows[j]["armType"])
	})
	return rows
}

func controlComparisonRow(arm string, stage, normal, abnormal int) map[string]any {
	total := normal + abnormal
	return map[string]any{"armType": arm, "stageOrder": stage, "stageCode": stageCode(stage), "stageLabel": stageLabel(stage), "nNormal": normal, "nAbnormal": abnormal, "n": total, "pctNormal": percentage(normal, total) / 100, "pctAbnormal": percentage(abnormal, total) / 100}
}

func (s *apiServer) filteredBatchIDsLocked(query map[string][]string) map[string]bool {
	result := make(map[string]bool)
	for id, batch := range s.entities["batches"] {
		if batch["active"] == false || batch["deletedAt"] != nil {
			continue
		}
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
		if fish["active"] == false || fish["deletedAt"] != nil {
			continue
		}
		if wanted := firstQuery(query, "status"); wanted != "" && !strings.EqualFold(wanted, stringValue(fish["status"])) {
			continue
		}
		if wanted := firstQuery(query, "siteId"); wanted != "" && wanted != stringValue(fish["siteId"]) {
			continue
		}
		if wanted := firstQuery(query, "boxId"); wanted != "" && wanted != stringValue(fish["fishBoxId"]) {
			continue
		}
		if wanted := firstQuery(query, "condition"); wanted != "" && !strings.EqualFold(wanted, stringValue(fish["condition"])) {
			continue
		}
		if from := firstQuery(query, "dobFrom"); from != "" && stringValue(fish["dob"]) < from {
			continue
		}
		if to := firstQuery(query, "dobTo"); to != "" && stringValue(fish["dob"]) > to {
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
			if embryo == nil || embryo["active"] == false || embryo["deletedAt"] != nil {
				continue
			}
			lot := s.entities["injection-lots"][stringValue(embryo["injectionLotId"])]
			if lot == nil || lot["active"] == false || lot["deletedAt"] != nil {
				continue
			}
			batch := s.entities["batches"][stringValue(lot["batchId"])]
			if batch == nil || batch["active"] == false || batch["deletedAt"] != nil {
				continue
			}
			if !s.filteredBatchIDsLocked(query)[stringValue(batch["id"])] {
				continue
			}
		} else if firstQuery(query, "batchId") != "" || firstQuery(query, "siteId") != "" || firstQuery(query, "operatorId") != "" || firstQuery(query, "treatmentGroupId") != "" {
			continue
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
		if stringValue(embryo["exitReason"]) == "PROMOTED" {
			count++
			continue
		}
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
	for _, point := range s.stageSurvivalLocked(embryos) {
		stage := intValue(point["stageOrder"])
		items = append(items, map[string]any{"stageOrder": stage, "stageCode": stageCode(stage), "stageLabel": stageLabel(stage), "alive": point["alive"], "riskSet": point["riskSet"], "pctOfActivated": percentage(intValue(point["alive"]), len(embryos))})
	}
	return items
}
func (s *apiServer) survivalLocked(embryos []map[string]any) []map[string]any {
	groups := map[string][]map[string]any{}
	for _, embryo := range embryos {
		lot := s.entities["injection-lots"][stringValue(embryo["injectionLotId"])]
		batch := s.entities["batches"][stringValue(lot["batchId"])]
		donor := s.entities["donor-cell-lines"][stringValue(lot["donorCellLineId"])]
		site := stringValue(batch["siteId"])
		strain := stringValue(donor["strain"])
		groups[site+"\x00"+strain] = append(groups[site+"\x00"+strain], embryo)
	}
	items := make([]map[string]any, 0, len(groups)*26)
	for key, group := range groups {
		parts := strings.SplitN(key, "\x00", 2)
		for _, point := range s.stageSurvivalLocked(group) {
			point["siteId"], point["strain"] = parts[0], parts[1]
			items = append(items, point)
		}
	}
	sort.Slice(items, func(i, j int) bool {
		if stringValue(items[i]["siteId"]) != stringValue(items[j]["siteId"]) {
			return stringValue(items[i]["siteId"]) < stringValue(items[j]["siteId"])
		}
		if stringValue(items[i]["strain"]) != stringValue(items[j]["strain"]) {
			return stringValue(items[i]["strain"]) < stringValue(items[j]["strain"])
		}
		return intValue(items[i]["stageOrder"]) < intValue(items[j]["stageOrder"])
	})
	return items
}

func (s *apiServer) stageSurvivalLocked(embryos []map[string]any) []map[string]any {
	items := make([]map[string]any, 0, 26)
	observationsByEmbryo := make(map[string][]map[string]any, len(embryos))
	for _, observation := range s.observations {
		if observation["deletedAt"] == nil {
			embryoID := stringValue(observation["embryoId"])
			if embryoID != "" {
				observationsByEmbryo[embryoID] = append(observationsByEmbryo[embryoID], observation)
			}
		}
	}
	previousAlive := 0
	surv := 1.0
	for stage := 1; stage <= 26; stage++ {
		risk, alive := 0, 0
		for _, embryo := range embryos {
			if !s.checkpointDueLocked(embryo, stage) {
				continue
			}
			risk++
			if s.checkpointStatusWithIndexLocked(embryo, stage, observationsByEmbryo) == "alive" {
				alive++
			}
		}
		nPrev := alive
		if stage > 1 {
			nPrev = previousAlive
			if nPrev > 0 {
				surv *= float64(alive) / float64(nPrev)
			}
		}
		nDead := nPrev - alive
		if nDead < 0 {
			nDead = 0
		}
		items = append(items, map[string]any{"stageOrder": stage, "stageLabel": stageLabel(stage), "riskSet": risk, "alive": alive, "nPrev": nPrev, "nDead": nDead, "surv": surv, "pctOfDevelopment": percentage(alive, firstAlive(items, alive))})
		previousAlive = alive
	}
	return items
}

func firstAlive(items []map[string]any, current int) int {
	if len(items) == 0 {
		return current
	}
	return intValue(items[0]["alive"])
}

func (s *apiServer) checkpointDueLocked(embryo map[string]any, stage int) bool {
	lot := s.entities["injection-lots"][stringValue(embryo["injectionLotId"])]
	activated, err := time.Parse(time.RFC3339, stringValue(lot["activatedAt"]))
	if err != nil {
		return false
	}
	return !time.Now().UTC().Before(activated.Add(time.Duration(s.expectedHPAForEmbryoLocked(map[string]any{"embryoId": embryo["id"], "stageCode": stageCode(stage)}) * float64(time.Hour))))
}

func (s *apiServer) checkpointStatusLocked(embryo map[string]any, stage int) string {
	observationsByEmbryo := map[string][]map[string]any{}
	embryoID := stringValue(embryo["id"])
	for _, observation := range s.observations {
		if observation["deletedAt"] == nil && stringValue(observation["embryoId"]) == embryoID {
			observationsByEmbryo[embryoID] = append(observationsByEmbryo[embryoID], observation)
		}
	}
	return s.checkpointStatusWithIndexLocked(embryo, stage, observationsByEmbryo)
}

func (s *apiServer) checkpointStatusWithIndexLocked(embryo map[string]any, stage int, observationsByEmbryo map[string][]map[string]any) string {
	embryoID := stringValue(embryo["id"])
	if observation := observationAtStageFromIndex(observationsByEmbryo[embryoID], stage); observation != nil {
		switch stringValue(observation["outcome"]) {
		case "ALIVE":
			return "alive"
		case "DEAD", "DEGENERATED":
			return "dead"
		case "NOT_OBSERVED":
			return "blank"
		}
	}
	if stringValue(embryo["exitReason"]) == "PROMOTED" && stage <= 26 {
		return "alive"
	}
	if exitStage := stageNumber(stringValue(embryo["exitStageCode"])); exitStage > 0 {
		if stage < exitStage {
			return "alive"
		}
		return "dead"
	}
	highestAlive := 0
	for _, observation := range observationsByEmbryo[embryoID] {
		if stringValue(observation["outcome"]) == "ALIVE" {
			if order := stageNumber(stringValue(observation["stageCode"])); order > highestAlive {
				highestAlive = order
			}
		}
	}
	if stage <= highestAlive {
		return "alive"
	}
	return "blank"
}

func observationAtStageFromIndex(observations []map[string]any, stage int) map[string]any {
	for _, observation := range observations {
		if stageNumber(stringValue(observation["stageCode"])) == stage {
			return observation
		}
	}
	return nil
}
func (s *apiServer) deviationLocked(embryos []map[string]any) []map[string]any {
	groups := map[string][]float64{}
	expected := map[string]float64{}
	groupMeta := map[string]map[string]any{}
	observationsByEmbryo := make(map[string][]map[string]any, len(embryos))
	for _, observation := range s.observations {
		if observation["deletedAt"] == nil {
			observationsByEmbryo[stringValue(observation["embryoId"])] = append(observationsByEmbryo[stringValue(observation["embryoId"])], observation)
		}
	}
	for _, embryo := range embryos {
		lot := s.entities["injection-lots"][stringValue(embryo["injectionLotId"])]
		batch := s.entities["batches"][stringValue(lot["batchId"])]
		donor := s.entities["donor-cell-lines"][stringValue(lot["donorCellLineId"])]
		treatment := s.entities["treatment-groups"][stringValue(batch["treatmentGroupId"])]
		for _, observation := range observationsByEmbryo[stringValue(embryo["id"])] {
			if observation["deletedAt"] == nil {
				stage := stageNumber(stringValue(observation["stageCode"]))
				key := fmt.Sprintf("%s|%s|%s|%d", stringValue(batch["siteId"]), stringValue(donor["strain"]), stringValue(treatment["code"]), stage)
				groups[key] = append(groups[key], floatValue(observation["deviationH"]))
				expected[key] = numberValue(observation["hpaExpectedSnapshot"])
				groupMeta[key] = map[string]any{"siteId": batch["siteId"], "site": stringValue(s.entities["sites"][stringValue(batch["siteId"])]["code"]), "strain": donor["strain"], "treatmentGroupId": treatment["id"], "treatmentGroup": treatment["code"], "stageOrder": stage}
			}
		}
	}
	items := make([]map[string]any, 0, len(groups))
	for key, values := range groups {
		stage := intValue(groupMeta[key]["stageOrder"])
		sort.Float64s(values)
		sum := 0.0
		for _, value := range values {
			sum += value
		}
		median := values[len(values)/2]
		if len(values)%2 == 0 {
			median = (values[len(values)/2-1] + values[len(values)/2]) / 2
		}
		mean := sum / float64(len(values))
		var variance float64
		for _, value := range values {
			variance += (value - mean) * (value - mean)
		}
		var sd any
		if len(values) > 1 {
			sd = math.Sqrt(variance / float64(len(values)-1))
		}
		row := cloneMap(groupMeta[key])
		row["stageLabel"], row["expectedHpa"], row["n"], row["meanDeviationH"], row["medianDeviationH"], row["sdDeviationH"], row["minDeviationH"], row["maxDeviationH"] = stageLabel(stage), expected[key], len(values), round4(mean), round4(median), sd, round4(values[0]), round4(values[len(values)-1])
		items = append(items, row)
	}
	sort.Slice(items, func(i, j int) bool {
		if intValue(items[i]["stageOrder"]) != intValue(items[j]["stageOrder"]) {
			return intValue(items[i]["stageOrder"]) < intValue(items[j]["stageOrder"])
		}
		return stringValue(items[i]["treatmentGroup"]) < stringValue(items[j]["treatmentGroup"])
	})
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
	sort.Slice(items, func(i, j int) bool { return intValue(items[i]["stageOrder"]) < intValue(items[j]["stageOrder"]) })
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
	split := strings.EqualFold(firstQuery(query, "splitByCondition"), "true")
	groups := map[string]map[string]map[string]any{"ALL": fishItems}
	if split {
		groups = map[string]map[string]map[string]any{}
		for id, fish := range fishItems {
			condition := stringValue(fish["condition"])
			if condition == "" {
				condition = "UNDETERMINED"
			}
			if groups[condition] == nil {
				groups[condition] = map[string]map[string]any{}
			}
			groups[condition][id] = fish
		}
	}
	items := make([]map[string]any, 0, (maxAge+1)*len(groups))
	today := time.Now().In(bangkokLocation()).Format("2006-01-02")
	for condition, group := range groups {
		for age := 0; age <= maxAge; age++ {
			atRisk, alive := 0, 0
			for _, fish := range group {
				observedAge := ageDaysOn(stringValue(fish["dob"]), today)
				if observedAge == 0 && stringValue(fish["dob"]) != today {
					continue
				}
				if observedAge >= age {
					atRisk++
					if stringValue(fish["status"]) == "ALIVE" || s.exitAgeLocked(fish) > age {
						alive++
					}
				}
			}
			row := map[string]any{"ageDays": age, "atRisk": atRisk, "alive": alive, "surv": percentage(alive, atRisk) / 100}
			if split {
				row["condition"] = condition
			}
			items = append(items, row)
		}
	}
	return items
}
func (s *apiServer) exitAgeLocked(fish map[string]any) int {
	return ageDaysOn(stringValue(fish["dob"]), stringValue(fish["exitDate"]))
}
func (s *apiServer) gapsLocked(query map[string][]string) []map[string]any {
	items := make([]map[string]any, 0)
	today := time.Now().In(bangkokLocation()).Format("2006-01-02")
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
	aliveFish := countFish(s.filteredFishLocked(query), "ALIVE")
	counts := []struct {
		step  string
		count int
	}{{"Activated", start}, {"Reached Shield", shield}, {"Reached Day 1", day1}, {"Promoted", promoted}, {"Alive Fish", aliveFish}}
	items := make([]map[string]any, 0, len(counts))
	previous := start
	for _, entry := range counts {
		items = append(items, map[string]any{"step": entry.step, "count": entry.count, "pctOfStart": percentage(entry.count, start) / 100, "pctOfPrevious": percentage(entry.count, previous) / 100})
		previous = entry.count
	}
	return items
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

package httpapi

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/P-PrPas/ChronoFish/backend/internal/export"
)

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
		filters := r.URL.Query()
		var request struct {
			Filters map[string]any `json:"filters"`
		}
		if r.Body != nil {
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil && !errors.Is(err, io.EOF) {
				writeAPIError(w, http.StatusBadRequest, "invalid_json", "ข้อมูล JSON ไม่ถูกต้อง")
				return true
			}
			filters = queryFromMap(request.Filters)
		}
		workbook, err := s.buildWorkbook(filters)
		if err != nil {
			writeAPIError(w, http.StatusInternalServerError, "export_failed", "สร้างไฟล์ Excel ไม่สำเร็จ")
			return true
		}
		w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
		w.Header().Set("Content-Disposition", "attachment; filename=chronofish-export.xlsx")
		_, _ = w.Write(workbook)
		return true
	}
	return false
}

func queryFromMap(input map[string]any) map[string][]string {
	query := make(map[string][]string)
	for key, value := range input {
		if text := stringValue(value); text != "" {
			query[key] = []string{text}
		}
	}
	return query
}

type workbookSheet struct {
	name    string
	headers []string
	rows    [][]string
}

func (s *apiServer) buildWorkbook(query ...map[string][]string) ([]byte, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	filters := map[string][]string(nil)
	if len(query) > 0 {
		filters = query[0]
	}
	embryos := s.filteredEmbryos(filters)
	fish := s.filteredFishLocked(filters)
	profile := s.entities["timing-profiles"]["01900000-0000-7000-8000-000000000002"]
	sheets := []workbookSheet{
		{name: "00_Metadata", headers: []string{"key", "value"}},
		{name: "01_Batches", headers: []string{"batch_code", "experiment_date", "site", "operator", "treatment_group", "clutch_code", "replicate_no", "recipient_egg_lot", "csof_lot", "incubation_temp_c", "lot_no", "donor_strain", "donor_preparation", "donor_batch_code", "enu_power_pct", "enu_pulse_us", "enu_led", "enu_start_at", "enu_finish_at", "activated_at", "n_eggs", "n_activated", "notes"}, rows: s.batchExportRows(filters)},
		{name: "02_Embryo_Observations", headers: []string{"embryo_code", "batch_code", "lot_no", "well_position", "stage_code", "stage_order", "stage_label", "observed_at", "hpa_actual", "hpa_expected", "deviation_h", "deviation_pct", "outcome", "condition", "operator", "is_backdated", "notes"}, rows: s.embryoObservationExportRows(embryos)},
		{name: "03_Embryo_Matrix", headers: append([]string{"embryo_code", "batch_code", "site", "strain", "treatment_group"}, stageCodes(26)...), rows: s.embryoMatrixExportRows(embryos)},
		{name: "04_Stage_Counts", headers: []string{"site", "strain", "treatment_group", "batch_code", "stage_order", "stage_label", "risk_set", "alive", "n_prev", "n_dead", "surv", "pct_of_development"}, rows: s.stageCountExportRows(embryos)},
		{name: "05_Timing_Deviation", headers: []string{"site", "strain", "treatment_group", "stage_order", "stage_label", "n", "mean_deviation_h", "median_deviation_h", "sd_deviation_h", "min_deviation_h", "max_deviation_h"}, rows: s.timingDeviationExportRows(embryos)},
		{name: "06_Fish_Register", headers: []string{"fish_code", "running_no", "dob", "strain", "donor_batch_code", "site", "fish_box", "status", "condition", "first_abnormal_on", "first_abnormal_age_days", "sex", "fin_clipped", "exit_date", "exit_reason", "age_days_current", "embryo_code", "remarks"}, rows: s.fishRegisterExportRows(fish)},
		{name: "07_Fish_Observations", headers: []string{"fish_code", "observed_on", "age_days", "outcome", "condition", "operator", "is_backdated", "notes"}, rows: s.fishObservationExportRows(fish)},
		{name: "08_Fish_Matrix", headers: append([]string{"fish_code", "dob", "strain", "status"}, fishMatrixColumns(fish, s.fishObs)...), rows: s.fishMatrixExportRows(fish)},
		{name: "09_Control_Arms", headers: []string{"batch_code", "experiment_date", "site", "arm_type", "stage_label", "n_normal", "n_abnormal"}, rows: s.controlExportRows()},
		{name: "10_Specimens", headers: []string{"specimen_code", "fish_code", "specimen_kind", "specimen_type", "collected_on", "frozen_on", "storage", "notes"}, rows: s.specimenExportRows(fish)},
		{name: "11_Summary", headers: []string{"strain", "n_batches", "n_eggs", "n_activated", "n_reached_shield", "n_reached_day1", "n_promoted", "n_normal", "n_abnormal", "pct_normal", "pct_abnormal"}, rows: s.summaryExportRows(embryos, fish)},
		{name: "12_R_Analysis_Table", headers: append([]string{"Sites", "Strain", "Replicate", "Strain_Rep"}, stageCodes(26)...), rows: s.rAnalysisExportRows(embryos)},
		{name: "13_Stage_Timing_Reference", headers: []string{"stage_order", "stage_code", "stage_label", "expected_hpa", "phase", "stage_scope", "profile_version", "reference_temp_c", "source_note"}, rows: timingReferenceRows(profile)},
	}
	metadata := [][]string{{"exported_at", time.Now().UTC().Format(time.RFC3339)}, {"filter", jsonString(filters)}, {"system_version", s.buildVersion}, {"timing_profile_version", fmt.Sprint(profile["version"])}}
	for _, sheet := range sheets[1:] {
		metadata = append(metadata, []string{"row_count." + sheet.name, strconv.Itoa(len(sheet.rows))})
	}
	sheets[0].rows = metadata
	exportSheets := make([]export.Sheet, len(sheets))
	for index, sheet := range sheets {
		exportSheets[index] = export.Sheet{Name: sheet.name, Headers: sheet.headers, Rows: sheet.rows}
	}
	return export.Build(exportSheets, s.buildVersion)
}

func stageCodes(max int) []string {
	codes := make([]string, 0, max)
	for stage := 1; stage <= max; stage++ {
		codes = append(codes, stageCode(stage))
	}
	return codes
}
func jsonString(value any) string { body, _ := json.Marshal(value); return string(body) }
func sortedIDs(records map[string]map[string]any) []string {
	ids := make([]string, 0, len(records))
	for id := range records {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}
func fishMatrixColumns(fish map[string]map[string]any, observations map[string]map[string]any) []string {
	max := 1
	for id := range fish {
		for _, observation := range observations {
			if stringValue(observation["cloneFishId"]) == id && intValue(observation["ageDays"]) > max {
				max = intValue(observation["ageDays"])
			}
		}
	}
	columns := make([]string, 0, max)
	for age := 1; age <= max; age++ {
		columns = append(columns, "d"+strconv.Itoa(age))
	}
	return columns
}
func (s *apiServer) batchExportRows(filters map[string][]string) [][]string {
	rows := [][]string{}
	allowed := s.filteredBatchIDsLocked(filters)
	for _, id := range sortedIDs(s.entities["batches"]) {
		if !allowed[id] {
			continue
		}
		batch := s.entities["batches"][id]
		for _, lotID := range sortedIDs(s.entities["injection-lots"]) {
			lot := s.entities["injection-lots"][lotID]
			if stringValue(lot["batchId"]) != id {
				continue
			}
			donor := s.entities["donor-cell-lines"][stringValue(lot["donorCellLineId"])]
			site := s.entities["sites"][stringValue(batch["siteId"])]
			operator := s.entities["operators"][stringValue(batch["operatorId"])]
			treatment := s.entities["treatment-groups"][stringValue(batch["treatmentGroupId"])]
			rows = append(rows, []string{stringValue(batch["batchCode"]), stringValue(batch["experimentDate"]), stringValue(site["code"]), stringValue(operator["name"]), stringValue(treatment["code"]), stringValue(batch["clutchCode"]), fmt.Sprint(batch["replicateNo"]), stringValue(batch["recipientEggLotId"]), stringValue(batch["csofLotId"]), fmt.Sprint(batch["incubationTempC"]), stringValue(lot["lotNo"]), stringValue(donor["strain"]), stringValue(donor["preparation"]), stringValue(donor["batchCode"]), fmt.Sprint(lot["enuPowerPct"]), fmt.Sprint(lot["enuPulseUs"]), fmt.Sprint(lot["enuLed"]), stringValue(lot["enuStartAt"]), stringValue(lot["enuFinishAt"]), stringValue(lot["activatedAt"]), fmt.Sprint(lot["nEggs"]), fmt.Sprint(lot["nActivated"]), stringValue(lot["notes"])})
		}
	}
	return rows
}
func (s *apiServer) embryoObservationExportRows(embryos []map[string]any) [][]string {
	allowed := map[string]bool{}
	for _, embryo := range embryos {
		allowed[stringValue(embryo["id"])] = true
	}
	rows := [][]string{}
	for _, id := range sortedIDs(s.observations) {
		observation := s.observations[id]
		if !allowed[stringValue(observation["embryoId"])] {
			continue
		}
		embryo := s.entities["embryos"][stringValue(observation["embryoId"])]
		lot := s.entities["injection-lots"][stringValue(embryo["injectionLotId"])]
		batch := s.entities["batches"][stringValue(lot["batchId"])]
		rows = append(rows, []string{stringValue(embryo["embryoCode"]), stringValue(batch["batchCode"]), stringValue(lot["lotNo"]), stringValue(embryo["wellPosition"]), stringValue(observation["stageCode"]), strconv.Itoa(stageNumber(stringValue(observation["stageCode"]))), stageLabel(stageNumber(stringValue(observation["stageCode"]))), stringValue(observation["observedAt"]), fmt.Sprint(observation["hpaActual"]), fmt.Sprint(observation["hpaExpectedSnapshot"]), fmt.Sprint(observation["deviationH"]), "", stringValue(observation["outcome"]), stringValue(observation["condition"]), stringValue(observation["operatorId"]), fmt.Sprint(observation["isBackdated"]), stringValue(observation["notes"])})
	}
	return rows
}
func (s *apiServer) embryoMatrixExportRows(embryos []map[string]any) [][]string {
	rows := [][]string{}
	for _, embryo := range embryos {
		lot := s.entities["injection-lots"][stringValue(embryo["injectionLotId"])]
		batch := s.entities["batches"][stringValue(lot["batchId"])]
		site := s.entities["sites"][stringValue(batch["siteId"])]
		donor := s.entities["donor-cell-lines"][stringValue(lot["donorCellLineId"])]
		treatment := s.entities["treatment-groups"][stringValue(batch["treatmentGroupId"])]
		row := []string{stringValue(embryo["embryoCode"]), stringValue(batch["batchCode"]), stringValue(site["code"]), stringValue(donor["strain"]), stringValue(treatment["code"])}
		for stage := 1; stage <= 26; stage++ {
			observation := s.observationAtStageLocked(stringValue(embryo["id"]), stage)
			value := ""
			if observation != nil {
				if stringValue(observation["outcome"]) == "ALIVE" {
					value = "1"
				} else if stringValue(observation["outcome"]) == "DEAD" || stringValue(observation["outcome"]) == "DEGENERATED" {
					value = "0"
				}
			}
			row = append(row, value)
		}
		rows = append(rows, row)
	}
	return rows
}
func (s *apiServer) stageCountExportRows(embryos []map[string]any) [][]string {
	rows := [][]string{}
	for _, record := range s.survivalLocked(embryos) {
		rows = append(rows, []string{"", "", "", "", fmt.Sprint(record["stageOrder"]), stringValue(record["stageLabel"]), fmt.Sprint(record["riskSet"]), fmt.Sprint(record["alive"]), fmt.Sprint(record["nPrev"]), fmt.Sprint(record["nDead"]), fmt.Sprint(record["surv"]), fmt.Sprint(record["pctOfDevelopment"])})
	}
	return rows
}
func (s *apiServer) timingDeviationExportRows(embryos []map[string]any) [][]string {
	rows := [][]string{}
	for _, record := range s.deviationLocked(embryos) {
		rows = append(rows, []string{"", "", "", fmt.Sprint(record["stageOrder"]), stringValue(record["stageLabel"]), fmt.Sprint(record["n"]), fmt.Sprint(record["meanDeviationH"]), fmt.Sprint(record["medianDeviationH"]), fmt.Sprint(record["sdDeviationH"]), fmt.Sprint(record["minDeviationH"]), fmt.Sprint(record["maxDeviationH"])})
	}
	return rows
}
func (s *apiServer) fishRegisterExportRows(fish map[string]map[string]any) [][]string {
	rows := [][]string{}
	for _, id := range sortedIDs(fish) {
		item := fish[id]
		donor := s.entities["donor-cell-lines"][stringValue(item["donorCellLineId"])]
		site := s.entities["sites"][stringValue(item["siteId"])]
		box := s.entities["fish-boxes"][stringValue(item["fishBoxId"])]
		embryo := s.entities["embryos"][stringValue(item["embryoId"])]
		rows = append(rows, []string{stringValue(item["fishCode"]), fmt.Sprint(item["runningNo"]), stringValue(item["dob"]), stringValue(donor["strain"]), stringValue(donor["batchCode"]), stringValue(site["code"]), stringValue(box["boxCode"]), stringValue(item["status"]), stringValue(item["condition"]), stringValue(item["firstAbnormalOn"]), fmt.Sprint(item["firstAbnormalAgeDays"]), stringValue(item["sex"]), fmt.Sprint(item["finClipped"]), stringValue(item["exitDate"]), stringValue(item["exitReason"]), strconv.Itoa(ageDays(stringValue(item["dob"]))), stringValue(embryo["embryoCode"]), stringValue(item["remarks"])})
	}
	return rows
}
func (s *apiServer) fishObservationExportRows(fish map[string]map[string]any) [][]string {
	rows := [][]string{}
	for _, id := range sortedIDs(s.fishObs) {
		observation := s.fishObs[id]
		if fish[stringValue(observation["cloneFishId"])] == nil {
			continue
		}
		item := fish[stringValue(observation["cloneFishId"])]
		rows = append(rows, []string{stringValue(item["fishCode"]), stringValue(observation["observedOn"]), fmt.Sprint(observation["ageDays"]), stringValue(observation["outcome"]), stringValue(observation["condition"]), stringValue(observation["operatorId"]), fmt.Sprint(observation["isBackdated"]), stringValue(observation["notes"])})
	}
	return rows
}
func (s *apiServer) fishMatrixExportRows(fish map[string]map[string]any) [][]string {
	columns := fishMatrixColumns(fish, s.fishObs)
	rows := [][]string{}
	for _, id := range sortedIDs(fish) {
		item := fish[id]
		donor := s.entities["donor-cell-lines"][stringValue(item["donorCellLineId"])]
		row := []string{stringValue(item["fishCode"]), stringValue(item["dob"]), stringValue(donor["strain"]), stringValue(item["status"])}
		for _, column := range columns {
			age, _ := strconv.Atoi(strings.TrimPrefix(column, "d"))
			value := ""
			for _, observation := range s.fishObs {
				if stringValue(observation["cloneFishId"]) == id && intValue(observation["ageDays"]) == age {
					if stringValue(observation["outcome"]) == "ALIVE" {
						value = "1"
					} else {
						value = "0"
					}
					break
				}
			}
			row = append(row, value)
		}
		rows = append(rows, row)
	}
	return rows
}
func (s *apiServer) controlExportRows() [][]string {
	rows := [][]string{}
	for _, id := range sortedIDs(s.entities["control-arm-counts"]) {
		item := s.entities["control-arm-counts"][id]
		batch := s.entities["batches"][stringValue(item["batchId"])]
		site := s.entities["sites"][stringValue(batch["siteId"])]
		rows = append(rows, []string{stringValue(batch["batchCode"]), stringValue(batch["experimentDate"]), stringValue(site["code"]), stringValue(item["armType"]), stageLabel(stageNumber(stringValue(item["stageCode"]))), fmt.Sprint(item["nNormal"]), fmt.Sprint(item["nAbnormal"])})
	}
	return rows
}
func (s *apiServer) specimenExportRows(fish map[string]map[string]any) [][]string {
	rows := [][]string{}
	for _, id := range sortedIDs(s.entities["specimens"]) {
		item := s.entities["specimens"][id]
		fishItem := fish[stringValue(item["cloneFishId"])]
		if fishItem == nil {
			continue
		}
		rows = append(rows, []string{stringValue(item["specimenCode"]), stringValue(fishItem["fishCode"]), stringValue(item["specimenKind"]), stringValue(item["specimenType"]), stringValue(item["collectedOn"]), stringValue(item["frozenOn"]), stringValue(item["storage"]), stringValue(item["notes"])})
	}
	return rows
}
func (s *apiServer) summaryExportRows(embryos []map[string]any, fish map[string]map[string]any) [][]string {
	groups := map[string][]map[string]any{}
	for _, embryo := range embryos {
		lot := s.entities["injection-lots"][stringValue(embryo["injectionLotId"])]
		donor := s.entities["donor-cell-lines"][stringValue(lot["donorCellLineId"])]
		groups[stringValue(donor["strain"])] = append(groups[stringValue(donor["strain"])], embryo)
	}
	rows := [][]string{}
	for strain, group := range groups {
		normal, abnormal, batches := 0, 0, map[string]bool{}
		for _, embryo := range group {
			lot := s.entities["injection-lots"][stringValue(embryo["injectionLotId"])]
			batches[stringValue(lot["batchId"])] = true
			if observation := s.latestEmbryoObservationLocked(stringValue(embryo["id"])); observation != nil {
				if stringValue(observation["condition"]) == "NORMAL" {
					normal++
				}
				if stringValue(observation["condition"]) == "ABNORMAL" {
					abnormal++
				}
			}
		}
		promoted := 0
		for _, item := range fish {
			donor := s.entities["donor-cell-lines"][stringValue(item["donorCellLineId"])]
			if stringValue(donor["strain"]) == strain {
				promoted++
			}
		}
		rows = append(rows, []string{strain, strconv.Itoa(len(batches)), "", strconv.Itoa(len(group)), strconv.Itoa(s.reachedStageCountLocked(group, 19)), strconv.Itoa(s.reachedStageCountLocked(group, 22)), strconv.Itoa(promoted), strconv.Itoa(normal), strconv.Itoa(abnormal), fmt.Sprint(percentage(normal, len(group))), fmt.Sprint(percentage(abnormal, len(group)))})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i][0] < rows[j][0] })
	return rows
}
func (s *apiServer) rAnalysisExportRows(embryos []map[string]any) [][]string {
	type group struct {
		site, strain, replicate string
		embryos                 []map[string]any
	}
	groups := map[string]*group{}
	for _, embryo := range embryos {
		lot := s.entities["injection-lots"][stringValue(embryo["injectionLotId"])]
		batch := s.entities["batches"][stringValue(lot["batchId"])]
		site := s.entities["sites"][stringValue(batch["siteId"])]
		donor := s.entities["donor-cell-lines"][stringValue(lot["donorCellLineId"])]
		replicate := stringValue(batch["replicateNo"])
		key := stringValue(site["code"]) + "\x00" + stringValue(donor["strain"]) + "\x00" + replicate
		if groups[key] == nil {
			groups[key] = &group{site: stringValue(site["code"]), strain: stringValue(donor["strain"]), replicate: replicate}
		}
		groups[key].embryos = append(groups[key].embryos, embryo)
	}
	keys := make([]string, 0, len(groups))
	for key := range groups {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	rows := make([][]string, 0, len(keys))
	for _, key := range keys {
		item := groups[key]
		row := []string{item.site, item.strain, item.replicate, item.strain + "_" + item.replicate}
		for stage := 1; stage <= 26; stage++ {
			alive := 0
			for _, embryo := range item.embryos {
				if observation := s.observationAtStageLocked(stringValue(embryo["id"]), stage); observation != nil && stringValue(observation["outcome"]) == "ALIVE" {
					alive++
				}
			}
			row = append(row, strconv.Itoa(alive))
		}
		rows = append(rows, row)
	}
	return rows
}
func timingReferenceRows(profile map[string]any) [][]string {
	rows := [][]string{}
	entries, _ := profile["entries"].([]any)
	for _, value := range entries {
		item, _ := value.(map[string]any)
		rows = append(rows, []string{fmt.Sprint(item["stageOrder"]), stringValue(item["stageCode"]), stringValue(item["stageLabel"]), fmt.Sprint(item["expectedHpa"]), stringValue(item["phase"]), stringValue(item["stageScope"]), fmt.Sprint(profile["version"]), fmt.Sprint(profile["referenceTempC"]), stringValue(profile["sourceNote"])})
	}
	return rows
}

func analyticRows(records []map[string]any, fields []string) [][]string {
	rows := make([][]string, 0, len(records))
	for _, record := range records {
		row := make([]string, len(fields))
		for index, field := range fields {
			row[index] = fmt.Sprint(record[field])
		}
		rows = append(rows, row)
	}
	return rows
}

func mapFromSlice(items []map[string]any) map[string]map[string]any {
	result := make(map[string]map[string]any, len(items))
	for index, item := range items {
		result[strconv.Itoa(index)] = item
	}
	return result
}

func mapSheet(name string, records map[string]map[string]any) workbookSheet {
	keys := map[string]bool{}
	for _, record := range records {
		for key := range record {
			keys[key] = true
		}
	}
	headers := make([]string, 0, len(keys))
	for key := range keys {
		headers = append(headers, key)
	}
	sort.Strings(headers)
	rows := make([][]string, 0, len(records))
	ids := make([]string, 0, len(records))
	for id := range records {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		row := make([]string, len(headers))
		for index, key := range headers {
			row[index] = fmt.Sprint(records[id][key])
		}
		rows = append(rows, row)
	}
	if len(headers) == 0 {
		headers = []string{"record_id"}
	}
	return workbookSheet{name: name, headers: headers, rows: rows}
}

func rTableRows(records map[string]map[string]any) [][]string {
	ids := make([]string, 0, len(records))
	for id := range records {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	rows := make([][]string, 0, len(ids))
	for _, id := range ids {
		fish := records[id]
		rows = append(rows, []string{"", stringValue(fish["strain"]), fmt.Sprint(fish["replicateNo"]), "", stringValue(fish["fishCode"]), stringValue(fish["status"]), stringValue(fish["condition"])})
	}
	return rows
}

func xmlText(value string) string { return html.EscapeString(value) }
func contentTypesXML(count int) string {
	parts := []string{`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`}
	for index := 1; index <= count; index++ {
		parts = append(parts, fmt.Sprintf(`<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`, index))
	}
	return strings.Join(parts, "") + `</Types>`
}
func relsXML() string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`
}
func workbookXML(sheets []workbookSheet) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>`)
	for index, sheet := range sheets {
		fmt.Fprintf(&b, `<sheet name="%s" sheetId="%d" r:id="rId%d"/>`, xmlText(sheet.name), index+1, index+1)
	}
	b.WriteString(`</sheets></workbook>`)
	return b.String()
}
func workbookRelsXML(count int) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`)
	for index := 1; index <= count; index++ {
		fmt.Fprintf(&b, `<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet%d.xml"/>`, index, index)
	}
	b.WriteString(`<Relationship Id="rId50" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`)
	return b.String()
}
func stylesXML() string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" applyFont="1"/></cellXfs></styleSheet>`
}
func coreXML() string {
	return `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">ChronoFish export</dc:title><dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">ChronoFish</dc:creator></cp:coreProperties>`
}
func appXML(count int) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>ChronoFish</Application><Sheets>%d</Sheets></Properties>`, count)
}
func sheetXML(sheet workbookSheet) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`)
	rowNumber := 1
	writeRowXML(&b, rowNumber, sheet.headers, true)
	for _, row := range sheet.rows {
		rowNumber++
		writeRowXML(&b, rowNumber, row, false)
	}
	b.WriteString(`</sheetData></worksheet>`)
	return b.String()
}
func writeRowXML(b *strings.Builder, rowNumber int, values []string, header bool) {
	fmt.Fprintf(b, `<row r="%d">`, rowNumber)
	for index, value := range values {
		cell := columnName(index+1) + strconv.Itoa(rowNumber)
		style := ""
		if header {
			style = ` s="1"`
		}
		if !header && value != "" {
			if _, err := strconv.ParseFloat(value, 64); err == nil {
				fmt.Fprintf(b, `<c r="%s"%s><v>%s</v></c>`, cell, style, xmlText(value))
				continue
			}
		}
		fmt.Fprintf(b, `<c r="%s" t="inlineStr"%s><is><t>%s</t></is></c>`, cell, style, xmlText(value))
	}
	b.WriteString(`</row>`)
}
func columnName(number int) string {
	result := ""
	for number > 0 {
		number--
		result = string(rune('A'+number%26)) + result
		number /= 26
	}
	return result
}

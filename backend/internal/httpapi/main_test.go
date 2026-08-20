package httpapi

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHealth(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)

	newHandler("test", "").ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}

	var response healthResponse
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.Status != "ok" || response.Version != "test" {
		t.Fatalf("response = %#v", response)
	}
	if contentType := recorder.Header().Get("Content-Type"); contentType != "application/json; charset=utf-8" {
		t.Fatalf("content type = %q", contentType)
	}
}

func TestCORS(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodOptions, "/api/v1/health", nil)
	request.Header.Set("Origin", "https://chronofish.example")

	newHandler("test", "https://chronofish.example").ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusNoContent)
	}
	if origin := recorder.Header().Get("Access-Control-Allow-Origin"); origin != "https://chronofish.example" {
		t.Fatalf("allowed origin = %q", origin)
	}
}

func TestMasterDataCreateTrimsAndRejectsDuplicate(t *testing.T) {
	handler := newHandler("test", "")
	keyNumber := 100
	create := func(body string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/v1/sites", bytes.NewBufferString(body))
		request.Header.Set("X-Operator-Id", "00000000-0000-7000-8000-000000000001")
		request.Header.Set("X-Device-Id", "device-1")
		keyNumber++
		request.Header.Set("X-Idempotency-Key", fmt.Sprintf("01900000-0000-7000-8000-%012d", keyNumber))
		handler.ServeHTTP(recorder, request)
		return recorder
	}
	first := create(`{"code":"  Lab-A ","name":" Main site "}`)
	if first.Code != http.StatusCreated {
		t.Fatalf("first create status = %d", first.Code)
	}
	var item map[string]any
	if err := json.Unmarshal(first.Body.Bytes(), &item); err != nil {
		t.Fatal(err)
	}
	if item["code"] != "Lab-A" || item["name"] != "Main site" {
		t.Fatalf("item was not normalized: %#v", item)
	}
	if duplicate := create(`{"code":"lab-a","name":"Other"}`); duplicate.Code != http.StatusConflict {
		t.Fatalf("duplicate status = %d, want %d", duplicate.Code, http.StatusConflict)
	}
}

func TestEmbryoObservationIsIdempotent(t *testing.T) {
	handler := newHandler("test", "")
	keyNumber := 200
	request := func(method, path, body string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
		req.Header.Set("X-Operator-Id", "00000000-0000-7000-8000-000000000001")
		req.Header.Set("X-Device-Id", "device-1")
		keyNumber++
		req.Header.Set("X-Idempotency-Key", fmt.Sprintf("01900000-0000-7000-8000-%012d", keyNumber))
		handler.ServeHTTP(recorder, req)
		return recorder
	}
	site := request(http.MethodPost, "/api/v1/sites", `{"code":"lab","name":"Lab"}`)
	var siteItem map[string]any
	_ = json.Unmarshal(site.Body.Bytes(), &siteItem)
	operator := request(http.MethodPost, "/api/v1/operators", `{"name":"tech"}`)
	var operatorItem map[string]any
	_ = json.Unmarshal(operator.Body.Bytes(), &operatorItem)
	donor := request(http.MethodPost, "/api/v1/donor-cell-lines", `{"strain":"AB","preparation":"CHUNKS"}`)
	var donorItem map[string]any
	_ = json.Unmarshal(donor.Body.Bytes(), &donorItem)
	treatment := request(http.MethodPost, "/api/v1/treatment-groups", `{"code":"tg-1","armType":"SCNT"}`)
	var treatmentItem map[string]any
	_ = json.Unmarshal(treatment.Body.Bytes(), &treatmentItem)
	batch := request(http.MethodPost, "/api/v1/batches", `{"experimentDate":"2026-08-20","siteId":"`+siteItem["id"].(string)+`","operatorId":"`+operatorItem["id"].(string)+`","protocolId":"01900000-0000-7000-8000-000000000001","treatmentGroupId":"`+treatmentItem["id"].(string)+`"}`)
	var batchItem map[string]any
	_ = json.Unmarshal(batch.Body.Bytes(), &batchItem)
	lot := request(http.MethodPost, "/api/v1/batches/"+batchItem["id"].(string)+"/injection-lots", `{"lotNo":"1","donorCellLineId":"`+donorItem["id"].(string)+`","activatedAt":"2026-08-20T00:00:00Z","nActivated":1}`)
	var lotItem map[string]any
	_ = json.Unmarshal(lot.Body.Bytes(), &lotItem)
	embryos := lotItem["embryos"].([]any)
	embryoID := embryos[0].(map[string]any)["id"].(string)
	body := `{"observations":[{"clientUuid":"01900000-0000-7000-8000-000000000010","embryoId":"` + embryoID + `","stageCode":"stage_02","observedAt":"2026-08-20T01:00:00Z","outcome":"ALIVE","condition":"NORMAL"}]}`
	first := request(http.MethodPost, "/api/v1/observations/embryo", body)
	if first.Code != http.StatusOK {
		t.Fatalf("first observation status = %d body=%s", first.Code, first.Body.String())
	}
	second := request(http.MethodPost, "/api/v1/observations/embryo", body)
	if second.Code != http.StatusOK {
		t.Fatalf("retry observation status = %d body=%s", second.Code, second.Body.String())
	}
	var result map[string]any
	_ = json.Unmarshal(second.Body.Bytes(), &result)
	if len(result["results"].([]any)) != 1 {
		t.Fatalf("retry result = %#v", result)
	}
}

func TestWorkbookHasFourteenSheets(t *testing.T) {
	server := newAPIServer()
	workbook, err := server.buildWorkbook()
	if err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(bytes.NewReader(workbook), int64(len(workbook)))
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, file := range archive.File {
		if len(file.Name) >= len("xl/worksheets/sheet") && file.Name[:len("xl/worksheets/sheet")] == "xl/worksheets/sheet" {
			count++
		}
	}
	if count != 14 {
		t.Fatalf("worksheet count = %d, want 14", count)
	}
	var workbookXML string
	for _, file := range archive.File {
		if file.Name == "xl/workbook.xml" {
			reader, readErr := file.Open()
			if readErr != nil {
				t.Fatal(readErr)
			}
			body, readErr := io.ReadAll(reader)
			_ = reader.Close()
			if readErr != nil {
				t.Fatal(readErr)
			}
			workbookXML = string(body)
		}
	}
	for _, name := range []string{"00_Metadata", "01_Batches", "02_Embryo_Observations", "03_Embryo_Matrix", "04_Stage_Counts", "05_Timing_Deviation", "06_Fish_Register", "07_Fish_Observations", "08_Fish_Matrix", "09_Control_Arms", "10_Specimens", "11_Summary", "12_R_Analysis_Table", "13_Stage_Timing_Reference"} {
		if !strings.Contains(workbookXML, `name="`+name+`"`) {
			t.Fatalf("workbook missing sheet %s", name)
		}
	}
}

func TestWorkbookExportUsesImpliedMatrixGroupedCountsAndRShape(t *testing.T) {
	server := newAPIServer()
	server.entities["sites"]["site-1"] = map[string]any{"id": "site-1", "code": "KU"}
	server.entities["donor-cell-lines"]["donor-1"] = map[string]any{"id": "donor-1", "strain": "AB", "preparation": "CHUNKS"}
	server.entities["treatment-groups"]["treatment-1"] = map[string]any{"id": "treatment-1", "code": "CONTROL"}
	server.entities["batches"]["batch-1"] = map[string]any{"id": "batch-1", "batchCode": "B-1", "siteId": "site-1", "treatmentGroupId": "treatment-1", "experimentDate": "2026-08-20", "replicateNo": 1, "timingProfileId": "01900000-0000-7000-8000-000000000002"}
	server.entities["injection-lots"]["lot-1"] = map[string]any{"id": "lot-1", "batchId": "batch-1", "donorCellLineId": "donor-1", "activatedAt": time.Now().UTC().Add(-200 * time.Hour).Format(time.RFC3339), "lotNo": "1", "nEggs": 3, "nActivated": 1}
	server.entities["embryos"]["embryo-1"] = map[string]any{"id": "embryo-1", "embryoCode": "B-1_1_1", "injectionLotId": "lot-1", "active": true}
	server.observations["observation-1"] = map[string]any{"id": "observation-1", "embryoId": "embryo-1", "stageCode": stageCode(5), "outcome": "ALIVE", "condition": "NORMAL", "hpaActual": 1.65, "hpaExpectedSnapshot": 1.5, "deviationH": 0.15}
	embryos := []map[string]any{server.entities["embryos"]["embryo-1"]}
	observationRows := server.embryoObservationExportRows(embryos)
	if len(observationRows) != 1 || observationRows[0][11] != "10.0000" {
		t.Fatalf("deviation percent row = %#v", observationRows)
	}
	matrix := server.embryoMatrixExportRows(embryos)[0]
	if matrix[5] != "1" || matrix[10] != "" {
		t.Fatalf("matrix values = stage1 %q, stage6 %q; want implied 1 then blank", matrix[5], matrix[10])
	}
	counts := server.stageCountExportRows(embryos)
	if len(counts) != 26 || counts[0][0] != "KU" || counts[0][3] != "B-1" {
		t.Fatalf("grouped stage count row = %#v", counts[0])
	}
	rRows := server.rAnalysisExportRows(embryos)
	if len(rRows) != 1 || rRows[0][4] != "1" || rRows[0][9] != "0" {
		t.Fatalf("R analysis row = %#v", rRows)
	}
	workbook, err := server.buildWorkbook()
	if err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(bytes.NewReader(workbook), int64(len(workbook)))
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range archive.File {
		if file.Name == "xl/worksheets/sheet1.xml" {
			reader, readErr := file.Open()
			if readErr != nil {
				t.Fatal(readErr)
			}
			body, readErr := io.ReadAll(reader)
			_ = reader.Close()
			if readErr != nil || !strings.Contains(string(body), "row_count.04_Stage_Counts") {
				t.Fatalf("metadata row counts missing: %v", readErr)
			}
		}
	}
}

func TestUUIDV7ShapeAndUniqueness(t *testing.T) {
	seen := make(map[string]bool)
	for index := 0; index < 100; index++ {
		id := uuidV7()
		if !isUUID(id) || id[14] != '7' || !strings.Contains("89ab", strings.ToLower(id[19:20])) {
			t.Fatalf("invalid UUIDv7: %s", id)
		}
		if seen[id] {
			t.Fatalf("duplicate UUID: %s", id)
		}
		seen[id] = true
	}
}

func TestExportIsBinaryAndIdempotent(t *testing.T) {
	handler := newHandler("test", "")
	request := func() *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/exports/excel", bytes.NewBufferString(`{"locale":"en"}`))
		req.Header.Set("X-Operator-Id", "00000000-0000-7000-8000-000000000001")
		req.Header.Set("X-Device-Id", "test-device")
		req.Header.Set("X-Idempotency-Key", "01900000-0000-7000-8000-000000000099")
		handler.ServeHTTP(recorder, req)
		return recorder
	}
	first, second := request(), request()
	if first.Code != http.StatusOK || second.Code != http.StatusOK {
		t.Fatalf("statuses = %d/%d", first.Code, second.Code)
	}
	if first.Header().Get("Content-Type") != "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" {
		t.Fatalf("content type = %q", first.Header().Get("Content-Type"))
	}
	if !bytes.Equal(first.Body.Bytes(), second.Body.Bytes()) {
		t.Fatal("idempotent export body changed")
	}
	if _, err := zip.NewReader(bytes.NewReader(second.Body.Bytes()), int64(second.Body.Len())); err != nil {
		t.Fatalf("retry is not xlsx: %v", err)
	}
}

func TestRTableHasNotebookShape(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/exports/r-table", nil)
	newHandler("test", "").ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	header := strings.Split(strings.TrimSpace(strings.SplitN(recorder.Body.String(), "\n", 2)[0]), ",")
	if len(header) != 30 || strings.Join(header[:4], ",") != "Sites,Strain,Replicate,Strain_Rep" {
		t.Fatalf("R table header = %#v", header)
	}
}

func TestTimingCSVImportCreatesVersion(t *testing.T) {
	handler := newHandler("test", "")
	req := httptest.NewRequest(http.MethodPost, "/api/v1/timing-profiles/csv", strings.NewReader("stage_order,stage_code,label,expected_hpa\n1,stage_01_1C,1-cell,0\n2,stage_02_2C,2-cell,0.75\n"))
	req.Header.Set("Content-Type", "text/csv")
	req.Header.Set("X-Operator-Id", "00000000-0000-7000-8000-000000000001")
	req.Header.Set("X-Device-Id", "test-device")
	req.Header.Set("X-Idempotency-Key", "01900000-0000-7000-8000-000000000120")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var profile map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &profile); err != nil {
		t.Fatal(err)
	}
	entries, ok := profile["entries"].([]any)
	if !ok || len(entries) != 2 {
		t.Fatalf("entries = %#v", profile["entries"])
	}
}

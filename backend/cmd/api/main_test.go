package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
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
	create := func(body string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/v1/sites", bytes.NewBufferString(body))
		request.Header.Set("X-Operator-Id", "operator-1")
		request.Header.Set("X-Device-Id", "device-1")
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
	request := func(method, path, body string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
		req.Header.Set("X-Operator-Id", "operator-1")
		req.Header.Set("X-Device-Id", "device-1")
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
	batch := request(http.MethodPost, "/api/v1/batches", `{"experimentDate":"2026-08-20","siteId":"`+siteItem["id"].(string)+`","operatorId":"`+operatorItem["id"].(string)+`","protocolId":"01900000-0000-7000-8000-000000000001","treatmentGroupId":"tg-1"}`)
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

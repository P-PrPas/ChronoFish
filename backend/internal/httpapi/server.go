package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/P-PrPas/ChronoFish/backend/internal/service"
	storepkg "github.com/P-PrPas/ChronoFish/backend/internal/store"
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
	buildVersion      string
	startupErr        error
	store             stateStore
	mu                sync.RWMutex
	entities          map[string]map[string]map[string]any
	audits            []map[string]any
	observations      map[string]map[string]any
	fishObs           map[string]map[string]any
	idempotency       map[string]json.RawMessage
	idempotencyStatus map[string]int
	idempotencyBinary map[string]bool
	idempotencyHash   map[string]string
	fishNo            int
}

func newAPIServer() *apiServer {
	s := &apiServer{
		buildVersion:      version,
		entities:          make(map[string]map[string]map[string]any),
		audits:            make([]map[string]any, 0),
		observations:      make(map[string]map[string]any),
		fishObs:           make(map[string]map[string]any),
		idempotency:       make(map[string]json.RawMessage),
		idempotencyStatus: make(map[string]int),
		idempotencyBinary: make(map[string]bool),
		idempotencyHash:   make(map[string]string),
		fishNo:            1,
	}
	for _, resource := range []string{"sites", "operators", "donor-cell-lines", "recipient-egg-lots", "csof-lots", "treatment-groups", "fish-boxes", "protocols", "timing-profiles", "batches", "injection-lots", "embryos", "fish", "specimens", "control-arm-counts"} {
		s.entities[resource] = make(map[string]map[string]any)
	}
	s.entities["operators"]["00000000-0000-7000-8000-000000000001"] = map[string]any{"id": "00000000-0000-7000-8000-000000000001", "name": "Demo operator", "active": true, "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"}
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
		label := stageLabel(i)
		entries = append(entries, map[string]any{"id": fmt.Sprintf("01900001-0000-7000-8000-%012d", i), "protocolId": protocol["id"], "stageOrder": i, "code": code, "label": label, "stageCode": code, "stageLabel": label, "shortLabel": label, "phase": "LARVAL", "stageScope": map[bool]string{true: "STAGE_1", false: "STAGE_2"}[i <= 26], "expectedHpa": expectedHPA(code)})
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
	if s.startupErr != nil {
		writeAPIError(w, http.StatusServiceUnavailable, "persistence_unavailable", "ฐานข้อมูลยังไม่พร้อมใช้งาน")
		return
	}
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
	if r.Method == http.MethodGet {
		if refresher, ok := s.store.(interface {
			RefreshReadModel(context.Context, *apiServer) error
		}); ok {
			if err := refresher.RefreshReadModel(r.Context(), s); err != nil {
				writeAPIError(w, http.StatusServiceUnavailable, "persistence_unavailable", "the committed read model is temporarily unavailable")
				return
			}
		}
	}
	mutation := r.Method != http.MethodGet && r.Method != http.MethodHead
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		if err := s.validateWriteContext(r, partsForContext(r.URL.Path)); err != nil {
			writeAPIError(w, http.StatusBadRequest, "invalid_context", err.Error())
			return
		}
	}
	idempotencyKey := r.Header.Get("X-Idempotency-Key")
	canonicalQuery := r.URL.Query().Encode()
	requestScope := "request:" + r.Method + ":" + r.URL.Path + "?" + canonicalQuery + ":" + idempotencyKey
	fingerprint := ""
	mutationLeaseToken := ""
	if mutation && r.Body != nil {
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
		if err != nil {
			writeAPIError(w, http.StatusRequestEntityTooLarge, "body_too_large", "request body ใหญ่เกิน 2 MiB")
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		fingerprintInput := r.Method + "\x00" + r.URL.Path + "?" + canonicalQuery + "\x00" + string(body)
		digest := sha256.Sum256([]byte(fingerprintInput))
		fingerprint = hex.EncodeToString(digest[:])
	}
	if mutation {
		if atomicStore, ok := s.store.(atomicStateStore); ok {
			reservation := storepkg.Mutation{Scope: requestScope, Key: idempotencyKey, RequestHash: fingerprint, OperatorID: r.Header.Get("X-Operator-Id"), DeviceID: r.Header.Get("X-Device-Id")}
			persistentStore, persistent := s.store.(service.Persistence)
			var reserved storepkg.Mutation
			var created bool
			var err error
			if persistent {
				reserved, created, err = service.Acquire(r.Context(), persistentStore, reservation)
			} else {
				reserved, created, err = atomicStore.Reserve(r.Context(), reservation)
			}
			if err != nil {
				if errors.Is(err, storepkg.ErrIdempotencyConflict) {
					writeAPIError(w, http.StatusConflict, "idempotency_conflict", "X-Idempotency-Key ถูกใช้กับ request อื่นแล้ว")
				} else {
					writeAPIError(w, http.StatusServiceUnavailable, "persistence_unavailable", "ฐานข้อมูลยังไม่พร้อมใช้งาน")
				}
				return
			}
			mutationLeaseToken = reserved.LeaseToken
			if !created {
				if reserved.Status == 102 {
					waitContext, cancel := context.WithTimeout(r.Context(), 15*time.Second)
					reserved, err = atomicStore.WaitForCompletion(waitContext, reservation)
					cancel()
					mutationLeaseToken = reserved.LeaseToken
					if err != nil {
						writeAPIError(w, http.StatusServiceUnavailable, "idempotency_in_progress", "request เดิมกำลังถูกประมวลผล")
						return
					}
					if reserved.LeaseOwner {
						created = true
					}
				}
				if !created {
					replayMutation(w, reserved)
					return
				}
			}
		} else {
			s.mu.RLock()
			previous := s.idempotency[requestScope]
			previousStatus := s.idempotencyStatus[requestScope]
			previousBinary := s.idempotencyBinary[requestScope]
			previousHash := s.idempotencyHash[requestScope]
			s.mu.RUnlock()
			if previous != nil || previousStatus > 0 {
				if previousHash != "" && fingerprint != "" && previousHash != fingerprint {
					writeAPIError(w, http.StatusConflict, "idempotency_conflict", "X-Idempotency-Key ถูกใช้กับ request อื่นแล้ว")
					return
				}
				if previousStatus == 0 {
					previousStatus = http.StatusOK
				}
				if previousStatus == http.StatusNoContent {
					w.WriteHeader(previousStatus)
					return
				}
				if previousBinary {
					var encoded string
					if json.Unmarshal(previous, &encoded) == nil {
						if body, err := base64.StdEncoding.DecodeString(encoded); err == nil {
							writeBytes(w, previousStatus, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body)
							return
						}
					}
				}
				writeRaw(w, previousStatus, previous)
				return
			}
		}
	}
	originalWriter := w
	var atomicStore atomicStateStore
	var deltaStore deltaStateStore
	var persistence service.Persistence
	var work *service.UnitOfWork
	var cacheBefore *mutationCacheJournal
	var before storepkg.State
	var reservation *storepkg.Mutation
	stopLeaseHeartbeat := func() {}
	if mutation {
		atomicStore, _ = s.store.(atomicStateStore)
		if atomicStore != nil {
			deltaStore, _ = s.store.(deltaStateStore)
			persistence, _ = s.store.(service.Persistence)
			if deltaStore != nil {
				work = service.NewUnitOfWork()
				cacheBefore = snapshotMutationCache(s)
				r = r.WithContext(context.WithValue(r.Context(), mutationDeltaContextKey{}, work))
				r = r.WithContext(context.WithValue(r.Context(), mutationCacheContextKey{}, cacheBefore))
			} else {
				before = stateFromServer(s)
			}
			reservation = &storepkg.Mutation{Scope: requestScope, Key: idempotencyKey, RequestHash: fingerprint, OperatorID: r.Header.Get("X-Operator-Id"), DeviceID: r.Header.Get("X-Device-Id")}
			reservation.LeaseToken = mutationLeaseToken
			if persistence != nil {
				stopLeaseHeartbeat = service.StartLeaseHeartbeat(r.Context(), persistence, *reservation)
				defer stopLeaseHeartbeat()
			}
		}
	}
	recorded := &responseRecorder{ResponseWriter: w}
	if mutation {
		w = recorded
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/")
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if handled := s.route(w, r, parts); !handled {
		writeAPIError(w, http.StatusNotFound, "not_found", "ไม่พบ endpoint ที่ร้องขอ")
	}
	if mutation && atomicStore != nil {
		if recorded.status == 0 {
			recorded.status = http.StatusOK
		}
		contentType := recorded.Header().Get("Content-Type")
		mutationResult := *reservation
		storedBody := append([]byte(nil), recorded.body...)
		if strings.Contains(contentType, "spreadsheetml") {
			storedBody = []byte(base64.StdEncoding.EncodeToString(recorded.body))
		}
		mutationResult.Status, mutationResult.ContentType, mutationResult.Body = recorded.status, contentType, storedBody
		var commitErr error
		if deltaStore != nil {
			commitErr = service.Commit(r.Context(), persistence, &service.Mutation{Request: mutationResult, Work: work})
		} else {
			after := stateFromServer(s)
			commitErr = atomicStore.Commit(r.Context(), &before, &after, &mutationResult)
		}
		if commitErr != nil {
			if persistence != nil {
				_ = service.Abort(context.Background(), persistence, mutationResult)
			} else {
				_ = atomicStore.Abort(context.Background(), mutationResult)
			}
			if deltaStore != nil {
				restoreDelta(s, work.Delta())
				restoreMutationCache(s, cacheBefore)
			} else {
				applyState(s, before)
			}
			log.Printf("persist mutation: %v", commitErr)
			writeAPIError(originalWriter, http.StatusServiceUnavailable, "persistence_unavailable", "ฐานข้อมูลยังไม่พร้อมใช้งาน")
			return
		}
		if deltaStore != nil {
			publishCommittedVersions(s, work.Delta())
		}
		s.mu.Lock()
		if strings.Contains(contentType, "spreadsheetml") {
			encoded, _ := json.Marshal(base64.StdEncoding.EncodeToString(recorded.body))
			s.idempotency[requestScope], s.idempotencyBinary[requestScope] = encoded, true
		} else {
			s.idempotency[requestScope], s.idempotencyBinary[requestScope] = append([]byte(nil), recorded.body...), false
		}
		s.idempotencyStatus[requestScope], s.idempotencyHash[requestScope] = recorded.status, fingerprint
		s.mu.Unlock()
	} else if mutation && recorded.status >= http.StatusOK && recorded.status < http.StatusBadRequest {
		s.mu.Lock()
		if strings.Contains(recorded.Header().Get("Content-Type"), "spreadsheetml") {
			encoded, _ := json.Marshal(base64.StdEncoding.EncodeToString(recorded.body))
			s.idempotency[requestScope], s.idempotencyBinary[requestScope] = encoded, true
		} else {
			s.idempotency[requestScope], s.idempotencyBinary[requestScope] = append([]byte(nil), recorded.body...), false
		}
		s.idempotencyStatus[requestScope], s.idempotencyHash[requestScope] = recorded.status, fingerprint
		s.mu.Unlock()
	}
	if s.store != nil && atomicStore == nil && mutation {
		if err := s.store.Save(context.Background(), s); err != nil {
			log.Printf("persist mutation: %v", err)
			writeAPIError(originalWriter, http.StatusServiceUnavailable, "persistence_unavailable", "ฐานข้อมูลยังไม่พร้อมใช้งาน")
			return
		}
	}
	if mutation {
		recorded.flush()
	}
}

func replayMutation(w http.ResponseWriter, mutation storepkg.Mutation) {
	if mutation.Status == http.StatusNoContent {
		w.WriteHeader(mutation.Status)
		return
	}
	if strings.Contains(mutation.ContentType, "spreadsheetml") {
		body, err := base64.StdEncoding.DecodeString(strings.Trim(string(mutation.Body), "\""))
		if err == nil {
			writeBytes(w, mutation.Status, mutation.ContentType, body)
			return
		}
		writeBytes(w, mutation.Status, mutation.ContentType, mutation.Body)
		return
	}
	if mutation.ContentType == "" || strings.Contains(mutation.ContentType, "application/json") {
		writeRaw(w, mutation.Status, mutation.Body)
		return
	}
	writeBytes(w, mutation.Status, mutation.ContentType, mutation.Body)
}

type responseRecorder struct {
	http.ResponseWriter
	status int
	body   []byte
}

func (r *responseRecorder) WriteHeader(status int) {
	if r.status != 0 {
		return
	}
	r.status = status
}

func (r *responseRecorder) Write(body []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	r.body = append(r.body, body...)
	return len(body), nil
}

func (r *responseRecorder) flush() {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	r.ResponseWriter.WriteHeader(r.status)
	if len(r.body) > 0 {
		_, _ = r.ResponseWriter.Write(r.body)
	}
}

func partsForContext(path string) []string {
	return strings.Split(strings.Trim(strings.TrimPrefix(path, "/api/v1/"), "/"), "/")
}

func (s *apiServer) validateWriteContext(r *http.Request, parts []string) error {
	operatorID := strings.TrimSpace(r.Header.Get("X-Operator-Id"))
	deviceID := strings.TrimSpace(r.Header.Get("X-Device-Id"))
	if !isUUID(operatorID) || deviceID == "" || len(deviceID) > 64 || strings.ContainsAny(deviceID, "\r\n") {
		return errors.New("X-Operator-Id ต้องเป็น UUID และ X-Device-Id ต้องมีความยาวไม่เกิน 64 ตัวอักษร")
	}
	if !(len(parts) > 0 && parts[0] == "operators" && len(parts) == 1 && r.Method == http.MethodPost) {
		s.mu.RLock()
		operator := s.entities["operators"][operatorID]
		s.mu.RUnlock()
		if operator == nil || operator["active"] == false {
			return errors.New("operator ไม่ถูกต้องหรือถูกปิดใช้งาน")
		}
	}
	key := r.Header.Get("X-Idempotency-Key")
	if key == "" || !isUUID(key) {
		return errors.New("ทุกการบันทึกต้องมี X-Idempotency-Key ที่เป็น UUID")
	}
	return nil
}

func isUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index, character := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if character != '-' {
				return false
			}
			continue
		}
		if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f') || (character >= 'A' && character <= 'F')) {
			return false
		}
	}
	return true
}

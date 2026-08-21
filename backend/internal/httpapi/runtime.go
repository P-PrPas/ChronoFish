package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strconv"
	"strings"

	storepkg "github.com/P-PrPas/ChronoFish/backend/internal/store"
)

// publishCommittedVersions advances only rows in the request write set after
// the SQL transaction has committed. It keeps the in-process read model's
// optimistic fence aligned with the canonical row_version without exposing an
// uncommitted value or reloading the whole database.
func publishCommittedVersions(server *apiServer, delta *storepkg.Delta) {
	if server == nil || delta == nil {
		return
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	bump := func(item map[string]any, before map[string]any) {
		if item == nil {
			return
		}
		if before == nil {
			item["rowVersion"] = int64(1)
			return
		}
		version := int64Value(before["rowVersion"])
		if version < 1 {
			version = 1
		}
		item["rowVersion"] = version + 1
	}
	for resource, records := range delta.After.Entities {
		for id := range records {
			if records[id] == nil {
				delete(server.entities[resource], id)
				continue
			}
			if server.entities[resource] == nil {
				server.entities[resource] = make(map[string]map[string]any)
			}
			published := cloneMap(records[id])
			bump(published, delta.Before.Entities[resource][id])
			server.entities[resource][id] = published
		}
	}
	for id := range delta.After.Observations {
		if delta.After.Observations[id] == nil {
			delete(server.observations, id)
			continue
		}
		published := cloneMap(delta.After.Observations[id])
		bump(published, delta.Before.Observations[id])
		server.observations[id] = published
	}
	for id := range delta.After.FishObservations {
		if delta.After.FishObservations[id] == nil {
			delete(server.fishObs, id)
			continue
		}
		published := cloneMap(delta.After.FishObservations[id])
		bump(published, delta.Before.FishObservations[id])
		server.fishObs[id] = published
	}
	for _, audit := range delta.Audits {
		server.audits = append(server.audits, cloneMap(audit))
	}
}

// mutationWorkingServer provides copy-on-write maps for SQL-backed writes.
// Only the aggregate/resource maps that the route can mutate are copied, and
// only existing records named by the route/body are deep-cloned. Untouched
// five-year collections remain shared read-only references. The returned
// server is discarded on a failed transaction, so uncommitted changes never
// enter the production process projection.
func mutationWorkingServer(source *apiServer, request *http.Request) *apiServer {
	source.mu.RLock()
	defer source.mu.RUnlock()
	working := newAPIServer()
	working.buildVersion, working.startupErr, working.store = source.buildVersion, source.startupErr, source.store
	working.entities = make(map[string]map[string]map[string]any, len(source.entities))
	for resource, records := range source.entities {
		working.entities[resource] = records
	}
	// Never share mutable collection headers with the production projection.
	// Handlers append observations/audits and consult idempotency during a
	// request; independent maps/slices keep those operations request-local even
	// before the SQL transaction has committed.
	working.observations = make(map[string]map[string]any, len(source.observations))
	for id, item := range source.observations {
		working.observations[id] = item
	}
	working.fishObs = make(map[string]map[string]any, len(source.fishObs))
	for id, item := range source.fishObs {
		working.fishObs[id] = item
	}
	working.audits = append([]map[string]any(nil), source.audits...)
	working.idempotency = make(map[string]json.RawMessage, len(source.idempotency))
	for key, body := range source.idempotency {
		working.idempotency[key] = append(json.RawMessage(nil), body...)
	}
	working.idempotencyStatus = make(map[string]int, len(source.idempotencyStatus))
	for key, status := range source.idempotencyStatus {
		working.idempotencyStatus[key] = status
	}
	working.idempotencyBinary = make(map[string]bool, len(source.idempotencyBinary))
	for key, binary := range source.idempotencyBinary {
		working.idempotencyBinary[key] = binary
	}
	working.idempotencyHash = make(map[string]string, len(source.idempotencyHash))
	for key, hash := range source.idempotencyHash {
		working.idempotencyHash[key] = hash
	}
	working.fishNo = source.fishNo

	ids := make(map[string]map[string]bool)
	addID := func(resource, id string) {
		if id == "" {
			return
		}
		if ids[resource] == nil {
			ids[resource] = make(map[string]bool)
		}
		ids[resource][id] = true
	}
	parts := partsForContext(request.URL.Path)
	first := ""
	if len(parts) > 0 {
		first = parts[0]
	}
	if len(parts) > 1 {
		switch first {
		case "sites", "operators", "donor-cell-lines", "recipient-egg-lots", "csof-lots", "treatment-groups", "fish-boxes", "protocols", "batches", "injection-lots", "embryos", "fish", "specimens", "control-arm-counts":
			resource := first
			if resource == "control-arm-counts" {
				resource = "control-arm-counts"
			}
			addID(resource, parts[1])
		case "observations":
			if len(parts) > 2 {
				if parts[1] == "embryo" {
					addID("observations", parts[2])
				} else if parts[1] == "fish" {
					addID("fish-observations", parts[2])
				}
			}
		}
	}
	if request.Body != nil {
		body, _ := io.ReadAll(request.Body)
		request.Body = io.NopCloser(strings.NewReader(string(body)))
		var value any
		if json.Unmarshal(body, &value) == nil {
			var collect func(any)
			collect = func(node any) {
				switch current := node.(type) {
				case map[string]any:
					addID("embryos", stringValue(current["embryoId"]))
					addID("fish", stringValue(current["cloneFishId"]))
					// Roll-call payloads use fishId while observation payloads use
					// cloneFishId. Both are request-scoped aggregate keys.
					addID("fish", stringValue(current["fishId"]))
					for _, child := range current {
						collect(child)
					}
				case []any:
					for _, child := range current {
						collect(child)
					}
				}
			}
			collect(value)
		}
	}
	for id := range ids["observations"] {
		if old := source.observations[id]; old != nil {
			addID("embryos", stringValue(old["embryoId"]))
		}
	}
	for id := range ids["fish-observations"] {
		if old := source.fishObs[id]; old != nil {
			addID("fish", stringValue(old["cloneFishId"]))
		}
	}

	cloneAll := map[string]bool{}
	cloneMapForWrite := func(resource string) {
		cloneAll[resource] = true
	}
	switch first {
	case "sites", "operators", "donor-cell-lines", "recipient-egg-lots", "csof-lots", "treatment-groups", "fish-boxes":
		cloneMapForWrite(first)
	case "protocols":
		cloneMapForWrite("protocols")
	case "timing-profiles":
		cloneMapForWrite("timing-profiles")
	case "batches":
		cloneMapForWrite("batches")
		cloneMapForWrite("injection-lots")
		cloneMapForWrite("embryos")
		cloneMapForWrite("control-arm-counts")
	case "injection-lots":
		cloneMapForWrite("injection-lots")
		cloneMapForWrite("embryos")
	case "embryos":
		cloneMapForWrite("embryos")
	case "fish":
		cloneMapForWrite("fish")
		cloneMapForWrite("specimens")
	case "specimens":
		cloneMapForWrite("specimens")
		cloneMapForWrite("fish")
	case "control-arm-counts":
		cloneMapForWrite("control-arm-counts")
	case "observations":
		cloneMapForWrite("observations")
		cloneMapForWrite("fish-observations")
		cloneMapForWrite("embryos")
		cloneMapForWrite("fish")
	case "promotions":
		cloneMapForWrite("fish")
		cloneMapForWrite("embryos")
	}
	// Nested routes identify their child record after the first resource
	// segment. Capture those IDs so PATCH/DELETE never edits a shared map value.
	if len(parts) >= 4 && parts[0] == "fish" && parts[2] == "specimens" {
		addID("specimens", parts[3])
	}
	for resource, records := range source.entities {
		if !cloneAll[resource] && len(ids[resource]) == 0 {
			continue
		}
		copyRecords := make(map[string]map[string]any, len(records))
		for id, item := range records {
			if ids[resource][id] {
				// Route/body-selected rows are always copy-on-write, even when
				// the surrounding aggregate collection is refreshed as a whole.
				copyRecords[id] = cloneMap(item)
			} else if cloneAll[resource] && (resource == "timing-profiles" || resource == "control-arm-counts") {
				// These two handlers may revise multiple existing rows (current
				// timing profile transition and PUT replacement). They are bounded
				// reference/configuration collections, so deep-copying them keeps
				// the copy-on-write guarantee without touching operational data.
				copyRecords[id] = cloneMap(item)
			} else if cloneAll[resource] {
				// Clone the index, not every row.  Business handlers only mutate
				// rows named by the route/body; read-only rows remain shared and
				// are never exposed to a write path. This keeps request setup
				// proportional to the affected aggregate at five-year scale.
				copyRecords[id] = item
			} else {
				copyRecords[id] = item
			}
		}
		working.entities[resource] = copyRecords
	}
	if first == "observations" || first == "promotions" {
		working.observations = cloneRecordMap(source.observations, ids["observations"])
		working.fishObs = cloneRecordMap(source.fishObs, ids["fish-observations"])
	}
	return working
}

func cloneRecordMap(source map[string]map[string]any, ids map[string]bool) map[string]map[string]any {
	copyRecords := make(map[string]map[string]any, len(source))
	for id, item := range source {
		if ids[id] {
			copyRecords[id] = cloneMap(item)
		} else {
			copyRecords[id] = item
		}
	}
	return copyRecords
}

func int64Value(value any) int64 {
	switch number := value.(type) {
	case int:
		return int64(number)
	case int64:
		return number
	case float64:
		return int64(number)
	case string:
		parsed, _ := strconv.ParseInt(number, 10, 64)
		return parsed
	default:
		return 0
	}
}

type stateStore interface {
	Load(context.Context, *apiServer) error
	Save(context.Context, *apiServer) error
	Close() error
}

type atomicStateStore interface {
	stateStore
	Reserve(context.Context, storepkg.Mutation) (storepkg.Mutation, bool, error)
	WaitForCompletion(context.Context, storepkg.Mutation) (storepkg.Mutation, error)
	Abort(context.Context, storepkg.Mutation) error
	Commit(context.Context, *storepkg.State, *storepkg.State, *storepkg.Mutation) error
}

type deltaStateStore interface {
	CommitDelta(context.Context, *storepkg.Delta, *storepkg.Mutation) error
}

type auditReader interface {
	QueryAudits(context.Context, storepkg.AuditQuery) ([]map[string]any, bool, error)
}

type dueReader interface {
	QueryDue(context.Context, storepkg.DueQuery) ([]map[string]any, []map[string]any, error)
}

type entityPageReader interface {
	QueryEntityPage(context.Context, storepkg.EntityPageQuery) ([]map[string]any, *string, error)
}

type canonicalReadModel interface {
	RefreshReadModelForRequest(context.Context, *apiServer, string) error
}

type canonicalMutationReadModel interface {
	RefreshMutationReadModelForRequest(context.Context, *apiServer, *http.Request) error
}

type operatorReader interface {
	OperatorActive(context.Context, string) (bool, error)
}

type mutationCacheValue struct {
	body    json.RawMessage
	present bool
}

type mutationCacheJournal struct {
	before  map[string]mutationCacheValue
	pending map[string]json.RawMessage
}

type memoryStateStore struct{}

func (memoryStateStore) Load(context.Context, *apiServer) error { return nil }
func (memoryStateStore) Save(context.Context, *apiServer) error { return nil }
func (memoryStateStore) Close() error                           { return nil }

type sqlStateStore struct {
	repository *storepkg.SQLRepository
}

func openStateStore(ctx context.Context, cfg config) (stateStore, error) {
	if cfg.dbDriver == "memory" {
		return memoryStateStore{}, nil
	}
	repository, err := storepkg.OpenSQLRepository(ctx, storepkg.SQLConfig{
		Driver: cfg.dbDriver, URL: cfg.databaseURL, MigrationsDir: cfg.migrationsDir,
		MaxOpenConns: cfg.maxOpenConns, MaxIdleConns: cfg.maxIdleConns, ConnMaxLifetime: cfg.connMaxLifetime,
	})
	if err != nil {
		return nil, err
	}
	return &sqlStateStore{repository: repository}, nil
}

func stateFromServer(server *apiServer) storepkg.State {
	server.mu.RLock()
	defer server.mu.RUnlock()
	return cloneState(storepkg.State{Entities: server.entities, Audits: server.audits, Observations: server.observations, FishObservations: server.fishObs, Idempotency: server.idempotency, IdempotencyStatus: server.idempotencyStatus, IdempotencyBinary: server.idempotencyBinary, IdempotencyHash: server.idempotencyHash, FishNo: server.fishNo})
}

func restoreDelta(server *apiServer, delta *storepkg.Delta) {
	server.mu.Lock()
	defer server.mu.Unlock()
	for resource, records := range delta.After.Entities {
		for id := range records {
			current := server.entities[resource][id]
			if !reflect.DeepEqual(current, records[id]) {
				continue
			}
			if before := delta.Before.Entities[resource][id]; before != nil {
				server.entities[resource][id] = cloneMap(before)
			} else {
				delete(server.entities[resource], id)
			}
		}
	}
	for id := range delta.After.Observations {
		if !reflect.DeepEqual(server.observations[id], delta.After.Observations[id]) {
			continue
		}
		if before := delta.Before.Observations[id]; before != nil {
			server.observations[id] = cloneMap(before)
		} else {
			delete(server.observations, id)
		}
	}
	for id := range delta.After.FishObservations {
		if !reflect.DeepEqual(server.fishObs[id], delta.After.FishObservations[id]) {
			continue
		}
		if before := delta.Before.FishObservations[id]; before != nil {
			server.fishObs[id] = cloneMap(before)
		} else {
			delete(server.fishObs, id)
		}
	}
	if len(delta.Audits) > 0 {
		ids := make(map[string]struct{}, len(delta.Audits))
		for _, audit := range delta.Audits {
			ids[stringValue(audit["id"])] = struct{}{}
		}
		kept := server.audits[:0]
		for _, audit := range server.audits {
			if _, remove := ids[stringValue(audit["id"])]; !remove {
				kept = append(kept, audit)
			}
		}
		server.audits = kept
	}
}

func snapshotMutationCache(server *apiServer) *mutationCacheJournal {
	return &mutationCacheJournal{before: make(map[string]mutationCacheValue), pending: make(map[string]json.RawMessage)}
}

func publishMutationCache(server *apiServer, journal *mutationCacheJournal) {
	if server == nil || journal == nil || len(journal.pending) == 0 {
		return
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	for key, body := range journal.pending {
		server.idempotency[key] = append(json.RawMessage(nil), body...)
	}
}

func restoreMutationCache(server *apiServer, journal *mutationCacheJournal) {
	if journal == nil {
		return
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	for key, previous := range journal.before {
		if previous.present {
			server.idempotency[key] = append(json.RawMessage(nil), previous.body...)
		} else {
			delete(server.idempotency, key)
		}
	}
}

func cloneState(state storepkg.State) storepkg.State {
	copyState := state
	copyState.Entities = make(map[string]map[string]map[string]any, len(state.Entities))
	for resource, records := range state.Entities {
		copyState.Entities[resource] = make(map[string]map[string]any, len(records))
		for id, item := range records {
			copyState.Entities[resource][id] = cloneMap(item)
		}
	}
	copyState.Audits = make([]map[string]any, len(state.Audits))
	for i, item := range state.Audits {
		copyState.Audits[i] = cloneMap(item)
	}
	copyState.Observations = make(map[string]map[string]any, len(state.Observations))
	for id, item := range state.Observations {
		copyState.Observations[id] = cloneMap(item)
	}
	copyState.FishObservations = make(map[string]map[string]any, len(state.FishObservations))
	for id, item := range state.FishObservations {
		copyState.FishObservations[id] = cloneMap(item)
	}
	copyState.Idempotency = make(map[string]json.RawMessage, len(state.Idempotency))
	for key, body := range state.Idempotency {
		copyState.Idempotency[key] = append(json.RawMessage(nil), body...)
	}
	copyState.IdempotencyStatus = mapsCloneInt(state.IdempotencyStatus)
	copyState.IdempotencyBinary = mapsCloneBool(state.IdempotencyBinary)
	copyState.IdempotencyHash = mapsCloneString(state.IdempotencyHash)
	return copyState
}

func mapsCloneInt(input map[string]int) map[string]int {
	output := make(map[string]int, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}

func mapsCloneBool(input map[string]bool) map[string]bool {
	output := make(map[string]bool, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}

func mapsCloneString(input map[string]string) map[string]string {
	output := make(map[string]string, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}

func applyState(server *apiServer, state storepkg.State) {
	server.mu.Lock()
	defer server.mu.Unlock()
	server.entities = state.Entities
	server.audits = state.Audits
	server.observations = state.Observations
	server.fishObs = state.FishObservations
	server.idempotency = state.Idempotency
	server.idempotencyStatus = state.IdempotencyStatus
	server.idempotencyBinary = state.IdempotencyBinary
	server.idempotencyHash = state.IdempotencyHash
	server.fishNo = state.FishNo
}

func (s *sqlStateStore) Load(ctx context.Context, server *apiServer) error {
	state := stateFromServer(server)
	if err := s.repository.Load(ctx, &state); err != nil {
		return err
	}
	applyState(server, state)
	return nil
}

// RefreshReadModel rehydrates the committed SQL view for a read request. SQL
// is authoritative across API instances; the in-process maps are only a
// derived view and are never the source of a successful write.
func (s *sqlStateStore) RefreshReadModel(ctx context.Context, server *apiServer) error {
	return s.Load(ctx, server)
}

// RefreshReadModelForRequest keeps the process view as a small, committed
// projection. Expensive analytical endpoints still opt into the complete
// projection because they genuinely need the related aggregates; master and
// detail endpoints refresh only their bounded dependency set.
func (s *sqlStateStore) RefreshReadModelForRequest(ctx context.Context, server *apiServer, path string) error {
	resource := strings.Trim(strings.TrimPrefix(path, "/api/v1/"), "/")
	if resource == "audit" {
		// The audit handler uses QueryAudits directly with filters/pagination.
		return nil
	}
	if strings.HasPrefix(resource, "analytics") || strings.HasPrefix(resource, "exports") {
		// Load only the operational rows used by reports.  Load intentionally
		// hydrates reference data at startup; using it here would leave a fresh
		// API instance with empty analytics/export results because the large
		// canonical collections are not startup state.
		return s.refreshResources(ctx, server,
			"batches", "injection-lots", "embryos", "fish", "specimens",
			"observations", "fish-observations", "donor-cell-lines", "operators",
			"sites", "fish-boxes", "protocols", "timing-profiles",
			"treatment-groups", "control-arm-counts")
	}
	if resource == "due" || resource == "due-checkpoints" {
		return s.refreshResources(ctx, server, "batches", "injection-lots", "embryos", "fish", "protocols", "timing-profiles", "observations", "fish-observations", "donor-cell-lines")
	}
	parts := strings.Split(resource, "/")
	if len(parts) == 1 {
		switch parts[0] {
		case "sites", "operators", "donor-cell-lines", "recipient-egg-lots", "csof-lots", "treatment-groups", "fish-boxes", "batches", "fish":
			// SQL list handlers page directly from canonical tables. Detail and
			// analytical routes still hydrate their bounded read projections.
			return nil
		}
	}
	resources := []string{}
	add := func(values ...string) { resources = append(resources, values...) }
	switch parts[0] {
	case "timing-profiles":
		add("protocols", "timing-profiles")
	case "batches":
		add("batches", "injection-lots", "embryos", "donor-cell-lines", "operators", "sites", "protocols", "timing-profiles", "treatment-groups", "control-arm-counts")
	case "injection-lots":
		add("injection-lots", "batches", "embryos", "donor-cell-lines", "timing-profiles", "protocols", "observations")
	case "embryos":
		add("embryos", "injection-lots", "batches", "timing-profiles", "protocols", "operators", "donor-cell-lines", "observations")
	case "fish":
		add("fish", "embryos", "injection-lots", "batches", "donor-cell-lines", "fish-boxes", "sites", "fish-observations", "specimens")
	case "promotions":
		add("embryos", "injection-lots", "batches", "protocols", "timing-profiles", "donor-cell-lines", "fish", "observations")
	case "observations":
		add("embryos", "injection-lots", "batches", "protocols", "timing-profiles", "operators", "donor-cell-lines", "fish", "observations", "fish-observations")
	case "specimens":
		add("specimens", "fish")
	case "control-arm-counts":
		add("control-arm-counts", "batches", "protocols", "timing-profiles")
	case "sites":
		add(parts[0])
	case "operators":
		add("operators", "sites")
	case "fish-boxes":
		add("fish-boxes", "sites")
	case "donor-cell-lines", "recipient-egg-lots", "csof-lots", "treatment-groups", "protocols":
		add(parts[0])
	default:
		return nil
	}
	return s.refreshResources(ctx, server, resources...)
}

// RefreshMutationReadModelForRequest keeps mutation validation request-scoped.
// In particular, observation replay/monotonic checks need only the submitted
// client UUIDs and affected embryo/fish aggregates, never the full history.
func (s *sqlStateStore) RefreshMutationReadModelForRequest(ctx context.Context, server *apiServer, request *http.Request) error {
	path := strings.Trim(strings.TrimPrefix(request.URL.Path, "/api/v1/"), "/")
	parts := strings.Split(path, "/")
	if len(parts) == 0 {
		return nil
	}
	if parts[0] != "observations" {
		// Create/update validation must begin from committed rows even when the
		// route is a collection endpoint. The old read optimisation returned
		// early for /batches and /sites, leaving a second API instance with a
		// stale uniqueness/reference view.
		if len(parts) == 1 && request.Method != http.MethodGet {
			switch parts[0] {
			case "sites", "operators", "donor-cell-lines", "recipient-egg-lots", "csof-lots", "treatment-groups", "fish-boxes":
				return s.refreshResources(ctx, server, parts[0])
			case "batches":
				return s.refreshResources(ctx, server, "batches", "sites", "operators", "protocols", "timing-profiles", "treatment-groups")
			case "timing-profiles":
				return s.refreshResources(ctx, server, "protocols", "timing-profiles")
			case "fish":
				return s.refreshResources(ctx, server, "fish", "embryos", "injection-lots", "batches", "donor-cell-lines", "sites", "fish-boxes")
			case "injection-lots":
				return s.refreshResources(ctx, server, "injection-lots", "batches", "donor-cell-lines", "embryos")
			case "embryos":
				return s.refreshResources(ctx, server, "embryos", "injection-lots", "batches")
			case "specimens":
				return s.refreshResources(ctx, server, "specimens", "fish")
			case "control-arm-counts":
				return s.refreshResources(ctx, server, "control-arm-counts", "batches", "protocols", "timing-profiles")
			}
		}
		return s.RefreshReadModelForRequest(ctx, server, request.URL.Path)
	}
	resources := []string{"embryos", "injection-lots", "batches", "protocols", "timing-profiles", "operators", "donor-cell-lines", "fish"}
	state := storepkg.State{Entities: make(map[string]map[string]map[string]any), Observations: make(map[string]map[string]any), FishObservations: make(map[string]map[string]any)}
	if err := s.repository.LoadResources(ctx, &state, resources...); err != nil {
		return err
	}
	clientUUIDs, embryoIDs, fishIDs, observationIDs := []string{}, []string{}, []string{}, []string{}
	if len(parts) >= 3 {
		observationIDs = append(observationIDs, parts[2])
	}
	body, err := io.ReadAll(request.Body)
	if err != nil {
		return err
	}
	request.Body = io.NopCloser(strings.NewReader(string(body)))
	var value any
	if json.Unmarshal(body, &value) == nil {
		var collect func(any)
		collect = func(node any) {
			switch current := node.(type) {
			case map[string]any:
				if id := stringValue(current["clientUuid"]); id != "" {
					clientUUIDs = append(clientUUIDs, id)
				}
				if id := stringValue(current["embryoId"]); id != "" {
					embryoIDs = append(embryoIDs, id)
				}
				if id := stringValue(current["cloneFishId"]); id != "" {
					fishIDs = append(fishIDs, id)
				}
				for _, child := range current {
					collect(child)
				}
			case []any:
				for _, child := range current {
					collect(child)
				}
			}
		}
		collect(value)
	}
	if err := s.repository.LoadObservationSubset(ctx, &state, observationIDs, clientUUIDs, embryoIDs, fishIDs); err != nil {
		return err
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	for resource, loaded := range state.Entities {
		server.entities[resource] = loaded
	}
	server.observations, server.fishObs = state.Observations, state.FishObservations
	return nil
}

func (s *sqlStateStore) refreshResources(ctx context.Context, server *apiServer, resources ...string) error {
	state := storepkg.State{Entities: make(map[string]map[string]map[string]any), Observations: make(map[string]map[string]any), FishObservations: make(map[string]map[string]any)}
	if err := s.repository.LoadResources(ctx, &state, resources...); err != nil {
		return err
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	for _, name := range resources {
		if loaded := state.Entities[name]; loaded != nil {
			server.entities[name] = loaded
		}
	}
	if state.Observations != nil && containsResource(resources, "observations") {
		server.observations = state.Observations
	}
	if state.FishObservations != nil && containsResource(resources, "fish-observations") {
		server.fishObs = state.FishObservations
	}
	return nil
}

func containsResource(resources []string, target string) bool {
	for _, resource := range resources {
		if resource == target {
			return true
		}
	}
	return false
}

func (s *sqlStateStore) Save(ctx context.Context, server *apiServer) error {
	state := stateFromServer(server)
	return s.repository.Save(ctx, &state)
}

func (s *sqlStateStore) Reserve(ctx context.Context, mutation storepkg.Mutation) (storepkg.Mutation, bool, error) {
	return s.repository.Reserve(ctx, mutation)
}

func (s *sqlStateStore) WaitForCompletion(ctx context.Context, mutation storepkg.Mutation) (storepkg.Mutation, error) {
	return s.repository.WaitForCompletion(ctx, mutation)
}

func (s *sqlStateStore) Renew(ctx context.Context, mutation storepkg.Mutation) error {
	return s.repository.Renew(ctx, mutation)
}

func (s *sqlStateStore) Abort(ctx context.Context, mutation storepkg.Mutation) error {
	return s.repository.Abort(ctx, mutation)
}

func (s *sqlStateStore) Commit(ctx context.Context, before, after *storepkg.State, mutation *storepkg.Mutation) error {
	return s.repository.Commit(ctx, before, after, mutation)
}

func (s *sqlStateStore) CommitDelta(ctx context.Context, delta *storepkg.Delta, mutation *storepkg.Mutation) error {
	return s.repository.CommitDelta(ctx, delta, mutation)
}

func (s *sqlStateStore) QueryAudits(ctx context.Context, query storepkg.AuditQuery) ([]map[string]any, bool, error) {
	return s.repository.QueryAudits(ctx, query)
}

func (s *sqlStateStore) QueryDue(ctx context.Context, query storepkg.DueQuery) ([]map[string]any, []map[string]any, error) {
	return s.repository.QueryDue(ctx, query)
}

func (s *sqlStateStore) QueryEntityPage(ctx context.Context, query storepkg.EntityPageQuery) ([]map[string]any, *string, error) {
	return s.repository.QueryEntityPage(ctx, query)
}

func (s *sqlStateStore) OperatorActive(ctx context.Context, id string) (bool, error) {
	return s.repository.OperatorActive(ctx, id)
}

var _ auditReader = (*sqlStateStore)(nil)

func (s *sqlStateStore) Close() error { return s.repository.Close() }

var _ stateStore = (*sqlStateStore)(nil)
var _ atomicStateStore = (*sqlStateStore)(nil)

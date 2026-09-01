# Research Results Redesign — Phase 0 analytical correctness

## Objective

Phase 0 establishes trustworthy analytics for the `ผลการทดลอง` (research results)
screen before its Phase 2 presentation work. The implementation follows the
existing snapshot-based analytics service and keeps the existing response shape
and legacy count fields wherever possible. No new runtime dependency was added.

## End-to-end trace and before evidence

The request path is:

`GET /api/v1/analytics/*` → `backend/src/chronofish/api/routes/analytics.py` →
`Analytics` in `backend/src/chronofish/services/analytics.py` → the in-memory or
SQL `State` snapshot. The dashboard bundle uses the same service snapshot for
all cards and charts. `api/openapi.yaml` is the contract source and
`frontend/src/api/schema.d.ts` is generated from it.

The trace identified four analytical failure modes:

1. Stage 1 used `surv(previous) × alive / nPrev` directly. A later raw count
   could rise after a sparse observation gap or correction, making the plotted
   survival curve increase even though survival is defined as monotonic.
2. Stage 2 used the current `alive / atRisk` ratio and the roll-call helper,
   rather than a time-to-event estimator. It did not expose daily event or
   censor counts, confidence bounds, or a useful fallback when a non-alive fish
   lacked `exitDate`.
3. Abnormality onset treated every embryo without a `firstAbnormalStageCode`
   marker as missing. Thus embryos with recorded normal observations were
   reported as missing rather than as “no abnormality recorded”.
4. The pipeline's final `Alive Fish` step counted every fish in the registry,
   including manually registered fish whose `embryoId` is null. That mixed a
   separate registry population into the promoted-embryo experiment funnel.

## Analytical definitions and decisions

### Stage 1 survival

The API still returns the raw `riskSet`, `alive`, `nPrev`, `nDead`, and `surv`
fields for all 26 checkpoints. `riskSet`, direct/implied checkpoint status, and
the sparse-observation rules are unchanged. The displayed estimate now applies
the existing discrete-time update only when `nPrev > 0`, and caps each update
at 1. This preserves the raw counts for audit/recalculation while guaranteeing
that the returned `surv` does not increase across checkpoint order, including
when a later raw `alive` count is higher after a gap or correction.

### Stage 2 Kaplan–Meier survival

Each active fish contributes one follow-up endpoint:

- `DEAD` is an event. Its event date is `exitDate`, then the latest dated
  `DEAD` observation, then the latest follow-up, then today.
- `FROZEN` and `DISCARDED` are right-censored at `exitDate`, the latest dated
  follow-up, or today.
- `ALIVE` is right-censored at the latest dated follow-up, or today when no
  follow-up exists.

The endpoint date is clamped to today, and malformed/missing DOB values use
today (age zero) so one bad record cannot crash the whole dashboard. A missing
non-alive `exitDate` is counted in `meta.missing.exitDate`; the fallback above
keeps a known `DEAD` record as an event and uses the best available date rather
than silently treating it as alive.

For each age, the API computes a discrete Kaplan–Meier product over the daily
risk set. It adds `nEvents` and `nCensored` per day, while retaining legacy
`nAlive`, `nDead`, `nFrozen`, and `nDiscarded` totals for compatibility. It also
returns `survLower95` and `survUpper95`, an approximate Greenwood/Wald 95% CI
without an additional statistics package. `atRisk` includes subjects at their
event/censor age; after that age they leave the risk set. The estimate is
monotonic by construction.

`meta.method` identifies the estimator as `Kaplan-Meier`. `meta.sampleSize` and
the event/censor/alive denominators give the UI explicit sample-size guards.
Without `splitByCondition`, all fish are aggregated into one `ALL` strain / `ALL`
treatment series; split output adds semantic abnormality, strain, and treatment
dimensions.

### Abnormality semantics

For Stage 1, the first abnormal stage is taken from the existing projection
marker or the earliest active abnormal observation. The metadata now separates:

- `everAbnormal`: a marker or an active `ABNORMAL` observation exists;
- `noAbnormalityRecorded`: observations exist and none is abnormal;
- `missing.firstAbnormality`: no active observation exists (no evidence to
  classify the embryo).

Fish comparison groups use the existing first-abnormal fields, current
condition, and active fish observations. Their labels are explicit:
`EVER_ABNORMAL`, `NO_ABNORMALITY_RECORDED`, and `UNKNOWN`. The response metadata
uses the label “Ever abnormal vs No abnormality recorded” and explicitly says
the comparison is exploratory and not causal. Existing `condition` output is
retained when split output is requested, with `abnormalityGroup` carrying the
semantic comparison label.

### Overall pipeline lineage

The pipeline keeps `Promoted` based on fish rows linked by `embryoId`, and now
derives `Alive Fish` from that same promoted subset only. Metadata exposes
`promotedFish`, `alivePromotedFish`, and `manualFish` so the denominator is
visible to the UI and analyst. KPI fish totals remain registry totals; this
change is deliberately scoped to the overall experiment pipeline.

## Component and file breakdown

- `backend/src/chronofish/services/analytics.py`
  - monotonic Stage 1 survival;
  - Kaplan–Meier Stage 2 event/censor preparation, daily risk rows, and CI;
  - abnormality state/group metadata;
  - promoted-lineage pipeline counts and sample-size denominators.
- `backend/tests/test_analytics.py`
  - regression coverage for Stage 1 monotonicity after a gap/correction;
  - Kaplan–Meier event/censor dates, missing exit date, monotonicity, CI, and
    semantic comparison groups;
  - abnormality metadata separation;
  - manual fish exclusion from pipeline `Alive Fish`.
- `api/openapi.yaml`
  - documents monotonic Stage 1 survival, Kaplan–Meier Stage 2 semantics,
    daily event/censor and CI fields, and comparison metadata.
- `frontend/src/api/schema.d.ts`
  - regenerated from the OpenAPI contract; no hand-written frontend runtime
    change is needed in Phase 0.
- `docs/RESEARCH_RESULTS_REDESIGN_REPORT.md`
  - this Phase 0 analytical record.

## Accessibility and responsive impact

Phase 0 changes analytics data and contract metadata only. The existing results
page layout is intentionally left for the planned Phase 2 UI work. New fields
are additive and do not require a frontend dependency or break the existing
chart's `surv`, strain, treatment, and legacy status fields.

## Tests and validation

Focused validation completed:

- `python -m pytest tests/test_analytics.py -q` — 13 passed.
- `python -m pytest -q` — 87 passed, 5 skipped (SQL integration tests are
  skipped when their external database is unavailable).
- `python -m ruff check src tests/test_analytics.py` — passed.
- `python scripts/validate_openapi.py` — passed (52 paths, 71 operations).
- `python -m compileall -q src` — passed during implementation.
- `npm.cmd test` from `frontend` — 16 test files and 65 tests passed; the
  TypeScript check and production Vite build also passed.

## Before vs after measurable metrics

| Measure | Before | After |
|---|---|---|
| Stage 1 checkpoint rows | 26 | 26; raw `alive`/`nPrev` retained |
| Stage 1 survival monotonicity | Could rise after a gap/correction | Enforced non-increasing `surv` |
| Stage 2 daily event/censor fields | Not available | `nEvents`, `nCensored` per age |
| Stage 2 estimator | `alive / atRisk` snapshot ratio | Kaplan–Meier product-limit estimate |
| Stage 2 uncertainty | Not available | Approximate Greenwood/Wald 95% bounds |
| Non-split fish series | Could fragment by strain/treatment | One overall `ALL`/`ALL` series; split mode retains dimensions |
| Missing non-alive exit dates | Not surfaced by analytics | `meta.missing.exitDate`, conservative dated fallback |
| Fixture abnormality metadata | 1 abnormal, 2 incorrectly missing | 1 ever abnormal, 2 no abnormality recorded, 0 missing |
| Manual fish in pipeline Alive Fish | Included in all fish total | Excluded unless linked to promoted embryo |

## Known limitations and follow-ups

- The confidence interval is an approximate Wald interval using Greenwood
  variance. Phase 2 should decide whether the UI should show it for small
  samples and whether a log/log or exact interval is preferred.
- Missing `exitDate` cannot recover the true event/censor age. The fallback is
  documented in metadata but should remain visible in the eventual UI.
- Fish comparison is observational and exploratory; it is not a causal
  abnormality effect estimate. Unknown groups and sample-size warnings should
  be handled in the Phase 2 headline/chart design.
- Existing legacy `nDead`/`nFrozen`/`nDiscarded` fields remain current-status
  totals. Phase 2 should use `nEvents` for event annotations and explain the
  distinction where both are shown.
- SQL integration against a large production/demo dataset still needs a data
  quality review for malformed dates, missing lineage, and expected follow-up
  coverage. User-owned demo seed files were not modified.

## Phase 1 — Information architecture

### Objective

Make `ผลการทดลอง` / Research results answer one analysis question at a time:
show the records in scope, keep the selected stage stable in the URL, and put
the relevant evidence and quality action in that stage's panel. This phase
changes presentation and navigation only; Phase 0 API semantics remain intact.

### IA decisions and component breakdown

- `ScopeBar` is the first context surface. It renders readable filter chips
  (master names when available), generated time in Bangkok time, and timing
  profile versions, with explicit Edit and Clear actions.
- The three-stage tab list is a real URL state (`?tab=stage1|stage2|overall`).
  Tab changes push history; filter changes replace the current URL while
  preserving the tab. `popstate` restores both values, and invalid tabs fall
  back to Stage 1.
- `TabMetrics` replaces the duplicated global KPI strip. Stage 1 emphasizes
  embryo checkpoints, Stage 2 fish registry status, and Overview pipeline
  counts. Statistical small-n guarding remains Phase 2 work.
- `ObservationGapSummary` replaces the Results-page gap table with a compact
  quality alert and a direct link to daily fish checks. Detailed records stay
  in the source workflow.
- Timing evidence remains available in Stage 1's secondary analysis and is no
  longer repeated in Overview.

### Files changed

- `frontend/src/pages/dashboard.tsx` — scope context, URL tab state, per-tab
  KPIs, compact gap summary, master-name lookup, and navigation behavior.
- `frontend/src/pages/export.tsx` — passes the shared master-option hook to
  the existing filter bar after its options became explicit.
- `frontend/src/styles.css` — scope/quality surfaces, readable metadata, and
  responsive 320px+ layout rules using existing tokens.
- `frontend/tests/dashboard.test.tsx` — URL/filter preservation and popstate,
  invalid-tab fallback, per-tab KPI context, readable scope metadata, filter
  disclosure actions, and compact observation-gap navigation.
- `docs/RESEARCH_RESULTS_REDESIGN_REPORT.md` — this Phase 1 record.

### Accessibility and responsive behavior

Tabs use `role=tablist`, `role=tab`, `aria-selected`, `aria-controls`, and
roving `tabIndex`; Arrow Left/Right/Home/End move between tabs and announce
the selected panel through the native selected state. Scope and quality
summaries use live regions/status text, so color is not the only signal.
Existing focus outlines and 44px button targets are retained. Scope controls
stack on narrow screens, metadata collapses to one column at 430px, and chips
wrap with overflow-safe text so the layout remains usable from 320px upward.

### Tests and validation

- `npm.cmd exec -- vitest run tests/dashboard.test.tsx` — 3 passed.
- `npm.cmd run build` — TypeScript check and production Vite build passed.
- `npm.cmd test` — 16 test files and 66 tests passed (including the build).
- `git diff --check` — passed.

### Known limitations and follow-ups

- Master labels are initially ID fallbacks until the existing master requests
  resolve; failed master lookups remain safe and readable as IDs.
- Browser-native back/forward is represented by `popstate` restoration; the
  App-level hash navigation remains unchanged.
- Phase 2 should add small-sample headline guards and decide whether CI fields
  deserve a chart affordance; this phase intentionally does not reinterpret
  any analytical value.

## Phase 2 — Core charts

### Objective and data decisions

The core charts now expose the shape of the evidence rather than implying a
ranking from a dense table. Stage 1 requests `site` plus exactly one selected
comparison dimension (`strain`, `treatmentGroup`, or `operator`) from the same
dashboard snapshot. Each site is rendered as its own facet. Stage 2 requests
the default overall series without grouping, so its Kaplan–Meier curve is
calculated over all fish; comparison mode requests one dimension (`condition`
for the semantic abnormality groups, `strain`, or `treatmentGroup`). The
existing fish endpoint and dashboard gained additive `groupBy` parameters;
legacy `splitByCondition` behavior remains supported.

Both chart renderers use deterministic ordering and show at most four series
per facet/chart. They announce the omitted-series count and leave every row in
the supporting table; no statistical `Other` series is created. The UI treats
sample sizes below five as exploratory and suppresses lowest/highest headlines.
Abnormality comparison is explicitly labeled “Ever abnormal vs No abnormality
recorded” and “exploratory, not causal.”

### Chart and component breakdown

- `SurvivalChart` renders SVG step paths, site facets, direct end labels,
  color-plus-dash legends, keyboard-focusable checkpoint points, risk-set
  summaries, and an explicit four-series limit.
- `FishSurvivalChart` renders the overall or selected-group Kaplan–Meier step
  curve, 95% CI band for overall mode, event rings, censor marks, direct labels,
  focusable points, and daily at-risk/event/censor values in its supporting
  table. Comparison mode suppresses cluttered CI bands but keeps CI values in
  the table.
- `FunnelChart` now ranks and labels loss rate (`dead / risk set`) while
  retaining raw counts. `AbnormalityOnsetChart` makes onset, no-abnormality,
  and missing-evidence categories visible as a histogram. `PipelineSummary`
  shows count, previous-step percentage, activated percentage, Thai step names,
  and a data-quality note when upstream counts are non-monotonic.
- `ComparisonControl` provides one-dimension controls with a clear site-facet
  or overall-KM explanation. Existing loading, empty, error, scope, and tab
  state behavior remains in place.

### Before vs after

| Measure | Before Phase 2 | After Phase 2 |
|---|---|---|
| Stage 1 chart geometry | Straight point-to-point polylines | Monotonic checkpoint step paths |
| Stage 1 grouping | Site, strain, and treatment mixed in one series set | Site facets with one selected comparison dimension |
| Stage 2 default | Dashboard returned condition-split series | One overall Kaplan–Meier series |
| Visible series | Unbounded | Maximum 4 per facet/chart, deterministic with explicit notice |
| Stage 1 attrition | Raw dead count bars/ranking | Loss rate plus `dead / risk set` and raw `n` |
| Abnormality onset | Supporting table only | Direct histogram plus semantic missing/no-abnormality categories |
| Stage 2 supporting rows | Repeated legacy status totals | Daily at-risk, death events, censored, survival, and CI |
| Accessibility | Chart-level labels | Chart summaries, direct labels, and keyboard-focusable data points |

### Files changed

- `frontend/src/pages/dashboard.tsx` — comparison controls, snapshot query
  grouping, step/KM SVG charts, CI/censor/event marks, accessible summaries,
  small-n guard, attrition rate, onset histogram, and pipeline summary.
- `frontend/src/styles.css` — chart facets, controls, histogram/pipeline rows,
  chart focus states, readable summaries, and narrow-screen layout.
- `frontend/tests/dashboard.test.tsx` — default/group selection options,
  four-series limit, step paths, focusable points, CI/censor/events, small-n
  guard, and Thai pipeline labels.
- `backend/src/chronofish/api/routes/analytics.py` and
  `backend/src/chronofish/services/analytics.py` — additive dashboard/fish
  grouping parameters while preserving snapshot and legacy semantics.
- `backend/tests/test_analytics.py` — overall default, explicit fish grouping,
  and grouped dashboard regression coverage.
- `api/openapi.yaml` and `frontend/src/api/schema.d.ts` — documented and
  regenerated grouping parameters.
- `docs/RESEARCH_RESULTS_REDESIGN_REPORT.md` — this Phase 2 record.

### Accessibility and responsive behavior

Every chart has explicit units and text summaries. Legends show the same color
and dash pattern used by their paths; status, counts, and labels remain textual
so color is not the sole signal. SVG data points are focusable with unique
labels containing series, age/checkpoint, survival, risk set, and event/censor
counts. The existing 44px controls and focus outline remain active. Chart
content scales to the available width from 320px; only supporting tables retain
their existing local horizontal scroll behavior.

### Tests and validation

- `python -m pytest tests/test_analytics.py -q` — 13 passed.
- `python -m pytest -q` — 88 passed, 5 skipped (SQL integration unavailable).
- `python -m ruff check backend/src backend/tests/test_analytics.py` — passed.
- `python scripts/validate_openapi.py` — passed (52 paths, 71 operations).
- `npm.cmd exec -- vitest run tests/dashboard.test.tsx` — 7 passed (including
  candidate-level guard, roving focus, visible summaries, and dimension labels).
- `npm.cmd test` from `frontend` — 16 test files and 70 tests passed, including
  TypeScript checking and the production Vite build.
- `git diff --check` — passed.

### Known limitations and follow-ups

- The comparison selection is local component state; Phase 3 can persist it in
  the URL if researchers need shareable chart views. The required tab/filter
  query state remains preserved.
- The approximate Greenwood/Wald CI from Phase 0 is shown for overall mode;
  Phase 3 should decide on interval style and small-n CI presentation.
- Supporting tables remain collapsible to keep the primary workflow compact;
  opening them exposes all series/daily rows behind the chart limit notice.
- The SVG uses compact direct end labels; unusually long group names may still
  need a future label-collision affordance.

### Phase 2 review correction

The chart review identified six presentation/accessibility gaps and the
correction closes them without changing the analytics contract:

- headline guards now evaluate the candidate checkpoint's own `riskSet` or
  `atRisk` value, not only the response-level sample size; comparison views
  explicitly list series whose initial sample is below five;
- SVG points use one roving tab stop per series, with Arrow/Home/End movement,
  while every point retains its label and title;
- each visible chart now has a compact risk/event/censor table beneath it;
  the existing supporting tables still expose all rows, and table regions
  remain the only horizontally scrollable regions;
- Stage 1 table headings and values follow the selected dimension, including
  operator master names when available; Stage 2 uses the selected dimension
  for both its heading and values;
- attrition headline sorting uses the same loss-rate definition as its chart
  and table, with raw-dead-count tie-breaking;
- the shared pipeline label helper is used by both the visual summary and its
  supporting table, including Thai labels.

The correction added candidate-level, roving-focus, visible-summary, and
dimension-label regression coverage. Targeted dashboard tests pass (7 tests);
the complete frontend validation is recorded in the Phase 2 test list above.

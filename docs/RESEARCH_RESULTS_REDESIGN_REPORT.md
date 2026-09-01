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

## Phase 3 — Supporting analysis

### Objective and analytical definitions

Phase 3 adds compact, decision-oriented evidence below the primary charts. Fish
status is shown as ALIVE/DEAD/FROZEN/DISCARDED counts and percentages. Age bins
are 0–6, 7–13, 14–20, 21–27, and 28+ days, measured at the fish's current
follow-up date, exit/status date, or today when no date is available. Sex is
M/F/Unknown with a completeness percentage. Box census is scoped to the same
filtered fish snapshot and includes empty boxes plus status counts per box.

Day 5 batch performance uses protocol stage order 26 and reports percent normal
over the known NORMAL/ABNORMAL denominator. Future Day 5 batches are
`NOT_ELIGIBLE`; missing observations or condition data remain explicitly
missing, never zero. Timing uses median/IQR as the primary summary and human
readable signed durations (positive = slower, negative = faster); source tables
retain range and n for audit. SCNT/control comparison uses percent normal with
n/denominator and warns for n < 5 or unknown denominators.

### Component and file breakdown

- `backend/src/chronofish/services/analytics.py` adds one additive `supporting`
  object to fish survival: status/sex composition, age bins, scoped box census,
  and Day 5 batch performance. Box rows include a status-count map.
- `api/openapi.yaml` and `frontend/src/api/schema.d.ts` document and regenerate
  the additive fish-supporting contract.
- `frontend/src/pages/dashboard.tsx` renders a collapsed supporting-analysis
  section, stacked composition, age/box/Day 5 summaries, timing summary,
  denominator-based control summary, and persists `stage1Compare`/
  `stage2Compare` URL state with safe fallback on invalid values.
- `frontend/src/styles.css` adds token-based summary tracks, legends, local
  table scrolling, readable metadata, and 320px-safe narrow layouts.
- `backend/tests/test_analytics.py` and `frontend/tests/dashboard.test.tsx`
  cover supporting payload boundaries, eligibility/denominators, status counts,
  composition, formatting, URL persistence, and invalid comparison values.

### Before vs after

| Measure | Before Phase 3 | After Phase 3 |
|---|---|---|
| Fish composition | Status totals repeated in survival rows | Collapsed stacked status and sex summaries with n/% |
| Fish age evidence | Mean alive age KPI only | Explicit current-follow-up age bins with units and empty state |
| Fish-box evidence | No cohort census | Concentration list, empty-box count, and per-box status counts |
| Day 5 batch evidence | No denominator-based ranking | Ratio/denominator with batch labels and eligibility/missing states |
| Timing evidence | Four-decimal values in supporting table | Median/IQR and signed human-readable durations |
| Control evidence | Raw `nNormal` bars | Percent-normal bars with n/denominator and small-n guard |
| Comparison URL | Comparison was local state | Shareable/reloadable comparison query parameters |

### Accessibility, responsive behavior, and hierarchy

Supporting analysis is inside a closed disclosure after the primary chart and
compact risk/event/censor evidence, so the page does not present every card at
once. Every visual has a textual label and n/% values; status and sex labels
remain visible alongside color. Summary tracks are decorative only. Tables
retain local horizontal scrolling while the page itself remains overflow-safe
from 320px upward. Small-n and missing/unknown denominator states are separate
text warnings, and comparison query values are validated before use.

### Tests and validation

- `python -m pytest tests/test_analytics.py -q` — 15 passed.
- `python -m pytest -q` — 90 passed, 5 skipped (SQL integration unavailable).
- `python -m ruff check src tests/test_analytics.py` — passed.
- `python scripts/validate_openapi.py` — passed (52 paths, 71 operations).
- `npm.cmd exec -- vitest run tests/dashboard.test.tsx` — 8 passed.
- `npm.cmd test` from `frontend` — 16 test files and 71 tests passed, including
  TypeScript checking and the production Vite build.
- `git diff --check` — passed.

### Known limitations and follow-ups

- Box empties are included when the selected site has no cohort-level filter;
  restrictive cohort filters include only boxes represented by that snapshot.
- Age bins and Day 5 eligibility are intentionally fixed to the current
  protocol semantics; future protocol-specific bins would require an additive
  contract decision.
- Supporting summaries intentionally show a compact subset while their full
  tables remain available through disclosure controls.

### Phase 3 review correction

- Day 5 eligibility now uses each lot's `activatedAt` plus the timing-profile
  `expectedHpa` for protocol stage 26, compared with `utc_now()`. An observed
  Day 5 result is retained even when it was recorded before due; future,
  unobserved embryos are excluded from the due denominator and
  `missingEmbryos`. Contradictory experiment dates are covered by regression
  tests.
- Changing either comparison control now pushes a URL history entry while
  preserving tab, filters, and the other comparison. `popstate` restores the
  prior comparison instead of only replacing the current URL.
- API definitions remain English for the contract, while Thai UI renders
  explicit Thai definitions for age and Day 5 due semantics.
- Day 5 batch summaries now expose `known` versus `missing due` coverage in
  each visual row and the full table. Partial batches are explicitly labeled
  and receive a data-quality warning separate from the small-n exploratory
  warning, so a percentage based on known conditions is not presented as
  complete coverage.

## Phase 4 — WCAG, responsive, and browser QA

### Objective and QA setup

Phase 4 validates the complete Research results workspace after the analytical
and information-architecture changes. The checks covered all three tabs,
comparison controls, disclosures, chart interactions, Thai/English labels,
keyboard navigation, and reflow from desktop to a 320px viewport. The
repository's browser connector was not available in this environment, so the
local Vite app was exercised with the installed headless Playwright Chromium
fallback. The initial evidence pass used a stale seeded API and is superseded
by the correction evidence below. The correction ran the API image built from
the current working tree on `127.0.0.1:8083` and Vite on `127.0.0.1:5175`,
without changing compose or user-owned seed files. Screenshots and metrics are
retained under `.tmp/` only.

### QA matrix and findings

| Surface | 1440px | 768px | 375px | 320px | 200% / 400% reflow |
|---|---|---|---|---|---|
| Stage 1, Stage 2, Overall | Pass | Pass | Pass | Pass | Pass at 720px / 360px CSS viewport |
| Page-level horizontal overflow | None | None | None | None | None |
| Tab strip | Full width | Full width | Wrapped, no intrinsic overflow | Wrapped, no intrinsic overflow | Full width after reflow |
| Chart text | 13px+ effective | 13px+ effective | 12px+ effective | 12px+ effective | 12px+ effective |
| Well/control target size | 44px+ | 44px+ | 44px+ | 44px+ | 44px+ |
| Supporting tables | Inline/local scroll only | Inline/local scroll only | Local scroll only | Local scroll only | Local scroll only |

The first pass found two presentation defects and one data-density defect:

1. Fixed-size SVG view boxes made the old 12px chart labels render at roughly
   4.3–6px on narrow screens. The chart text token is now 13px, with a narrow
   viewport SVG compensation rule; DOM/layout measurements are at least 12px
   at 320px, 375px, 768px, 1440px, and the reflow checks.
2. The tab labels were wider than the 341px content area at 375px (and the
   corresponding 320px area), creating intrinsic tab overflow. Tabs now share
   available width, allow two-line labels, and retain a 44px-height target.
3. Multiple series ending at the same survival value placed direct labels on
   top of each other. End labels now use a reserved right-side lane and a
   leader line from each actual endpoint, with the same color and dash pattern
   as its series; the regression test asserts unique collision-safe positions
   and non-zero leaders for coincident endpoints. The observed labels are not
   clipped at desktop or mobile widths.
4. The first geometry correction still allowed the dense Stage 1 attrition
   rows and axis captions to touch at narrow/desktop scales. Funnel rows now
   reserve responsive vertical spacing, survival charts reserve a wider
   plotting gutter and endpoint lane, and the x-axis tick density/spacing is
   bounded. The integrated pass reports zero measured text overlaps.

The final layout probe measured effective SVG text at 14.68px (1440px),
13.86px (768px), 12.69px (375px), and 12.10px (320px) for Stage 1; the
corresponding Stage 2 minima were 14.68px, 14.49px, 14.21px, and 13.72px.
All sampled end labels had zero clipping, and every visible end label had a
matching non-zero leader line. The Stage 2 interaction probe selected
`strain`, rendered three deterministic series and a `Fish survival by strain
and age` table caption, then returned to the overall series.

The initial artifact names below are retained for historical audit only; they
must not be used as release evidence because they were captured against the
stale API. Current release evidence is:

- `.tmp/phase4-integrated-browser-metrics.json` — 36 current-working-tree
  runs with HTTP statuses, API marker, tab/control/supporting checks, text
  overlap, and page overflow metrics.
- `.tmp/phase4-integrated-layout-metrics.json` — effective SVG font sizes,
  label clipping, and endpoint/leader counts at 1440/768/375/320px.
- `.tmp/phase4-integrated-{th,en}-{stage1,stage2,overall}-{1440,768,375,320,200pct,400pct}.png`
  — 36 current Thai/English screenshots across the requested viewports and
  zoom-equivalent reflows.

Historical artifacts from the superseded pass:

- `.tmp/phase4-final-metrics.json` — viewport, effective SVG text, overflow,
  tab-strip, and target-size measurements.
- `.tmp/phase4-keyboard-semantics.json` — skip link, tabs, disclosure, legend,
  chart-point roving focus, table semantics, heading order, and language checks.
- `.tmp/phase4-final4-stage1-1440x900.png`,
  `.tmp/phase4-final4-stage2-1440x900.png`, and
  `.tmp/phase4-final4-overall-1440x900.png` — final desktop captures.
- `.tmp/phase4-final4-stage1-375x812.png`,
  `.tmp/phase4-final4-stage2-375x812.png`, and
  `.tmp/phase4-final4-overall-375x812.png` — final mobile captures.
- `.tmp/phase4-stage1-chart-labels-375.png` — focused end-label visual;
  collision positions are also asserted by the dashboard regression test.

The current integrated harness also verified that focusing a roving chart point scrolls
it below the sticky header, that the skip link reaches `main-content`, tab
Arrow navigation changes the selected panel, legend controls toggle with
keyboard, supporting tables have captions and scoped headers, and every chart
point has an accessible label and title. Supporting tables keep overflow on
their own scroll container rather than widening the page.

### Accessibility and language mapping

The page keeps one `h1`, a logical `h2`/`h3` hierarchy, linked tab/tabpanel
semantics, named `details` disclosures, table captions and headers, and
textual chart summaries in addition to SVG marks. Chart points use one roving
tab stop per series and Arrow/Home/End navigation; legends are real buttons.
Focus remains visible and the sticky controls do not obscure the focused
control. Status, event, censor, small-n, and missing-data states have text or
symbols in addition to color, while decorative chart marks remain
non-interactive.

The Thai language pass confirmed translated tab, filter, comparison, KPI,
chart, pipeline, timing, status, and data-quality labels. API definition text
continues to be English for the contract, while the UI uses explicit Thai
wording for age and Day 5 definitions. The English round trip exposes the
corresponding English labels without leaking Thai-only definitions.

These checks map to WCAG 2.2 success criteria as follows:

| Check | WCAG mapping |
|---|---|
| Chart labels, summaries, status text, table captions | 1.1.1, 1.3.1 |
| Keyboard skip, tabs, disclosures, legends, chart points | 2.1.1, 2.4.3 |
| Visible focus and sticky-header clearance | 2.4.7, 2.4.11 |
| Text, symbols, line dashes, and non-color status cues | 1.4.3, 1.4.11 |
| 320px reflow and local table scrolling | 1.4.10 |
| 44px touch targets | 2.5.8 |

### Validation

- Targeted dashboard test: 10 passed, including coincident end-label layout
  and narrow chart geometry.
- Full frontend test/build: 16 test files and 73 tests passed; TypeScript and
  Vite production build passed.
- Backend analytics test: 15 passed. Full backend suite: 90 passed, 5
  skipped (SQL integration unavailable). Ruff passed for `src` and `tests`.
- OpenAPI validation passed (52 paths, 71 operations); `git diff --check`
  passed (with only existing CRLF normalization warnings for protected dirty
  files).

### Final score breakdown

This is a review score based on the measured QA evidence, not an automated
WCAG certification:

| Dimension | Score |
|---|---:|
| Visual | 8.8/10 |
| Information architecture | 9.2/10 |
| Ease of use | 8.8/10 |
| Chart readability | 9.0/10 |
| Analytical integrity | 9.4/10 |
| Accessibility | 8.8/10 |
| Responsive behavior | 9.3/10 |
| Overall | 9.08/10 |

### Final limitations and follow-ups

- Playwright was used because the in-app browser connector was unavailable;
  actual device/assistive-technology combinations still merit release QA.
- 200% and 400% were represented by 720px and 360px CSS viewports in the
  fallback harness. A browser with OS/page zoom should be checked before
  release.
- The current QA API image includes the optional fish-supporting payload and
  was verified to return one overall Stage 2 series and the current `supporting`
  marker. The stale-API limitation from the initial pass is superseded; a
  release environment should still run the same image/version checks.
- No axe/contrast scanner is installed in this repository. Contrast was
  reviewed against the existing token palette and semantic/text cues; a
  dedicated automated audit remains a useful follow-up.
- Very long future series labels may need a richer label-placement policy;
  the collision-safe placement is verified against the current cohort data.

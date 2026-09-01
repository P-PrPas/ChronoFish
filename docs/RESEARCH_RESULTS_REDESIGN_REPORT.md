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

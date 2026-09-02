# Test Report

Run date: 2026-09-02
Branch: `test/comprehensive-test-suite`

## Local verification

| Suite | Result |
|---|---|
| Backend unit suite | 183 passed, 5 skipped (SQL integration requires `CHRONOFISH_TEST_DATABASE_URL`) |
| Backend full coverage | 82% lines (target is 90%) |
| Frontend coverage | 144 passed; 87.85% lines and 78.00% branches |
| Frontend type/lint/build | passed (`npm run check`) |

## Exit-criteria status

This is a progress report, not a completion report. The following work remains before the exit criteria in [TEST_PLAN.md](TEST_PLAN.md) can be marked complete:

| Criterion | Status | Required follow-up |
|---|---|---|
| Backend full coverage gate | Blocked | Exercise SQL store and migrations against PostgreSQL/MySQL, then enforce the 90% line target in CI. |
| All 71 OpenAPI operations exercised | Open | Add request-coverage tracking and tests for operations without a request. |
| DB migration scenarios | Open | Add BE-MIG-005…011 to the PostgreSQL/MySQL jobs. |
| Service worker resilience | Open | Add FE-SW-003…009. |
| Case-table PASS/WAIVED traceability | Open | Map each executed case to a test and record an explicit waiver where appropriate. |

The frontend coverage gate is enforced by the application CI job. Backend coverage remains limited to the existing domain/service gate until the database-backed coverage work above is complete; raising its scope now would make CI fail at 82%.

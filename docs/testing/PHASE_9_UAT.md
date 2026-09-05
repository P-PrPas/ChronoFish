# KUVTH Zebrafish LIMS — Phase 9 UAT and release sign-off

This is the handoff sheet for the deployment owner. Automated checks belong in CI; the rows below require the real deployment, reference data, target browsers/devices, or an operator sign-off. Record the artifact/image digest used for the run so UAT and release use the same build.

## Release artifact

| Field | Value |
|---|---|
| API image digest | |
| Source commit | |
| Frontend artifact checksum | |
| Vulnerability scan report/reference | |
| Environment | |
| Database engine/version | |
| UAT owner | |
| Run date | |

## Acceptance matrix

| Test | Owner | Evidence / result | Sign-off |
|---|---|---|---|
| T-01 | | | |
| T-02 | | | |
| T-03 | | | |
| T-04 | | | |
| T-05 | | | |
| T-06 | | | |
| T-07 | | | |
| T-08 | | | |
| T-09 | | | |
| T-10 | | | |
| T-11 | | | |
| T-12 | | | |
| T-13 | | | |
| T-14 | | | |
| T-15 | | | |
| T-16 | | | |
| T-17 | | | |
| T-18 | | | |
| T-19 | | | |
| T-20 | | | |
| T-21 | | | |
| T-22 | | | |
| T-23 | | | |

Use the test definitions and expected results in `docs/requirements/KUVTH_Zebrafish_LIMS_SRS.md`. T-23 must include the reconciled Excel comparison, not only a screenshot of the export.

## Release gates

- [ ] HTTPS, VPN/IP allowlist, CORS origins, secret store, and production database TLS verified.
- [ ] Fresh migration/seed verified on the selected database engine.
- [ ] Daily backup retention is configured for at least 30 days.
- [ ] Restore drill completed in a disposable database; health, constraints, one idempotent write, and its audit entry verified.
- [ ] The exact API image digest above has no unaccepted HIGH or CRITICAL vulnerability; scan evidence is retained.
- [ ] NFR-101 through NFR-106 are measured with production-like five-year data and meet their documented response/export targets.
- [ ] WCAG 2.1 AA automated and manual checks completed for the critical flows.
- [ ] No unresolved MUST requirement or UAT blocker remains.

## Sign-off

| Role | Name | Date | Signature / approval reference |
|---|---|---|---|
| UAT owner | | | |
| Data owner | | | |
| Deployment owner | | | |

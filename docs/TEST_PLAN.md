# KUVTH Zebrafish LIMS — Master Test Plan

> เวอร์ชัน: 1.0
> วันที่: 2 กันยายน 2026
> Branch: `test/comprehensive-test-suite` (แตกจาก `main` ที่ `045da0e`)
> ผู้จัดทำ: Senior Software Tester
> เอกสารที่เกี่ยวข้อง: [`KUVTH_Zebrafish_LIMS_SRS.md`](KUVTH_Zebrafish_LIMS_SRS.md) · [`DEVELOPMENT_STATUS.md`](DEVELOPMENT_STATUS.md) · [`PHASE_9_UAT.md`](PHASE_9_UAT.md) · [`TEST_CASES_BACKEND.md`](TEST_CASES_BACKEND.md) · [`TEST_CASES_FRONTEND.md`](TEST_CASES_FRONTEND.md)

---

## 1. วัตถุประสงค์และขอบเขต

### 1.1 วัตถุประสงค์

เอกสารนี้กำหนดกลยุทธ์ ขอบเขต เกณฑ์ผ่าน และรายการ unit test case ทั้งหมดที่ต้องมี เพื่อให้ KUVTH Zebrafish LIMS พร้อมส่งมอบใช้งานจริง โดยครอบคลุม:

- ทุก endpoint ใน API contract (**52 paths / 71 operations** ใน `api/openapi.yaml`)
- ทุก business rule (BR-01 … BR-23) และ functional requirement (FR-100 … FR-1105) ใน SRS
- ทุกโมดูล backend (`backend/src/chronofish/**`) และทุกหน้าจอ/โมดูล frontend (`frontend/src/**`)
- ชั้น infrastructure ที่ระบบพึ่งพา: migration runner, SQL persistence, idempotency, middleware, service worker, offline queue

### 1.2 อยู่ในขอบเขต (In scope)

| ระดับ | ครอบคลุม | เครื่องมือ |
|---|---|---|
| Unit — pure logic | `domain/rules.py`, `domain/state.py`, `runtime/*`, `services/*`, `reporting/xlsx.py`, `frontend/src/{time,filters,uuidv7,offline}.ts` | pytest / vitest |
| Unit — HTTP seam | ทุก route ผ่าน `TestClient` + `MemoryStore` (in-process, ไม่มี network) | pytest + FastAPI TestClient |
| Unit — component | ทุกหน้าจอ React ผ่าน `happy-dom` + `fetch` stub | vitest + happy-dom |
| Integration — database | `store/sql.py`, `store/migrations.py` บน PostgreSQL 16 และ MySQL 8 | pytest (CI service containers) |
| Contract | route ↔ OpenAPI parity, generated TS schema parity | pytest + `scripts/validate_openapi.py` |

### 1.3 นอกขอบเขต (Out of scope)

| หัวข้อ | เหตุผล / เอกสารที่รับผิดชอบ |
|---|---|
| UAT บนอุปกรณ์จริง (iPad Safari, เครือข่ายห้องแล็บ) | [`PHASE_9_UAT.md`](PHASE_9_UAT.md) — T-01 … T-23 |
| Performance / load ด้วย dataset 5 ปีจริง | PHASE_9_UAT §performance sign-off |
| Penetration test / security audit ภายนอก | ไม่อยู่ในสัญญาเวอร์ชันนี้ |
| Visual regression (screenshot diff) | ประเมินหลังจบ suite นี้ |
| การเปิดไฟล์ export ด้วย Excel/LibreOffice/`readxl` จริง | UAT T-19/T-20 (ทดสอบเฉพาะโครงสร้าง XLSX ที่นี่) |

---

## 2. ระบบที่ทดสอบ (System under test)

```text
api/openapi.yaml ──────────── single source of truth (52 paths / 71 operations)
        │
        ├── backend/src/chronofish/
        │     app.py            FastAPI composition + middleware chain
        │     config.py         env → Config (validation ที่ boundary)
        │     api/routes/       master · timing · experiments · observations · fish · analytics · exports · audit
        │     domain/           rules.py (36 stages, HPA, deviation, promotion) · state.py
        │     services/         analytics.py (1044 LOC) · fish.py
        │     runtime/          errors · values · mutations (idempotency fingerprint, audit)
        │     store/            base(Protocol) · memory · sql · migrations · database
        │     reporting/        xlsx.py (zero-dependency XLSX writer)
        │
        └── frontend/src/
              api/client.ts     write-context headers, error envelope unwrap
              offline.ts        IndexedDB durable queue, backoff, dedupe, replay
              App.tsx           shell, nav, operator gate, queue UI, form-error summary
              pages/            dashboard(2532) · fish(1218) · due(1037) · batches(989) · settings(930) · master(532) · export(350) · audit(264)
              {time,filters,uuidv7,types}.ts, components.tsx
```

### 2.1 คุณสมบัติที่มีความเสี่ยงสูงเป็นพิเศษ

1. **ไม่มีระบบ login** — ตัวตนของผู้บันทึกมาจาก `X-Operator-Id` / `X-Device-Id` เท่านั้น (CON-01) จึงต้องทดสอบ write-context validation ทุกเส้นทาง
2. **Idempotency** — ทุก mutation ต้อง replay ได้ปลอดภัย ทั้งชั้น HTTP (`X-Idempotency-Key`) และชั้น payload (`clientUuid`)
3. **Offline-first** — คิว IndexedDB ต้องไม่ทำข้อมูลหาย แม้ปิดแท็บระหว่าง fetch
4. **เวลาและเขตเวลา** — เก็บ UTC แสดง `Asia/Bangkok`; อายุปลานับเป็น "วันตามปฏิทินกรุงเทพ" ไม่ใช่ 24 ชม.
5. **Monotonic survival** — ตัวอ่อนที่ตายแล้วต้องฟื้นไม่ได้ และการแก้ไขต้องคำนวณ projection ใหม่ทั้งสาย
6. **Portable schema** — PostgreSQL เป็น canonical, MySQL ต้องได้ผลเหมือนกันทุกข้อ

---

## 3. Baseline ที่วัดได้จริง (2 กันยายน 2026)

### 3.1 Backend

```text
python -m pytest                 → 92 passed, 5 skipped, 16.31s
python -m pytest --cov=chronofish → TOTAL 2999 stmts, 597 missed, 80%
```

`5 skipped` คือ `test_sql_integration.py` ที่ต้องมี `CHRONOFISH_TEST_DATABASE_URL` (รันเฉพาะ CI job `postgres` / `mysql`)

| โมดูล | Stmts | Cover | ช่องว่างที่สำคัญ |
|---|---:|---:|---|
| `store/migrations.py` | 56 | **16%** | migration runner ไม่มี unit test เลย (dirty state, lock, ไดเรกทอรีหาย, ไม่มีไฟล์) |
| `store/sql.py` | 234 | **21%** | ครอบคลุมเฉพาะใน CI DB job; ไม่มี local fallback |
| `store/database.py` | 17 | **29%** | `sqlalchemy_url()` แปลง DSN ไม่ถูกทดสอบ |
| `__main__.py` | 19 | **0%** | entrypoint ไม่ถูกทดสอบ |
| `api/routes/fish.py` | 360 | **78%** | `PATCH /observations/fish/{id}` ทั้งบล็อก (บรรทัด 666–694), branch ปฏิเสธ backdate/ปิดสถานะ (584–613), validation ของ specimen (424–446) |
| `api/routes/timing.py` | 174 | **80%** | branch ของ CSV parser และ validation ของ `POST /timing-profiles` |
| `api/routes/audit.py` | 95 | **83%** | เส้นทาง fallback ของ MemoryStore, ตัวกรองผิดรูปแบบ |
| `api/routes/experiments.py` | 389 | **84%** | `POST /injection-lots/{id}/embryos` (495–517) แทบไม่ถูกเรียก |
| `config.py` | 45 | **84%** | `_integer()` / `_networks()` เส้นทาง error |
| `app.py` | 126 | **85%** | CORS, การเลือก store, shutdown hook, unhandled exception → 500 |
| `services/fish.py` | 108 | **86%** | `fish_was_alive_on()`, branch ของ `recompute_fish()` |
| `api/routes/exports.py` | 230 | **87%** | branch ของ filter/row builder |
| `api/routes/master.py` | 76 | **91%** | cursor ผิดรูปแบบ, reference validation |
| `api/routes/observations.py` | 272 | **92%** | ดี |
| `services/analytics.py` | 482 | **93%** | ดี |
| `domain/rules.py` | 69 | **96%** | `enu_window()` เส้นทาง error |

**Endpoint ที่ยังไม่มี test อ้างถึงเลย:** `GET /protocols`, `GET /analytics/observation-gaps`, `GET /timing-profiles` (list version history — ถูกแตะเฉพาะใน SQL job)

### 3.2 Frontend

```text
npx vitest run                   → 17 files, 75 tests passed, 4.22s
npx vitest run --coverage        → MISSING DEPENDENCY '@vitest/coverage-v8'
```

**ยังวัด coverage ไม่ได้** — ต้องติดตั้ง `@vitest/coverage-v8` ก่อน จึงไม่มีตัวเลข baseline ให้อ้างอิง นี่คือช่องว่างข้อแรกที่ต้องปิด

ช่องว่างเชิงโครงสร้างที่เห็นจากการอ่านโค้ด:

| ไฟล์ | LOC | สถานะ test |
|---|---:|---|
| `pages/dashboard.tsx` | 2532 | มี 10 test แต่ helper ที่ export ไว้ (`percent`, `formatDeviationHours`, `stepPath`, `chartEndLabelPositions`, `sampleChartPoints`, `ciBandPath`) ยังไม่ถูกทดสอบแยกเป็นหน่วย |
| `pages/fish.tsx` | 1218 | ครอบคลุม roll-call/promotion แต่ `FishDetail` (specimen, timeline, การแก้ไข) ยังบาง |
| `pages/batches.tsx` | 989 | ครอบคลุม form/plate แต่ยังไม่มี test ของ duplicate batch และ embryo well conflict |
| `pages/settings.tsx` | 930 | `Timing` มี test ดี, `Promotions`/`Controls` ยังบาง |
| `pages/master.tsx` | 532 | `MasterCatalog` (7 resource) มี 2 test |
| `pages/export.tsx` | 350 | มี 1 test — ยังไม่มี test ของ sheet selection / download error |
| `pages/audit.tsx` | 264 | มี 1 test — ยังไม่มี pagination / empty / error |
| `components.tsx` | 157 | `ReportPanel`/`ReportTable`/`Empty` ยังไม่มี test ตรง ๆ |
| `types.ts` | 151 | ไม่มี test ว่าคีย์ `th`/`en` ครบคู่กัน |

---

## 4. กลยุทธ์การทดสอบ

### 4.1 หลักการ

1. **ทดสอบผ่าน seam ที่แคบที่สุดที่ยังพิสูจน์พฤติกรรมได้จริง** — logic บริสุทธิ์ทดสอบเป็นฟังก์ชัน, พฤติกรรม HTTP ทดสอบผ่าน `TestClient` + `MemoryStore` ไม่ mock ชั้นใน
2. **ทดสอบพฤติกรรม ไม่ใช่การ implement** — assert ที่ status code, response body, audit trail และ state ที่อ่านกลับได้ ไม่ assert ที่โครงสร้างภายใน
3. **หนึ่ง test = หนึ่งเหตุผลที่จะพัง** — ชื่อ test ต้องบอกกฎที่กำลังปกป้อง ไม่ใช่ชื่อเมธอด
4. **ทุก negative case ต้องพิสูจน์ว่า state ไม่ถูกแก้** — ไม่ใช่แค่ status code 4xx แต่ต้องอ่านกลับมายืนยันว่าไม่มี partial write
5. **เวลาต้องฉีดเข้าไปได้** — ห้าม test พึ่งพา wall clock จริงในกรณีที่มีขอบเขต (boundary) เช่น 5 นาทีในอนาคต, 15 นาที backdate, promotion threshold
6. **ไม่เพิ่ม dependency ถ้าไม่จำเป็น** — ใช้ pytest/vitest ที่มีอยู่; ข้อยกเว้นเดียวคือ `@vitest/coverage-v8` เพื่อวัด coverage

### 4.2 การจัดชั้น test

| ชั้น | สัดส่วนเป้าหมาย | ความเร็วที่ยอมรับ |
|---|---:|---|
| Pure unit (domain/services/utils) | ~45% | < 1 ms/test |
| HTTP seam / component | ~45% | < 100 ms/test |
| Database integration | ~10% | < 3 s/test |
| ทั้ง suite (ไม่รวม DB) | — | **< 60 วินาที** |

### 4.3 กลยุทธ์ข้อมูลทดสอบ

สร้าง fixture ที่ใช้ร่วมกันใน `backend/tests/conftest.py` (เพิ่มจากของเดิม):

| Fixture | สิ่งที่สร้าง | ใช้กับ |
|---|---|---|
| `store`, `client`, `write_headers` | *(มีอยู่แล้ว)* MemoryStore + TestClient + header เขียน | ทุกไฟล์ |
| `master_data` | site, operator, donor cell line, treatment group, fish box, csof lot, recipient egg lot ครบ 1 ชุด | experiments, fish |
| `seeded_batch` | batch 1 รอบ + injection lot 1 ล็อต + embryo 5 ตัว (activatedAt ย้อนหลัง 6 วัน) | observations, fish, analytics |
| `observed_batch` | ต่อจาก `seeded_batch` + observation ครบถึง stage 26 | analytics, export |
| `promoted_fish` | ต่อจาก `observed_batch` + promotion 3 ตัว + roll-call 2 วัน | fish, analytics, export |
| `fixed_clock` | monkeypatch `runtime.values.utc_now` และ `datetime.now(BANGKOK)` | ทุก test ที่มีขอบเขตเวลา |
| `unique_key` | คืน `X-Idempotency-Key` ใหม่ทุกครั้ง | ทุก mutation ที่เรียกซ้ำในไฟล์เดียว |

Frontend: สร้าง `frontend/tests/helpers.ts` รวม `stubFetch(routes)`, `renderPage(node)`, `resetBrowserState()` (localStorage/sessionStorage/IndexedDB/hash) เพื่อลดการคัดลอกโค้ดจาก 17 ไฟล์ปัจจุบัน

### 4.4 กฎการตั้งชื่อและรหัส test case

- รหัสในเอกสาร: `BE-<MODULE>-<NNN>` / `FE-<MODULE>-<NNN>`
- ชื่อฟังก์ชัน test: ประโยคที่บอกกฎ เช่น `test_dead_embryo_rejects_later_observation_even_with_override`
- ใน docstring หรือคอมเมนต์บรรทัดเดียวของ test ให้อ้างรหัส requirement เช่น `# BR-19, AC-406`
- Test ที่ตรงกับ UAT script ให้ใส่ `T-xx` ในชื่อ เช่น `test_uat_t04_...` *(ตามแบบที่ repo ใช้อยู่แล้ว)*

---

## 5. เกณฑ์ coverage และ exit criteria

### 5.1 เกณฑ์ coverage (บังคับใน CI)

| ชุด | เกณฑ์ปัจจุบัน | เกณฑ์เป้าหมาย |
|---|---|---|
| `chronofish.domain` + `chronofish.services` | line 90% | **line 95% / branch 90%** |
| `chronofish.runtime` | ไม่มีเกณฑ์ | **line 95%** |
| `chronofish.api.routes` | ไม่มีเกณฑ์ | **line 92%** |
| `chronofish.store.memory` | ไม่มีเกณฑ์ | **line 100%** |
| `chronofish.store.sql` + `store.migrations` (DB job) | ไม่มีเกณฑ์ | **line 85%** |
| `chronofish` ทั้งแพ็กเกจ | 80% (ไม่บังคับ) | **line 90%** |
| `frontend/src` (ไม่รวม `api/schema.d.ts`) | ไม่มีการวัด | **line 85% / branch 78%** |
| `frontend/src/pages` | ไม่มีการวัด | **line 80%** |

### 5.2 Exit criteria สำหรับการส่งมอบ

ผ่านทั้งหมดจึงถือว่าชุดทดสอบเสร็จ:

1. Test case ทุกรายการใน [`TEST_CASES_BACKEND.md`](TEST_CASES_BACKEND.md) และ [`TEST_CASES_FRONTEND.md`](TEST_CASES_FRONTEND.md) มีสถานะ `PASS` หรือ `WAIVED` พร้อมเหตุผลที่บันทึกไว้
2. เกณฑ์ coverage ในตาราง §5.1 ผ่านทุกบรรทัด และถูกบังคับใน `.github/workflows/ci.yml`
3. ทั้ง 71 operations ใน OpenAPI มีอย่างน้อย 1 test ที่เรียกจริง (ไม่ใช่แค่ contract-registration test)
4. ทุก BR-01…BR-23 มี test อ้างอิงอย่างน้อย 1 รายการในตาราง traceability §7
5. ไม่มี test ที่ flaky — รัน suite 3 รอบติดกันได้ผลเดิม
6. Suite (ไม่รวม DB job) รันเสร็จภายใน 60 วินาที
7. `ruff format --check`, `ruff check`, `biome ci` ผ่านทั้งใน `src` และ `tests`
8. DB integration job ผ่านทั้ง PostgreSQL 16 และ MySQL 8

---

## 6. แผนการทำงาน (Work packages)

จัดลำดับตามความเสี่ยง × ช่องว่าง ไม่ใช่ตามลำดับโมดูลในโค้ด

| WP | ชื่อ | ผลลัพธ์ | ไฟล์ที่แตะ | เหตุผลที่อยู่ลำดับนี้ |
|---|---|---|---|---|
| **WP0** | เครื่องมือและ fixture | ติดตั้ง `@vitest/coverage-v8`, เพิ่ม coverage config, ขยาย `conftest.py`, สร้าง `tests/helpers.ts` | `frontend/package.json`, `frontend/vite.config.ts`, `backend/tests/conftest.py`, `frontend/tests/helpers.ts` | ไม่มี baseline frontend = วัดความคืบหน้าไม่ได้ |
| **WP1** | Infrastructure & config | BE-CFG, BE-APP, BE-RUN, BE-MAIN | `test_config.py`, `test_app_middleware.py` *(ใหม่)*, `test_runtime.py` *(ใหม่)* | ช่องว่างสูงสุด และเป็นชั้นที่พังแล้วกระทบทุก endpoint |
| **WP2** | Store & migrations | BE-MEM, BE-SQL, BE-MIG, BE-DB | `test_store_memory.py` *(ใหม่)*, `test_migrations.py` *(ใหม่)*, `test_sql_integration.py` | migration runner 16% คือความเสี่ยง deploy โดยตรง |
| **WP3** | Domain rules | BE-DOM | `test_domain_rules.py` *(ใหม่, แยกจาก `test_foundation.py`)* | เป็นฐานของทุกการคำนวณ ทดสอบถูกและเร็ว |
| **WP4** | Master data & timing | BE-MST, BE-TIM | `test_master.py` *(ใหม่)*, `test_timing.py` *(ใหม่)* | ปิด branch CSV/validation ที่ยังขาด |
| **WP5** | Experiments | BE-EXP | `test_experiments.py` | ปิด `POST /injection-lots/{id}/embryos` |
| **WP6** | Observations | BE-OBS | `test_observations.py` | ครบดีอยู่แล้ว เติมเฉพาะขอบ |
| **WP7** | Fish & promotion | BE-FSH | `test_fish.py`, `test_fish_observations.py` *(ใหม่)* | route ที่ coverage ต่ำสุด (78%) |
| **WP8** | Analytics | BE-ANL | `test_analytics.py` | เติม `observation-gaps` และ group-by matrix |
| **WP9** | Export & audit | BE-EXP-XL, BE-AUD | `test_contract_exports_audit.py` | เติม sheet/filter/cursor branches |
| **WP10** | Frontend utilities & client | FE-UTL, FE-API, FE-OFF | ไฟล์เดิม + `types.test.ts` *(ใหม่)* | เร็วและปิดช่องว่างได้เยอะ |
| **WP11** | Frontend shell & components | FE-APP, FE-CMP | `components.test.tsx` *(ใหม่)*, `browser-workflows.test.tsx` | |
| **WP12** | Frontend pages | FE-DUE, FE-BAT, FE-FSH, FE-MST, FE-SET, FE-DSH, FE-AUD, FE-EXP | ไฟล์เดิม + แยกไฟล์ตามหน้า | LOC สูงสุด, เสี่ยงสูงสุด |
| **WP13** | CI gate & รายงาน | อัปเดต `ci.yml`, สรุปผล traceability | `.github/workflows/ci.yml`, `docs/TEST_REPORT.md` | ปิดงาน |

**ลำดับ commit ที่แนะนำ:** หนึ่ง WP = หนึ่ง commit เพื่อให้ review ทีละชั้นและ revert ได้อิสระ

---

## 7. Traceability — business rule ↔ test

| Rule | สาระ | Test case (ดูรายละเอียดในเอกสาร case) |
|---|---|---|
| BR-01 | T0 = `activatedAt` ของ injection lot | BE-OBS-010, BE-OBS-011 |
| BR-02 | `hpaActual` = ชั่วโมงจริงจาก T0 | BE-OBS-012, BE-DOM-020 |
| BR-03 | `hpaExpected` มาจาก snapshot ของ timing profile ที่ batch ผูกไว้ | BE-OBS-013, BE-TIM-030 |
| BR-04 | `deviationH` = actual − expected, ปัดเป็น 4 ตำแหน่ง | BE-DOM-021, BE-OBS-014 |
| BR-06 | อายุปลานับเป็นวันตามปฏิทินกรุงเทพ | BE-DOM-030, BE-FSH-040 |
| BR-07 | Checkpoint ที่ถึงกำหนดเรียงตาม overdue | BE-OBS-001…004 |
| BR-08 | บันทึกได้ทีละหลายตัวอ่อนในรอบเดียว | BE-OBS-020…024 |
| BR-09 | เกณฑ์เลื่อนขั้น = อายุเกิน `stage1MaxAgeDays` และยังมีชีวิต | BE-FSH-001…005 |
| BR-10 | Running number ห้ามซ้ำ | BE-FSH-006, BE-SQL-012 |
| BR-11 | Fish code แนะนำอัตโนมัติ | BE-FSH-007 |
| BR-12 | ตัวอ่อนที่เลื่อนขั้นแล้วปิดด้วย `exitReason=PROMOTED` | BE-FSH-002 |
| BR-13 | สืบทอด ABNORMAL จากตัวอ่อนสู่ปลา | BE-FSH-008, BE-SVC-020 |
| BR-14 | Fish box ต้อง active และอยู่ site เดียวกัน | BE-FSH-009, BE-SVC-030 |
| BR-15 | Roll-call แสดงเฉพาะปลาที่ยังมีชีวิต ณ วันนั้น | BE-FSH-030…033 |
| BR-16 | Specimen ต้องมีวันที่สอดคล้องกัน | BE-FSH-050…057 |
| BR-17 | Soft delete + audit ทุกการลบ | BE-OBS-050, BE-FSH-070 |
| BR-18 | Bulk write idempotent บน `clientUuid` | BE-OBS-030, BE-FSH-060, FE-OFF-020 |
| BR-19 | ตัวอ่อนที่ตายแล้วบันทึกรอบถัดไปไม่ได้ | BE-OBS-040…043 |
| BR-20 | Survival ต้อง monotonic | BE-OBS-044, BE-ANL-020 |
| BR-21 | Checkpoint ที่ข้ามถือว่ารอด (implied) | BE-OBS-045, BE-ANL-021 |
| BR-22 | Backdate เกิน 15 นาทีต้องทำเครื่องหมาย | BE-DOM-040, BE-OBS-015 |
| BR-23 | ป้ายกำกับ deviation สองภาษา | BE-DOM-022…025, FE-DUE-010 |

*(ตารางเต็มระดับ FR-xxx อยู่ท้ายเอกสาร case แต่ละฝั่ง)*

---

## 8. การรัน test

### 8.1 ระหว่างพัฒนา

```powershell
# backend — เร็ว ไม่ต้องมีฐานข้อมูล
cd backend
python -m pytest -q

# backend — พร้อม coverage รายโมดูล
python -m pytest --cov=chronofish --cov-report=term-missing

# backend — รวม DB integration (ต้องมี PostgreSQL/MySQL)
$env:CHRONOFISH_TEST_DATABASE_DRIVER="postgres"
$env:CHRONOFISH_TEST_DATABASE_URL="postgresql+psycopg://postgres:postgres@localhost:5432/chronofish"
python -m pytest -q

# frontend
cd frontend
npx vitest run
npx vitest run --coverage
npx vitest --watch          # ระหว่างแก้โค้ด
```

### 8.2 CI (ที่ต้องแก้ใน WP13)

```yaml
# .github/workflows/ci.yml — job app
- name: Lint and test backend
  working-directory: backend
  run: |
    python -m ruff format --check src tests
    python -m ruff check src tests
    python -m pytest \
      --cov=chronofish \
      --cov-report=term-missing \
      --cov-fail-under=90

- name: Verify and test frontend
  working-directory: frontend
  run: |
    npm ci
    npm run lint
    npm run generate:api
    git diff --exit-code -- src/api/schema.d.ts
    npm test -- --run --coverage
```

> **หมายเหตุ:** เกณฑ์ปัจจุบัน `--cov=chronofish.domain --cov=chronofish.services --cov-fail-under=90` วัดแค่ 2 แพ็กเกจ ทำให้ route/store/runtime หลุดจากเกณฑ์ทั้งหมด การเปลี่ยนเป็น `--cov=chronofish` คือการปิดช่องว่างที่ใหญ่ที่สุดของ CI ปัจจุบัน

---

## 9. ความเสี่ยงของงานทดสอบเอง

| ความเสี่ยง | ผลกระทบ | การรับมือ |
|---|---|---|
| Test ที่พึ่ง wall clock จะ flaky ตอนข้ามเที่ยงคืนกรุงเทพ | suite แดงแบบสุ่ม | บังคับใช้ fixture `fixed_clock` กับทุก case ที่มีขอบเขตเวลา (ระบุไว้ในคอลัมน์ Notes ของแต่ละ case) |
| `MemoryStore` ผ่านแต่ `SQLStore` ไม่ผ่าน | บั๊กหลุดถึง production | ทุก case ที่แตะ persistence/uniqueness/concurrency ต้องมีคู่ใน `test_sql_integration.py` (มาร์ก `DB` ในเอกสาร case) |
| Test ของ dashboard ผูกกับ markup จนแก้ UI แล้วแดง | ทีมเลิกเชื่อ suite | assert ด้วย role/label/text ที่ผู้ใช้เห็น ไม่ใช้ CSS selector หรือ snapshot ทั้งหน้า |
| Suite ช้าจนไม่มีใครรันก่อน push | คุณภาพลด | เพดาน 60 วินาที + ตัด `npm run build` ออกจาก `npm test` (ย้ายไป `npm run check`) |
| Coverage สูงแต่ assert อ่อน | ความมั่นใจปลอม | ทุก negative case ต้อง assert สถานะหลังเกิดเหตุ ไม่ใช่แค่ status code |

---

## 10. ผลผลิตของแผนนี้

| ไฟล์ | เนื้อหา |
|---|---|
| `docs/TEST_PLAN.md` | เอกสารนี้ — กลยุทธ์ ขอบเขต เกณฑ์ แผนงาน |
| `docs/TEST_CASES_BACKEND.md` | test case ระดับ backend ทั้งหมด พร้อม input/expected/requirement |
| `docs/TEST_CASES_FRONTEND.md` | test case ระดับ frontend ทั้งหมด |
| `docs/TEST_REPORT.md` | *(สร้างเมื่อจบ WP13)* ผลรัน coverage และตาราง traceability ที่ปิดครบ |

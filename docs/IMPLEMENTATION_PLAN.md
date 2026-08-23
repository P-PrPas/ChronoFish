# ChronoFish — Detailed Implementation Plan

> สถานะเอกสาร: แผนดำเนินงานสำหรับ SRS v1.0
> วันที่จัดทำ: 20 สิงหาคม 2026
> ตรวจสอบสถานะล่าสุด: 23 สิงหาคม 2026 (Phase 1 เทียบกับ implementation และ automated tests)
> แหล่งความจริง: `SRS_Cloning_Tracking_System.md` → `api/openapi.yaml` → implementation
> ฐานข้อมูลหลัก: PostgreSQL 16 และต้องผ่านชุดทดสอบเดียวกันบน MySQL 8

## 1. วัตถุประสงค์และวิธีใช้เอกสารนี้

เอกสารนี้แปลง Requirement Analysis, SRS และ API contract ให้เป็นลำดับงานที่ implement และตรวจรับได้ทีละช่วง โดยแต่ละช่วงต้องส่งมอบเป็น **vertical slice** ที่ทำงานครบตั้งแต่ฐานข้อมูล, business rule, API, frontend, audit และ automated test ไม่แยกทำ backend ทั้งระบบก่อนแล้วค่อยต่อ frontend ภายหลัง

เมื่อเอกสารขัดแย้งกัน ให้ใช้ลำดับตัดสินดังนี้:

1. SRS v1.0 เป็นแหล่งความจริงของพฤติกรรมและ Acceptance Criteria
2. `api/openapi.yaml` เป็นแหล่งความจริงของ HTTP contract
3. Requirement Analysis ใช้อธิบายบริบท, domain และ roadmap
4. หากต้องเปลี่ยน Requirement ให้บันทึกเป็น change request และแก้ SRS/OpenAPI ก่อนแก้โค้ด

สถานะในเอกสารนี้ใช้สัญลักษณ์:

- `[x]` มีอยู่แล้วและตรวจสอบได้
- `[ ]` ยังต้อง implement
- `[!]` ต้องยืนยันกับผู้ใช้จริงหรือผู้ดูแลระบบก่อนปิดงาน

## 2. Baseline ปัจจุบัน

Repository ปัจจุบันมี implementation ครอบคลุมหลาย phase แล้ว แต่ยังไม่ถือว่าพร้อมใช้งานจริงจนกว่าจะปิด automated checks และ acceptance ภายนอกของแต่ละ phase สถานะจริงมีดังนี้:

| พื้นที่ | สถานะปัจจุบัน | งานที่ยังเหลือ |
|---|---|---|
| Repository | `[x]` แยก `api/`, `backend/`, `frontend/`, `docs/`, `scripts/` แล้ว | รักษาโครงสร้างและเพิ่มไฟล์เมื่อ slice ใช้งานจริงเท่านั้น |
| API contract | `[x]` OpenAPI 3.1 มี 70 operations, frontend types และ Python route-contract test ครบแล้ว | รักษา contract test ทุกครั้งที่แก้ endpoint |
| Backend | `[x]` ย้ายเป็น Python/FastAPI แล้วและถอด Go runtime หลัง behavior/integration gates ผ่าน | ทำ UAT และ performance sign-off กับข้อมูลจริง |
| Database | `[x]` schema/migrations 8 versions, Python migration runner และ integration suite ผ่าน PostgreSQL/MySQL | ทำ backup/restore drill บน infrastructure เป้าหมาย |
| Frontend | `[x]` หน้าหลัก, API client, generated types, offline queue, i18n บางส่วน และ tests มีแล้ว | ตรวจ requirement gaps, accessibility, iPad/Safari และ UAT หลัง backend migration |
| CI | `[x]` เปลี่ยนเป็น Python lint/pytest/coverage, frontend, OpenAPI, Docker build และ DB integration gates แล้ว | ตรวจผล GitHub Actions หลัง push |
| Container | `[x]` Python slim non-root Dockerfile, Compose สำหรับ PostgreSQL/MySQL และ CI image-build gate พร้อมแล้ว | ทดสอบ `docker compose up --build` จาก clean checkout และ environment เป้าหมาย |
| Discovery | `[x]` domain, ERD และข้อกำหนดถูกวิเคราะห์ไว้ละเอียด | `[!]` สังเกต workflow จริงในแลปหนึ่งรอบ, ยืนยันตัวอย่าง export และสภาพแวดล้อม deploy |

สรุป: การย้าย runtime จาก Go เป็น Python เสร็จแล้วและผ่าน contract/integration tests บน PostgreSQL/MySQL งานที่ยังไม่ปิดคือ acceptance ที่ต้องอาศัยผู้ใช้หรือ infrastructure จริง เช่น UAT, reference export, Compose clean-checkout gate, backup/restore และ performance dataset 5 ปี

## 3. ขอบเขต Definition of Done ของระบบ v1

ระบบถือว่าเสร็จสมบูรณ์เมื่อครบทุกข้อด้านล่าง:

- Functional Requirement ระดับ **MUST** ใน FR-100 ถึง FR-1100 ทำงานครบ
- หน้าจอ SCR-01 ถึง SCR-18 ที่จำเป็นต่อ MUST flow ใช้งานได้บน device เป้าหมาย
- UAT T-01 ถึง T-23 ผ่าน; ข้อ SHOULD ที่ยังไม่ทำต้องระบุและได้รับการยอมรับอย่างชัดเจน
- business rules ใน SRS บทที่ 6 ถูกคำนวณที่ backend และมี unit test coverage อย่างน้อย 90%
- integration tests ชุดเดียวกันผ่านทั้ง PostgreSQL 16 และ MySQL 8 ทุก push
- frontend build เป็น static files และ backend ส่งมอบเป็น version-pinned Docker image พร้อม native virtual-environment workflow
- การเขียนข้อมูลทุกครั้งมี `operator_id`, `device_id`, audit record และไม่มี hard delete
- observation ซ้ำด้วย `client_uuid` ไม่สร้างข้อมูลซ้ำ และ offline queue ไม่ทำข้อมูลหายเมื่อ refresh
- Excel 14 sheets, R-ready table และ browser PDF ผ่านการตรวจรับ
- performance, accessibility, browser compatibility, backup/restore และ security controls ตาม NFR ผ่าน
- เดินระบบคู่ขนานกับ Excel เดิมหนึ่งรอบทดลองเต็มและตัวเลขตรงกัน
- มี Python dependency manifest/static artifacts, Dockerfile, environment configuration และคู่มือ deploy/restore/ใช้งาน

### สิ่งที่ไม่อยู่ใน v1

อย่า implement งานต่อไปนี้จนกว่าจะมี change request: temperature-adjusted timing, รูป/วิดีโอ, user account/role, notification, full offline conflict resolution, ประวัติการย้าย box/well และการ import ข้อมูลเก่าจาก Excel

## 4. หลักการลงมือ Implement

### 4.1 ทำเป็น vertical slice

หนึ่ง slice ต้องมีเฉพาะสิ่งที่จำเป็นเพื่อให้ use case หนึ่งทำงานครบ เช่น “สร้าง Batch พร้อม Injection Lot และ Embryo” ต้องรวม transaction, API, form, validation, audit และ test ของ flow นั้นในงานเดียว

### 4.2 Contract-first แต่ไม่ generate โค้ดที่ไม่ใช้

ก่อนเริ่ม endpoint:

1. ตรวจ SRS/BR/AC ที่เกี่ยวข้อง
2. แก้ `api/openapi.yaml` ก่อนเมื่อ contract ยังไม่พอ
3. validate OpenAPI และ regenerate frontend/backend types
4. เขียน service test ของ business rule
5. implement data access, service, handler และ UI ตามลำดับ

ไม่สร้าง handler ว่างครบ 70 operations ล่วงหน้า ให้ generate types/interface ได้ แต่ implement และ register route เฉพาะ slice ปัจจุบัน

### 4.3 แยกชั้นเท่าที่ SRS ต้องการ

- HTTP layer: decode/encode, header, status code และ error envelope
- Service layer: transaction boundary และ business rules
- Store layer: SQL และ mapping ระหว่าง record กับ domain value
- Frontend feature: page, local interaction state และ API calls ของ use case เดียวกัน

ไม่เพิ่ม generic repository, event bus, CQRS, microservice หรือ design pattern ที่ยังไม่มี use case จริง

### 4.4 ความถูกต้องของข้อมูลมาก่อนความสะดวก

- ใช้ UTC ในฐานข้อมูลและ API timestamp ที่มี offset; แสดงผล `Asia/Bangkok`
- ค่าเวลาและ count ใช้ decimal/integer ตาม schema ห้าม float ในฐานข้อมูล
- `deviation_h` เป็น snapshot ที่ backend คำนวณตอนบันทึก ห้ามคำนวณใหม่ย้อนหลัง
- soft delete ต้องถูกกรองออกจาก query ปกติ, dashboard และ export
- ทุก write และ audit ของ write นั้นต้องอยู่ใน transaction เดียวกัน
- bulk operation ต้องสำเร็จ/ล้มเหลวตาม semantics ใน OpenAPI และคืนผลต่อ `clientUuid` อย่างชัดเจน

### 4.5 Portability เป็นเงื่อนไขรายวัน

PostgreSQL migration เป็น canonical source แล้ว generate MySQL copy ด้วย script ที่มีอยู่ ทุก query ที่เพิ่มต้องทดสอบบนฐานข้อมูลทั้งสองชนิดใน PR เดียวกัน ห้ามเลื่อน MySQL compatibility ไปทดสอบปลายโครงการ

## 5. โครงสร้างโค้ดเป้าหมาย

เพิ่ม directory แบบ just-in-time เมื่อมีโค้ดจริงเท่านั้น โครงสร้างเป้าหมายขั้นต่ำคือ:

```text
api/
  openapi.yaml                 # HTTP contract เดียวของระบบ

compose.yaml                   # local API + PostgreSQL; MySQL compatibility profile

backend/
  Dockerfile                   # Python runtime image แบบ non-root
  pyproject.toml               # runtime/dev dependencies และ tooling
  src/chronofish/
    __main__.py                # composition root
    config.py                  # อ่าน/validate environment
    app.py                     # FastAPI composition และ middleware
    api/routes/                # route modules แยกตาม domain capability
    domain/                    # state model และ business rules ที่ไม่ผูก HTTP/DB
    runtime/                   # error, request mutation และ value primitives ที่ใช้ข้าม route
    reporting/                 # portable report encoders เช่น XLSX
    store/                     # Store interface + memory/SQL adapters, engine และ migration runner
  db/migrations/               # มีอยู่แล้ว
  db/seeds/                    # มีอยู่แล้ว
  db/tests/                    # มีอยู่แล้ว

frontend/src/
  api/                         # generated schema + fetch client
  app/                         # app shell, navigation, global contexts
  components/                  # shared UI เฉพาะเมื่อถูกใช้ซ้ำจริง
  features/
    master-data/
    timing/
    batches/
    checkpoints/
    promotions/
    fish/
    dashboard/
    exports/
    audit/
  lib/                         # time/i18n/offline primitives ที่ใช้ข้าม feature
```

Frontend ยัง build เป็น `frontend/dist/` และนำไปวางบน static hosting โดยตรง ไม่ต้องมี frontend container ใน Phase 1 หากสภาพแวดล้อมจริงต้องการ container สำหรับ static files ค่อยใช้ web-server image มาตรฐานใน Phase 9 โดยไม่เปลี่ยน application code

เหตุผลที่ store มีสอง implementation คือระบบต้องรันจริงบนฐานข้อมูลสองชนิด ไม่ใช่ abstraction เผื่ออนาคต ส่วน component หรือ helper ใดใช้เพียง feature เดียวให้เก็บใกล้ feature นั้นก่อน

## 6. ลำดับ Phase และ Dependency

| Phase | ผลลัพธ์หลัก | Dependency | วันทำงานโดยประมาณ* | Roadmap เดิม |
|---|---|---|---:|---|
| 0 | ปิดข้อเท็จจริงจากหน้างาน | Foundation ปัจจุบัน | 1–2 | P0 |
| 1 | Runtime/Docker foundation + Master Data end-to-end | Phase 0 เฉพาะคำตอบที่กระทบ flow | 6–8 | P1 |
| 2 | Protocol/Timing Profile versioning | Phase 1 | 3–4 | P1 |
| 3 | Batch, Injection Lot, Embryo, Control registration | Phase 1–2 | 4–6 | P2 |
| 4 | Due Now และ Embryo Checkpoint | Phase 3 | 6–8 | P2 |
| 5 | Network resilience สำหรับ data entry | Phase 4 API | 2–3 | P3 |
| 6 | Promotion, Fish Registry, Roll-call, Specimen | Phase 3–5 | 5–7 | P2/P3 |
| 7 | Dashboard และ analytics | Phase 4 และ 6 | 7–9 | P4 |
| 8 | Excel/R/PDF export | Phase 7 | 4–5 | P5 |
| 9 | Audit UI, hardening, deploy และ UAT | ทุก phase | 7–10 | P6 |

Phase 5 ต้องเสร็จก่อนให้ผู้ใช้บันทึกข้อมูลจริง แม้จะเริ่มหลัง checkpoint flow เพื่อให้ทดสอบ queue กับ mutation ที่มีอยู่จริงได้

\* ช่วงเวลานี้ใช้วาง capacity สำหรับ fullstack developer หนึ่งคนที่ทำงานต่อเนื่อง รวม implementation/test ใน slice แต่ไม่รวมเวลารอผู้ใช้, infra หรือ UAT โดยลูกค้า รวมประมาณ **9–12 สัปดาห์ที่เหลือ** และต้องปรับใหม่จาก throughput จริงหลังจบ Phase 1 ห้ามใช้เป็น commitment ก่อนปิด Phase 0

## 7. แผน Implementation ราย Phase

### Phase 0 — ปิด Discovery ที่ยังค้าง

**เป้าหมาย:** ยืนยันว่าระบบที่กำลังสร้างตรงกับวิธีทำงานจริงและไม่ต้องแก้ model หลังเริ่ม data entry

งาน:

- [ ] สังเกตการทำงานในแลปจริงตั้งแต่สร้างรอบ, injection, checkpoint อย่างน้อยหนึ่งช่วง และ daily fish roll-call
- [ ] จับจำนวนการแตะ, device, จุดที่ Wi-Fi หลุด, วิธีระบุตัว operator และวิธีแก้รายการผิด
- [ ] ยืนยันศัพท์/label ใน UI ไทย-อังกฤษ โดย stage และ scientific enum คงภาษาอังกฤษ
- [ ] ขอไฟล์ตัวอย่าง Excel/PDF ที่ลูกค้าถือว่าถูกต้องและตัวอย่างที่ R อ่านจริง
- [ ] ยืนยัน hosting, reverse proxy/TLS, ฐานข้อมูลที่จะใช้จริง, IP allowlist/VPN และผู้รับผิดชอบ backup
- [ ] ยืนยันข้อมูลตั้งต้นจริงของ site/operator/master data; seed ตัวอย่างต้องไม่ปะปนกับ production seed
- [x] ยืนยันขอบเขต FR-1001 ตาม SRS: “ทุกการบันทึก” ครอบคลุมทุก mutation; non-bulk writes ที่ยังไม่มี stable idempotency key ต้องแก้ OpenAPI ใน Phase 1 ก่อนเข้า offline queue

**Exit criteria:** ไม่มีคำถามที่เปลี่ยน schema หรือ main workflow ค้างอยู่; deployment owner และ export reference files ถูกระบุแล้ว

### Phase 1 — Runtime/Docker Foundation และ Master Data

**เป้าหมาย:** ส่งมอบ slice แรกที่เปิดระบบแบบ native หรือ container, ต่อฐานข้อมูล, เลือก operator และ CRUD master data ได้จริงทั้ง PostgreSQL/MySQL

#### Backend

- [x] เพิ่ม config validation สำหรับ `PORT`, `DB_DRIVER`, `DATABASE_URL`, `CORS_ALLOWED_ORIGINS` และค่าควบคุม runtime ที่จำเป็นจริง
- [x] เชื่อม SQLAlchemy synchronous, ping ตอน startup, ตั้ง connection pool และปิด engine แบบ graceful shutdown
- [x] ใช้ Python migration runner กับ SQL เดิมผ่านคำสั่ง `python -m chronofish migrate`; SQL ยังเปิดอ่านและรันด้วยมือได้
- [x] ทำ repository queries และ integration test เดียวกันบน PostgreSQL/MySQL
- [x] ทำ contract test เทียบ route/method กับ OpenAPI 3.1 ครบ 70 operations
- [x] เพิ่ม middleware: request logging ที่ไม่เก็บ PII, panic recovery, contract content type (JSON และ CSV import), body-size limit, CORS, write headers และ rate limit
- [x] ทำ error mapper ให้ตอบ `ErrorResponse` และ HTTP 400/404/409/422/429/500 ตาม SRS
- [x] สร้าง audit writer ที่ทำงานใน transaction เดียวกับ mutation
- [x] implement list/create/update-or-deactivate สำหรับ Site, Operator, Donor Cell Line, Recipient Egg Lot, CSOF Lot, Treatment Group และ Fish Box
- [x] normalize `trim` แล้วเทียบ uniqueness แบบ case-insensitive พร้อมรับ DB unique violation เพื่อกัน race condition
- [x] ทุก master list query ไม่คืน soft-deleted rows และเรียงผล deterministic
- [x] รายการสำหรับ dropdown คืนเฉพาะ `active = true` แต่หน้ารายละเอียดเก่าต้อง resolve master ที่ inactive ได้ตาม FR-111

#### Docker/Local Environment

- [x] เพิ่ม `backend/Dockerfile` จาก Python slim image, ติดตั้งเฉพาะ runtime dependencies และรันแบบ non-root
- [x] รัน process ด้วย non-root user, รับ `PORT`/database configuration จาก environment และไม่ bake secret ลง image
- [x] เพิ่ม `.dockerignore` เพื่อไม่ส่ง `.git`, frontend dependencies, build output, local env และไฟล์ชั่วคราวเข้า build context
- [x] เพิ่ม root `compose.yaml`: API + PostgreSQL 16 เป็น local default และ MySQL 8 เป็น compatibility profile
- [x] ใช้ named volumeเฉพาะข้อมูลฐานข้อมูล; API/frontend ไม่มี persistent application state บน local filesystem
- [x] ให้ migration command ใช้ได้เหมือนกันทั้ง native และ container
- [x] ระบุคำสั่งเริ่ม/หยุดและวิธีสลับ driver ใน README โดยไม่ commit credentials จริง
- [x] ไม่เพิ่ม Kubernetes, Helm, container registry workflow หรือ cloud-specific config จนกว่าจะทราบ production hosting

#### Frontend

- [x] สร้าง typed fetch client จาก generated OpenAPI types; แปลง API error เป็นข้อความที่บอกปัญหาและทางแก้
- [x] สร้าง persistent `device_id` แบบ UUID v7 ครั้งแรก และแนบ `X-Device-Id` ทุก write
- [x] เพิ่ม operator selector ที่แสดงคงที่และเปลี่ยนได้ในหนึ่งแตะ; แนบ `X-Operator-Id` ทุก write
- [x] วาง app shell/navigation สำหรับหน้าจอจริง โดยไม่สร้าง placeholder ครบทุกหน้า
- [x] เพิ่มกลไกข้อความไทย/อังกฤษแบบ object ธรรมดาก่อน; เพิ่ม library เมื่อ plural/date complexity พิสูจน์ว่าจำเป็น
- [x] ทำ SCR-16 สำหรับ master data ทั้งเจ็ดประเภท โดย reuse form/table pattern ที่เกิดขึ้นจริง
- [ ] รองรับ loading, empty, field error, conflict, retry และ deactivate confirmation/undo ตาม UI-08

#### Tests และ Exit criteria

- [x] unit test config, normalization และ validation
- [x] handler tests ตรวจ header บังคับ, error envelope และ status code
- [x] repository integration tests ของ workflow/idempotency/restart/audit บน PostgreSQL และ MySQL
- [x] frontend tests ของ operator/device persistence และ master form validation
- [ ] keyboard/touch targets ≥ 44×44, contrast ≥ 4.5:1 และไม่ใช้สีอย่างเดียว
- [ ] Python API start ได้กับ DB ทั้งสองชนิด และ master data CRUD ผ่าน UI จริง
- [ ] `docker compose up --build` เปิด API + PostgreSQL แล้ว health check ผ่านจาก clean checkout
- [x] MySQL migration/integration suite ผ่านด้วย golden expectations เดียวกับ PostgreSQL
- [x] Python package และ static frontend build ส่งมอบได้โดยไม่ต้องมี Docker
- [ ] ครอบคลุม UAT T-17 และฐานของ T-21/T-22

### Phase 2 — Protocol และ Timing Profile

**เป้าหมาย:** ผู้ดูแลเห็น 36 stages, แก้เวลามาตรฐานด้วย version ใหม่ และ batch ในอนาคตอ้างอิง version ที่ถูกต้อง

#### Backend/Database

- [ ] implement list protocols และ stages ตามลำดับ `stage_no`
- [ ] implement current/history timing profile พร้อม timings ครบ 36 stages
- [ ] สร้าง timing profile version ใหม่แบบ transaction เดียว; ห้ามแก้แถว profile เดิม
- [ ] validate stage ครบ/ไม่ซ้ำ, `expected_hpa >= 0` และค่าที่เกี่ยวข้องตาม SRS
- [ ] เปลี่ยน current profile อย่าง atomic และป้องกัน current ซ้ำภายใต้ concurrent requests
- [ ] implement CSV import/export โดย validate ทั้งไฟล์ก่อนเขียน และคืน row-level error ที่แก้ไขได้
- [ ] ยืนยัน query ว่า observation เก่าใช้ snapshot เดิมเสมอ แม้ current profile เปลี่ยน

#### Frontend

- [ ] ทำ SCR-15 เป็นตาราง 36 stages พร้อมค่าเดิม/ค่าใหม่, validation และ confirmation ก่อนสร้าง version
- [ ] แสดงผู้แก้, เวลา, version และประวัติ โดยไม่เปิดให้แก้ version เก่า
- [ ] เพิ่ม CSV download/upload พร้อม preview และ error ต่อแถว
- [ ] preview deviation ใน UI ได้ แต่ label/ค่าหลัง save ต้องใช้ค่าที่ backend คืน

#### Tests และ Exit criteria

- [ ] service tests ครอบคลุม BR-03, BR-04, BR-21 และ formatting BR-23
- [ ] concurrency test current profile uniqueness บน DB สองชนิด
- [ ] CSV round-trip และ malformed file tests
- [ ] UAT T-08 ผ่าน: observation เก่าไม่เปลี่ยนและ batch ใหม่ใช้ profile ใหม่

### Phase 3 — Batch, Injection Lot, Embryo และ Control Registration

**เป้าหมาย:** ลงทะเบียนรอบทดลองและสร้างตัวอ่อนพร้อมรหัส/ตำแหน่ง well ได้ครบ โดยไม่เกิดข้อมูลครึ่งชุด

#### Backend/Database

- [ ] implement batch list/get/create/update และ cursor pagination ตาม OpenAPI
- [ ] bind `timing_profile_id` ตอนสร้าง batch และไม่เปลี่ยนย้อนหลังโดยพลการ
- [ ] implement duplicate batch โดยคัดลอกเฉพาะค่าตั้งต้นตาม FR-305 ไม่คัดลอก observations/results
- [ ] implement create injection lot + embryos ใน transaction เดียว
- [ ] generate `batch_code`, `embryo_code`, sequence และ default well positions ตาม BR/FR โดยตรวจ collision ที่ DB
- [ ] validate activation/start/finish timestamps, count และ business chronology
- [ ] implement list/add/update/soft-delete embryo; ป้องกัน well ซ้ำใน lot
- [ ] implement control arm counts แบบ replace/upsert ที่ deterministic และ audited
- [ ] ตรวจการ rollback เมื่อ embryo ใด embryo หนึ่งผิด เพื่อไม่เหลือ lot ครึ่งชุด

#### Frontend

- [ ] ทำ SCR-04/05 batch list + create/edit/duplicate
- [ ] ทำ SCR-06 injection lot form ที่เพิ่มหลาย lot และ preview embryo codes ก่อนยืนยัน
- [ ] ทำ SCR-03 ผัง 96-well สำหรับ `md/lg`; บน `sm` ใช้รายการตาม SRS
- [ ] ทำ SCR-11 control arm entry พร้อม totals/validation
- [ ] แสดงเวลา Bangkok 24 ชั่วโมง แต่ส่ง ISO 8601 พร้อม offset

#### Tests และ Exit criteria

- [ ] service tests สำหรับ code generation, chronology, count และ duplicate semantics
- [ ] concurrent code/well uniqueness tests บน DB สองชนิด
- [ ] API/UI integration flow สร้าง 1 batch, 3 lots, lot ละ 5 embryos
- [ ] UAT T-01 ผ่าน: ได้ 15 embryos และรหัสถูกต้อง

### Phase 4 — Due Now และ Embryo Checkpoint Entry

**เป้าหมาย:** ส่งมอบหัวใจ Stage 1 ตั้งแต่รายการถึงกำหนดจนบันทึกผลแบบกลุ่มและแก้ไขย้อนหลังได้

#### Backend/Business Rules

- [ ] implement Due Now ตาม BR-22 โดยใช้ activation time + timing snapshot ของ batch
- [ ] implement checkpoint-entry read model: lot, stage, expected time, active embryos, prior state และ well position
- [ ] implement bulk embryo observations แบบ idempotent ต่อ `client_uuid`
- [ ] คำนวณ `hpa_actual`, `hpa_expected`, `deviation_h`, interval deviation และ Thai/English label ที่ backend
- [ ] บังคับ monotonic survival BR-07; เมื่อ override ต้องมีเหตุผลและ audit
- [ ] implement implied survival BR-08 โดยไม่สร้างข้อมูลปลอมที่ทำให้ trace ผิด
- [ ] validate observation time ตาม BR-19 และคืน 409/422 ตามกรณี
- [ ] บันทึก exit event/status เมื่อ DEAD/DEGENERATED และไม่แสดง embryo นั้นใน checkpoint ถัดไป
- [ ] implement correction และ soft-delete observation พร้อม reason, before/after audit และ recalculation ที่ไม่แก้ snapshot อื่น
- [ ] ป้องกัน request ซ้ำและ concurrent save ด้วย unique constraint + transaction ไม่ใช่การเช็คใน memory

#### Frontend

- [ ] ทำ SCR-01 Due Now เรียง overdue/เวลาที่ถึงกำหนด พร้อม filter ที่จำเป็น
- [ ] refresh Due Now อัตโนมัติอย่างน้อยทุก 60 วินาทีเมื่อออนไลน์ และเพิ่มจำนวน pending promotions เมื่อ Phase 6 พร้อม
- [ ] ทำ SCR-02 checkpoint entry แบบ “รอดทั้งหมด” แล้วแตะแก้เฉพาะ exception
- [ ] แสดง 96-well/list, NORMAL/ABNORMAL/UNDETERMINED และ DEAD/DEGENERATED โดยมีข้อความ/ไอคอนร่วมกับสี
- [ ] ให้แตะ embryo วน `ALIVE → DEAD → DEGENERATED → ALIVE`, มี “รอดทั้งหมด” และ “ตายทั้งหมดที่เหลือ”
- [ ] ตั้ง `observed_at` เป็นเวลาปัจจุบัน, แก้ย้อนหลังได้, แสดง `T+HH:MM` สด และเก็บ `is_backdated` เมื่อเกิน 15 นาที
- [ ] แสดง progress `checkpoint X/26 · เหลือรอด M/N`
- [ ] คำนวณ deviation preview ทันที แต่ replace ด้วย official response หลัง save
- [ ] ทำ correction flow พร้อม reason และ confirm/undo
- [ ] แสดง operator และ save status ในตำแหน่งคงที่ทุกขนาดจอ

#### Tests และ Exit criteria

- [ ] table-driven unit tests ครบ BR-01, BR-02, BR-04, BR-07, BR-08, BR-16, BR-18, BR-19 และ BR-23
- [ ] idempotency test ส่ง UUID เดิมอย่างน้อย 4 ครั้งแล้วมี row เดียว
- [ ] integration test transaction/audit/soft-delete บน DB สองชนิด
- [ ] interaction test “all alive” ภายใน 3 taps และ UI response <100 ms
- [ ] checkpoint page พร้อมใช้ <1 วินาทีในเครือข่ายปกติ
- [ ] UAT T-02, T-03, T-04, T-05, T-15 และ T-16 ผ่าน

### Phase 5 — Network Resilience

**เป้าหมาย:** การบันทึก operational data ไม่สูญหายและไม่ซ้ำเมื่อ Wi-Fi วูบ, refresh หรือปิดแท็บ

#### Contract/Backend

- [ ] ใช้ scope “ทุกการบันทึก” ตาม SRS และเติม stable idempotency field/header ใน OpenAPI ให้ทุก mutation ก่อนนำเข้า queue
- [ ] ให้ idempotency check และ mutation อยู่ transaction เดียวกัน
- [ ] duplicate request ต้องคืน HTTP 200 พร้อม record เดิม ไม่ตอบ conflict
- [ ] แยก retriable errors (network/5xx/429) จาก rejected business errors (4xx) ให้ frontend จัดการได้

#### Frontend

- [ ] สร้าง write queue บน native IndexedDB; เก็บ payload, headers ที่จำเป็น, attempt count, next attempt และสถานะ
- [ ] optimistic update ก่อน network response และ reconcile ด้วย server result
- [ ] retry แบบ exponential backoff พร้อม jitter และหยุด retry อัตโนมัติเมื่อเป็น business rejection
- [ ] เก็บ queue ข้าม reload/tab close/device sleep และ drain เมื่อ online หรือเมื่อเปิดแอปครั้งถัดไป
- [ ] แสดง `บันทึกแล้ว` / `กำลังส่ง…` / `ค้าง N รายการ` ในตำแหน่งคงที่
- [ ] เตือนก่อนปิด tab เมื่อมี pending rows
- [ ] ป้องกันการกดซ้ำสร้าง UUID ใหม่ให้ logical write เดิม
- [ ] เพิ่ม Service Worker/app manifest เพื่อ cache app shell และติดตั้งบน iPad หากผ่านการทดสอบ Safari

#### Tests และ Exit criteria

- [ ] browser test: offline save → refresh → online → row ถูกส่งหนึ่งครั้ง
- [ ] browser test: timeout หลัง server commit → retry → ไม่มี duplicate
- [ ] browser test: rejected item ไม่ block รายการถัดไปและผู้ใช้เห็นวิธีแก้
- [ ] ทดสอบ IndexedDB quota/error และห้ามแสดง “บันทึกแล้ว” เมื่อยังเขียน queue ไม่สำเร็จ
- [ ] UAT T-06, T-07 และ AC-1002/AC-1003 ผ่านบน Safari iPad จริง

### Phase 6 — Promotion, Fish Registry, Daily Roll-call และ Specimen

**เป้าหมาย:** เชื่อม Stage 1 ไป Stage 2 และติดตามปลาแบบรายวันได้ครบ

#### Backend/Business Rules

- [ ] implement pending promotion ตาม BR-09 และสถานะ embryo lifecycle
- [ ] implement bulk promotion แบบ idempotent; สร้าง fish + เปลี่ยน embryo status + audit ใน transaction เดียว
- [ ] คำนวณ `dob` จากวัน activation ตาม BR-10
- [ ] เสนอ/จ่าย `fish_code` และ `running_no` ตาม BR-13/BR-14 พร้อม concurrent uniqueness test
- [ ] อนุญาต promotion ของ ABNORMAL และเก็บ first abnormality onset ตาม BR-12
- [ ] implement fish list/get/create-manually/update พร้อม pagination/filter และ age ที่คำนวณสด
- [ ] implement roll-call read model ตาม date/box และไม่รวม fish ที่ออกจาก risk set แล้ว
- [ ] implement bulk fish observations แบบ idempotent, backdating, status transition และ treatment fields
- [ ] implement fish observation correction/soft-delete พร้อม reason/audit
- [ ] implement specimen list/create และ validations ของ specimen type/storage/date

#### Frontend

- [ ] ทำ SCR-07 pending promotions และ bulk confirmation
- [ ] ทำ SCR-08 fish registry พร้อม filters/date range
- [ ] ทำ SCR-09 fish detail timeline, current state, age, first abnormality และ specimens
- [ ] ทำ SCR-10 roll-call แบบ “ยังอยู่ทั้งหมด” แล้วแก้ exception; รองรับมือถือ 375 px
- [ ] ปุ่ม `ยังอยู่` / `ตาย` / `แช่แข็ง` / `คัดออก` ต้องเปลี่ยนปลาแต่ละตัวได้ในหนึ่งแตะ
- [ ] ทำ backdate mode ที่แสดงวันเป้าหมายชัดเจนตลอด flow
- [ ] แสดง treatment/specimen forms เฉพาะเมื่อเกี่ยวข้องกับสถานะนั้น

#### Tests และ Exit criteria

- [ ] unit tests BR-09 ถึง BR-14 และ fish state machine
- [ ] concurrency test fish running number/code บน DB สองชนิด
- [ ] daily roll-call all-alive ภายใน 2 taps และ 5 วินาที
- [ ] UAT T-09 ถึง T-14 ผ่าน

### Phase 7 — Analytics และ Dashboard

**เป้าหมาย:** Dashboard สามแท็บคำนวณจาก raw data อย่าง deterministic และ drill down กลับไปหา record ได้

#### Backend

- [ ] สร้าง analytics fixture เล็กที่มนุษย์คำนวณผลได้ก่อนเขียน query
- [ ] implement shared filters ชุดเดียวกันทุก analytics endpoint
- [ ] implement KPI, funnel, risk set/survival, timing deviation, abnormality onset, fish survival, observation gaps และ end-to-end pipeline
- [ ] ใช้ BR-15/BR-16/BR-17 เป็นสูตรเดียวใน service/query; ไม่เก็บเปอร์เซ็นต์คำนวณแล้วลง DB
- [ ] ระบุ denominator/unknown/missing data ใน response ให้ UI ไม่ตีความเอง
- [ ] เพิ่ม index เฉพาะจาก query plan ของ dataset 5 ปี ไม่เพิ่ม index แบบคาดเดา
- [ ] ยืนยันผล query เหมือนกันทั้ง PostgreSQL/MySQL ด้วย golden expectations เดียวกัน

#### Frontend

- [ ] ทำ SCR-12 Stage 1: KPI, funnel, survival, deviation distribution และ abnormality onset
- [ ] ทำ SCR-13 Stage 2: current status, survival, condition, treatment และ gaps
- [ ] ทำ SCR-14 end-to-end pipeline
- [ ] ทำ filter bar ชุดเดียว: date, site, operator, treatment, donor line/strain และ batch
- [ ] สะท้อน filter ใน URL เพื่อ bookmark/share ได้ และแสดงจำนวนตัวอย่าง `(n)` ในทุกกราฟ
- [ ] ทุก chart/table มี loading, empty, unknown, accessible label และไม่สื่อด้วยสีอย่างเดียว
- [ ] drill down จาก aggregate ไป batch/embryo/fish record ที่เป็นต้นทาง
- [ ] เพิ่ม print stylesheet ที่ซ่อน navigation และจัด page break สำหรับ browser PDF

#### Tests และ Exit criteria

- [ ] formula unit tests BR-15 ถึง BR-17 รวม zero denominator และ missing checkpoint
- [ ] golden analytics integration tests บนฐานข้อมูลสองชนิด
- [ ] ตรวจตัวเลขกับการนับด้วยมือจาก fixture
- [ ] โหลดข้อมูลจำลอง 5 ปีและ dashboard ครบ <3 วินาที
- [ ] UAT T-18 ผ่าน

### Phase 8 — Excel, R-ready Table และ PDF Export

**เป้าหมาย:** ส่งออกข้อมูลที่นักวิจัยเปิดในเครื่องมือเดิมได้ทันทีโดยไม่เขียนไฟล์ถาวรบน backend

#### Backend

- [ ] implement Excel 14 sheets ตาม SRS ภาคผนวก B ด้วย `excelize`
- [ ] ทุก sheet มี header แถวเดียว, ไม่มี merged cell และใช้ flat table
- [ ] `00_Metadata` ระบุช่วงข้อมูล, filters, export time, system/timing-profile version และ row count ของแต่ละ sheet
- [ ] ใช้ filters และสูตรเดียวกับ dashboard; ไม่ duplicate business calculation ใน export package
- [ ] stream file จาก memory/temporary stream ที่ไม่เป็น persistent application state
- [ ] กำหนด column order, header, numeric/date types, enum และ null representation แบบคงที่
- [ ] implement `12_R_Analysis_Table` ให้ checkpoint columns เป็น numeric และอ่านด้วย `readxl` ได้ทันที
- [ ] implement R-table CSV endpoint พร้อม UTF-8 และ deterministic ordering
- [ ] หากเวลาพอหลัง MUST ครบ ให้เพิ่ม CSV รายตารางตาม FR-908 (SHOULD)

#### Frontend

- [ ] ทำ SCR-17 เลือก filter/format และ download โดยแสดง progress/error ที่เข้าใจได้
- [ ] ใช้ browser print จาก dashboard สำหรับ PDF; ไม่เพิ่ม headless-browser service
- [ ] ตรวจ print preview ขนาด A4, title/filter context, chart legend และ page breaks

#### Tests และ Exit criteria

- [ ] เปิด workbook ด้วย Excel 2016+, LibreOffice, pandas และ `readxl`
- [ ] automated workbook test ตรวจครบ 14 sheet, ชื่อ/ลำดับ column และชนิดค่าหลัก
- [ ] full-volume export เสร็จ <30 วินาทีและไม่ทิ้งไฟล์บน filesystem
- [ ] UAT T-19 และ T-20 ผ่าน

### Phase 9 — Audit UI, Hardening, Deployment และ UAT

**เป้าหมาย:** ปิด NFR, ส่งมอบระบบที่ deploy/restore ได้ และยืนยันกับข้อมูลจริง

#### Product completeness

- [ ] ทำ SCR-18 audit log/filter และ record history สำหรับ FR-1103
- [ ] ตรวจทุก create/update/deactivate/correction/delete ว่ามี before/after, operator, device และ timestamp
- [ ] ตรวจทุกหน้าจอที่มี write ว่ามี operator/save status คงที่
- [ ] ตรวจภาษาไทย/อังกฤษครบและ stage/scientific enum ไม่ถูกแปล

#### Security/Operations

- [ ] enforce HTTPS และ IP allowlist/VPN ที่ reverse proxy/hosting
- [ ] ตรวจ rate limit, CORS, body limits, SQL parameters, output escaping และ error redaction
- [ ] harden Docker image จาก Phase 1: pin base versions, non-root, minimal runtime files, image labels และ vulnerability scan
- [ ] ทดสอบ production image กับ environment จริงโดยใช้ artifact เดียวกับที่ผ่าน UAT
- [ ] ส่งมอบ Dockerfile/image instructions ควบคู่กับ Python dependency manifest + `frontend/dist/`; ห้ามบังคับให้ปลายทางต้องใช้ container
- [ ] หาก hosting ต้องการ frontend container ให้เพิ่ม static web-server configuration ที่รองรับ SPA fallback โดยไม่เพิ่ม Node runtime ฝั่ง production
- [ ] ทดสอบ fresh install จาก migration + seed บน PostgreSQL และ MySQL
- [ ] ตั้ง daily backup เก็บ 30 วัน และทำ restore drill อย่างน้อยหนึ่งครั้ง
- [ ] บันทึก environment variables, migration, rollback, backup/restore และ upgrade procedure ในคู่มือส่งมอบ
- [ ] ตรวจว่า backend ไม่เก็บ persistent state บน local filesystem

#### Quality/UAT

- [ ] รัน business-rule coverage และให้ถึง ≥90%
- [ ] ทดสอบ Safari iPadOS สอง major versions ล่าสุด, Chrome/Edge สอง versions ล่าสุด และ viewport 375–2560 px
- [ ] ตรวจ WCAG 2.1 AA เฉพาะ flow หลักด้วย automated scan + keyboard/screen-reader/manual touch test
- [ ] ทดสอบ NFR-101 ถึง NFR-106 ด้วย dataset 5 ปี
- [ ] รัน UAT T-01 ถึง T-22 และเก็บผล/ผู้ยืนยัน
- [ ] เดิน parallel run กับ Excel เดิมหนึ่งรอบเต็ม (T-23) และ reconcile ตัวเลขทุกจุด
- [ ] แก้ blocker แล้ว rerun เฉพาะกรณีที่กระทบพร้อม regression suite ทั้งหมด

**Final exit criteria:** UAT sign-off, restore drill ผ่าน, artifacts deploy ได้ในสภาพแวดล้อมจริง และไม่มี MUST requirement ค้าง

## 8. Requirement-to-Phase Traceability

| Requirement | Phase หลัก | UAT หลัก |
|---|---|---|
| FR-100 Master Data | 1 | T-17, T-21 |
| FR-200 Protocol/Timing | 2 | T-08 |
| FR-300 Batch/Embryo Registration | 3 | T-01 |
| FR-400 Stage 1 Entry | 4 | T-02 ถึง T-05, T-15, T-16 |
| FR-500 Promotion | 6 | T-09 ถึง T-11 |
| FR-600 Fish Tracking | 6 | T-12 ถึง T-14 |
| FR-700 Control Arm | 3 และ 7 | ตรวจ entry + dashboard fixture |
| FR-800 Dashboard | 7 | T-18 |
| FR-900 Export | 8 | T-19, T-20 |
| FR-1000 Network Resilience | 5 | T-06, T-07 |
| FR-1100 Correction/Audit | เริ่ม 1, ทำราย slice, ปิด 9 | T-15 และ audit review |
| NFR-500 Portability | ทุก phase | T-22 |
| NFR-700 Accessibility/Language | ทุก UI slice, ปิด 9 | T-21 |
| Parallel Run | 9 | T-23 |

## 9. Test Strategy

### 9.1 ชนิดการทดสอบ

| ระดับ | ตรวจอะไร | รันเมื่อใด |
|---|---|---|
| Service unit | BR/state transition/calculation/validation | ทุก push |
| HTTP handler | contract, headers, status, error envelope | ทุก push |
| DB integration | query, transaction, constraint, audit, portability | ทุก push บน PostgreSQL/MySQL |
| Frontend unit/component | interaction state, validation, queue state | ทุก push |
| Browser E2E | critical flows, IndexedDB/offline, responsive | PR และ release candidate |
| Contract generation | OpenAPI validate + generated files clean | ทุก push |
| Performance | p95 API, dashboard/export volume, JS size | ก่อน UAT และ release |
| Manual device/UAT | glove touch, Safari, language, PDF/Excel, workflow | ท้าย slice สำคัญและ Phase 9 |

### 9.2 Test data

ใช้ข้อมูลสามชุดแยกกัน:

1. **Small deterministic fixture** สำหรับสูตรและ expected output ที่ตรวจด้วยมือได้
2. **Workflow fixture** สำหรับ UAT T-01 ถึง T-22
3. **Five-year volume fixture** ตาม NFR-7.2 สำหรับ performance เท่านั้น

ห้ามใช้ production data หรือ seed ตัวอย่างเป็น expected fixture แบบแก้ตามผลลัพธ์ เพราะจะทำให้ test ยืนยัน bug เดิม

### 9.3 CI เป้าหมาย

ต่อยอด workflow ปัจจุบันให้มี gates ตามลำดับ:

1. OpenAPI validation และ generated frontend/backend types clean
2. PostgreSQL canonical migration → generated MySQL migration clean
3. Ruff/pytest และ business-rule coverage
4. build backend Docker image และตรวจว่า container start/health ผ่าน
5. PostgreSQL integration suite
6. MySQL integration suite เดียวกันในเชิงพฤติกรรม
7. frontend unit test, type-check และ static build
8. critical browser E2E เมื่อมี flow พร้อม

ถ้า migration หรือ API contract เปลี่ยนโดย generated artifact ไม่ตรง CI ต้อง fail ทันที

## 10. Definition of Done ต่อหนึ่ง Slice

ก่อน merge ทุก slice ต้องตอบ “ใช่” ได้ครบ:

- [ ] Requirement/BR/AC ที่รองรับถูกระบุใน PR/commit
- [ ] OpenAPI และ generated types ตรงกับ implementation
- [ ] migration/query ผ่าน PostgreSQL และ MySQL
- [ ] validation อยู่ทั้ง trust boundary และ business layer ตามความเหมาะสม
- [ ] write เป็น transaction, idempotent ตาม contract และมี audit
- [ ] ไม่มี hard delete หรือค่าคำนวณต้องห้ามถูก persist
- [ ] UI มี loading/empty/error/success/pending state และ touch/accessibility basics
- [ ] automated test ที่เล็กที่สุดแต่จับ regression สำคัญถูกเพิ่ม
- [ ] commands ใน README ยังรันผ่านจาก clean checkout
- [ ] เมื่อเปลี่ยน runtime/dependency Docker image และ native virtual-environment run ต้องผ่านทั้งคู่
- [ ] ไม่มี secret, temporary export หรือ generated junk ถูก commit

## 11. ลำดับ PR/Commit ที่แนะนำสำหรับเริ่มงานทันที

ให้เริ่มจาก slice เล็กและพิสูจน์ architecture ด้วยของจริง:

1. **Python runtime migration + DB + Docker + write-idempotency contract** — config, connection, migration command, OpenAPI contract tests, backend Dockerfile, Compose และ CI
2. **Site + Operator end-to-end** — สอง master types แรก, audit, headers, operator/device UI
3. **Remaining Master Data** — ขยาย pattern ที่พิสูจน์แล้วไปอีกห้าประเภท
4. **Timing Profile read** — protocol/stages/current/history
5. **Timing Profile write + CSV** — versioning/concurrency/import/export
6. **Batch create end-to-end** — batch หนึ่งรอบผ่าน UI/API/DB/audit
7. **Injection Lot + Embryo generation** — transaction/code/well
8. เดินตาม Phase 4 เป็นต้นไป โดยแยก PR ตาม use case ไม่ใช่ตาม layer

แต่ละ PR ควร deploy/test ได้เองและไม่ควรรวม refactor ที่ไม่เกี่ยวข้อง หาก pattern เริ่มซ้ำจริงค่อย extract ใน PR ถัดไป

## 12. ความเสี่ยงและ Decision Gates

| Gate | ความเสี่ยงหากไม่ปิด | เวลาที่ต้องปิด | แนวทางแนะนำ |
|---|---|---|---|
| Workflow แลปจริง | UI แตะช้า/ศัพท์ผิด/flow ใช้จริงไม่ได้ | ก่อนปิด Phase 1 | สังเกตหนึ่งรอบและทดสอบ prototype บน iPad |
| Offline scope ทุก write | contract บาง mutation ไม่มี idempotency | ก่อน Phase 5 | ตัดสิน scopeและแก้ OpenAPI ก่อนเขียน queue |
| Hosting/network | ทำ HTTPS, allowlist, backup และ DB driver ไม่ได้ตามแผน | ก่อน Phase 9; ควรรู้ใน Phase 0 | ยืนยัน infra owner และทำ deploy smoke test เร็ว |
| Export reference | 14 sheets ถูก schema แต่ผู้ใช้/R ใช้ไม่ได้ | ก่อน Phase 8 | รับไฟล์/สคริปต์จริงและสร้าง golden fixture |
| Dual-database SQL | ผ่าน PostgreSQL แต่พัง MySQL ช่วงท้าย | ทุก PR | CI integration สองฐานข้อมูลตั้งแต่ query แรก |
| Running number concurrency | fish code ซ้ำในงาน bulk/concurrent | Phase 6 | ใช้ DB uniqueness + transaction/retry และ stress test |
| ไม่มี legacy migration | ไม่มี reference dataset พิสูจน์ผล | Phase 9 | parallel run กับ Excel หนึ่งรอบเต็มตาม T-23 |
| ไม่มี authentication | ระบบถูกเปิดกว้างเกิน scope ลูกค้า | ก่อน production | HTTPS + VPN/IP allowlist + audit/operator/device ตาม SRS |

## 13. Milestone Review Checklist

เมื่อจบแต่ละ Phase ให้ review สี่มุมพร้อมกัน:

- **Spec:** FR/BR/AC ที่ระบุทำงานครบหรือไม่
- **Data:** transaction, audit, soft delete, idempotency และ portability ถูกต้องหรือไม่
- **Lab UX:** ผู้ใช้ทำงานบน iPad/มือถือได้ตามจำนวนการแตะและเวลาเป้าหมายหรือไม่
- **Operations:** build, migrate, deploy, observe และ restore ได้หรือไม่

หากมุมใดไม่ผ่าน Phase ยังไม่ถือว่าเสร็จ แม้ endpoint หรือหน้าจอจะดูเหมือนทำงานแล้ว

---

แผนนี้ควรถูกอัปเดตเมื่อจบแต่ละ Phase โดยเปลี่ยน checklist จาก `[ ]` เป็น `[x]` พร้อมอ้าง commit/ผลทดสอบ และเพิ่ม change request เฉพาะเมื่อ SRS เปลี่ยน ไม่เพิ่มงาน “เผื่ออนาคต” ลงใน v1

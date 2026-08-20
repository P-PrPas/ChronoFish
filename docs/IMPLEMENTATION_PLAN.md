# ChronoFish — Detailed Implementation Plan

> สถานะเอกสาร: แผนดำเนินงานสำหรับ SRS v1.0  
> วันที่จัดทำ: 20 สิงหาคม 2026  
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

Repository ปัจจุบันเป็น foundation ที่ดีสำหรับเริ่มงาน แต่ยังไม่ใช่ application ที่ใช้งานจริงได้ สถานะจริงมีดังนี้:

| พื้นที่ | สถานะปัจจุบัน | งานที่ยังเหลือ |
|---|---|---|
| Repository | `[x]` แยก `api/`, `backend/`, `frontend/`, `docs/`, `scripts/` แล้ว | รักษาโครงสร้างและเพิ่มไฟล์เมื่อ slice ใช้งานจริงเท่านั้น |
| API contract | `[x]` OpenAPI 3.1 มี 69 operations และ frontend types ถูก generate แล้ว | generate Go server types/stubs และ implement 68 business operations; ปัจจุบันมีเพียง health endpoint |
| Backend | `[x]` Go HTTP server, health endpoint, CORS และ test ขั้นต้น | config ฐานข้อมูล, migration runner, service layer, data access, validation, audit, rate limit และ business endpoints |
| Database | `[x]` schema, protocol/stage seed, optional master seed และ constraint checks สำหรับ PostgreSQL/MySQL | runtime connection, sqlc queries, repository integration tests, migration lifecycle และ backup/restore |
| Frontend | `[x]` Vite + React + TypeScript shell, responsive baseline และ generated API types | routing/navigation, API client, operator/device context, i18n, ทุกหน้าจอ SCR-01 ถึง SCR-18, offline queue และ tests |
| CI | `[x]` ตรวจ Go, frontend build, OpenAPI, generated types, migrations และ constraints บนฐานข้อมูลสองชนิด | เพิ่ม unit/integration/UI/E2E/performance gates ตามแต่ละ phase |
| Discovery | `[x]` domain, ERD และข้อกำหนดถูกวิเคราะห์ไว้ละเอียด | `[!]` สังเกต workflow จริงในแลปหนึ่งรอบ, ยืนยันตัวอย่าง export และสภาพแวดล้อม deploy |

สรุป: งาน foundation ด้าน contract และ schema เดินหน้าไปมากแล้ว แต่ feature ตาม FR-100 ถึง FR-1100 ยังต้อง implement เกือบทั้งหมด

## 3. ขอบเขต Definition of Done ของระบบ v1

ระบบถือว่าเสร็จสมบูรณ์เมื่อครบทุกข้อด้านล่าง:

- Functional Requirement ระดับ **MUST** ใน FR-100 ถึง FR-1100 ทำงานครบ
- หน้าจอ SCR-01 ถึง SCR-18 ที่จำเป็นต่อ MUST flow ใช้งานได้บน device เป้าหมาย
- UAT T-01 ถึง T-23 ผ่าน; ข้อ SHOULD ที่ยังไม่ทำต้องระบุและได้รับการยอมรับอย่างชัดเจน
- business rules ใน SRS บทที่ 6 ถูกคำนวณที่ backend และมี unit test coverage อย่างน้อย 90%
- integration tests ชุดเดียวกันผ่านทั้ง PostgreSQL 16 และ MySQL 8 ทุก push
- frontend build เป็น static files และ backend build เป็น executable เดียว
- การเขียนข้อมูลทุกครั้งมี `operator_id`, `device_id`, audit record และไม่มี hard delete
- observation ซ้ำด้วย `client_uuid` ไม่สร้างข้อมูลซ้ำ และ offline queue ไม่ทำข้อมูลหายเมื่อ refresh
- Excel 14 sheets, R-ready table และ browser PDF ผ่านการตรวจรับ
- performance, accessibility, browser compatibility, backup/restore และ security controls ตาม NFR ผ่าน
- เดินระบบคู่ขนานกับ Excel เดิมหนึ่งรอบทดลองเต็มและตัวเลขตรงกัน
- มี binary/static artifacts, Dockerfile, environment configuration และคู่มือ deploy/restore/ใช้งาน

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

ไม่สร้าง handler ว่างครบ 69 operations ล่วงหน้า ให้ generate types/interface ได้ แต่ implement และ register route เฉพาะ slice ปัจจุบัน

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

backend/
  cmd/api/                     # composition root และ executable
  internal/config/             # อ่าน/validate environment
  internal/httpapi/            # generated API types + handlers/middleware
  internal/service/            # business use cases และ rules
  internal/store/              # contract ที่มี PostgreSQL/MySQL implementations จริง
    postgres/                  # sqlc generated code + adapter
    mysql/                     # sqlc generated code + adapter
  db/queries/
    postgres/                  # SQL input ของ sqlc
    mysql/
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

เหตุผลที่ store มีสอง implementation คือระบบต้องรันจริงบนฐานข้อมูลสองชนิด ไม่ใช่ abstraction เผื่ออนาคต ส่วน component หรือ helper ใดใช้เพียง feature เดียวให้เก็บใกล้ feature นั้นก่อน

## 6. ลำดับ Phase และ Dependency

| Phase | ผลลัพธ์หลัก | Dependency | วันทำงานโดยประมาณ* | Roadmap เดิม |
|---|---|---|---:|---|
| 0 | ปิดข้อเท็จจริงจากหน้างาน | Foundation ปัจจุบัน | 1–2 | P0 |
| 1 | Runtime foundation + Master Data end-to-end | Phase 0 เฉพาะคำตอบที่กระทบ flow | 5–7 | P1 |
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
- [ ] ยืนยันขอบเขต FR-1001 คำว่า “ทุกการบันทึก”: หากรวม master/batch mutations ต้องเพิ่ม idempotency key ให้ contract ของ mutation เหล่านั้นก่อนทำ offline queue

**Exit criteria:** ไม่มีคำถามที่เปลี่ยน schema หรือ main workflow ค้างอยู่; deployment owner และ export reference files ถูกระบุแล้ว

### Phase 1 — Runtime Foundation และ Master Data

**เป้าหมาย:** ส่งมอบ slice แรกที่เปิดระบบ, ต่อฐานข้อมูล, เลือก operator และ CRUD master data ได้จริงทั้ง PostgreSQL/MySQL

#### Backend

- [ ] เพิ่ม config validation สำหรับ `PORT`, `DB_DRIVER`, `DATABASE_URL`, `CORS_ALLOWED_ORIGINS` และค่าควบคุม runtime ที่จำเป็นจริง
- [ ] เชื่อม `database/sql`, ping ตอน startup, ตั้ง connection pool และปิด connection แบบ graceful shutdown
- [ ] ใช้ `golang-migrate` กับ SQL เดิมผ่าน executable เดียว เช่น flag `-migrate-only`; SQL ต้องยังเปิดอ่านและรันด้วยมือได้
- [ ] เพิ่ม `sqlc` config สำหรับ PostgreSQL/MySQL และ CI check ว่า generated code ไม่ค้าง
- [ ] generate Go types/server contract จาก OpenAPI 3.1 ด้วย `oapi-codegen`
- [ ] เพิ่ม middleware: request logging ที่ไม่เก็บ PII, panic recovery, JSON content type, body-size limit, CORS, write headers และ rate limit
- [ ] ทำ error mapper ให้ตอบ `ErrorResponse` และ HTTP 400/404/409/422/429/500 ตาม SRS
- [ ] สร้าง audit writer ที่ทำงานใน transaction เดียวกับ mutation
- [ ] implement list/create/update-or-deactivate สำหรับ Site, Operator, Donor Cell Line, Recipient Egg Lot, CSOF Lot, Treatment Group และ Fish Box
- [ ] normalize `trim + lower` ก่อน uniqueness check พร้อมรับ DB unique violation เพื่อกัน race condition
- [ ] ทุก list query ไม่คืน soft-deleted rows และเรียงผล deterministic
- [ ] รายการสำหรับ dropdown คืนเฉพาะ `active = true` แต่หน้ารายละเอียดเก่าต้อง resolve master ที่ inactive ได้ตาม FR-111

#### Frontend

- [ ] สร้าง typed fetch client จาก generated OpenAPI types; แปลง API error เป็นข้อความที่บอกปัญหาและทางแก้
- [ ] สร้าง persistent `device_id` แบบ UUID v7 ครั้งแรก และแนบ `X-Device-Id` ทุก write
- [ ] เพิ่ม operator selector ที่แสดงคงที่และเปลี่ยนได้ในหนึ่งแตะ; แนบ `X-Operator-Id` ทุก write
- [ ] วาง app shell/navigation สำหรับหน้าจอจริง โดยไม่สร้าง placeholder ครบทุกหน้า
- [ ] เพิ่มกลไกข้อความไทย/อังกฤษแบบ object ธรรมดาก่อน; เพิ่ม library เมื่อ plural/date complexity พิสูจน์ว่าจำเป็น
- [ ] ทำ SCR-16 สำหรับ master data ทั้งเจ็ดประเภท โดย reuse form/table pattern ที่เกิดขึ้นจริง
- [ ] รองรับ loading, empty, field error, conflict, retry และ deactivate confirmation/undo ตาม UI-08

#### Tests และ Exit criteria

- [ ] unit test config, normalization และ validation
- [ ] handler tests ตรวจ header บังคับ, error envelope และ status code
- [ ] repository integration tests ของ CRUD/unique/soft delete/audit บน PostgreSQL และ MySQL
- [ ] frontend tests ของ operator/device persistence และ master form validation
- [ ] keyboard/touch targets ≥ 44×44, contrast ≥ 4.5:1 และไม่ใช้สีอย่างเดียว
- [ ] API executable start ได้กับ DB ทั้งสองชนิด และ master data CRUD ผ่าน UI จริง
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

- [ ] ปิดข้อสรุป scope “ทุกการบันทึก” จาก Phase 0 และเติม idempotency field/header ใน OpenAPI ให้ mutation ที่ต้องเข้า queue
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
- [ ] เพิ่ม multi-stage Dockerfile และคำสั่ง build binary/static artifacts
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
3. Go format/vet/test และ business-rule coverage
4. PostgreSQL integration suite
5. MySQL integration suite เดียวกันในเชิงพฤติกรรม
6. frontend unit test, type-check และ static build
7. critical browser E2E เมื่อมี flow พร้อม

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
- [ ] ไม่มี secret, temporary export หรือ generated junk ถูก commit

## 11. ลำดับ PR/Commit ที่แนะนำสำหรับเริ่มงานทันที

ให้เริ่มจาก slice เล็กและพิสูจน์ architecture ด้วยของจริง:

1. **Runtime DB + code generation** — config, connection, migration mode, sqlc/oapi generation และ CI
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

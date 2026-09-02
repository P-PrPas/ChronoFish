# KUVTH Zebrafish LIMS — Frontend Unit Test Case Design

> เวอร์ชัน: 1.0 · 2 กันยายน 2026 · ประกอบ [`TEST_PLAN.md`](TEST_PLAN.md)
> ระบบที่ทดสอบ: `frontend/src/**` (Vite + React 19 + TypeScript, static SPA)
> Runner: `vitest` + `happy-dom` + `fake-indexeddb` (ติดตั้งไว้แล้วใน `package.json`)

## วิธีอ่านเอกสารนี้

ใช้คอลัมน์ชุดเดียวกับ [`TEST_CASES_BACKEND.md`](TEST_CASES_BACKEND.md)

| St | ความหมาย |
|---|---|
| `✅` | มี test ครอบคลุมอยู่แล้วใน `frontend/tests/` |
| `➕` | มีบางส่วน ต้องเสริม assertion หรือกรณีขอบ |
| `🆕` | ต้องเขียนใหม่ |

หลักการเขียน assertion ของฝั่ง frontend:

- ค้นหา element ด้วย **role / accessible name / ข้อความที่ผู้ใช้เห็น** เท่านั้น ห้ามใช้ CSS selector หรือ `container.querySelector` กับ class ที่เปลี่ยนได้
- ห้าม snapshot ทั้งหน้า — snapshot ที่ยาวจะแดงทุกครั้งที่ปรับ UI แล้วไม่มีใครอ่าน
- ทุก test ที่แตะ network ต้อง stub `globalThis.fetch` และ **ยืนยัน request ที่ส่งออก** (path, method, body, headers) ไม่ใช่แค่ผลที่ render
- ทุก test ที่แตะเวลาให้ฉีดผ่าน argument (`now`) หรือ `vi.setSystemTime()` ห้ามพึ่งนาฬิกาจริง — สัญลักษณ์ `CLOCK`
- รีเซ็ต `localStorage` / `sessionStorage` / IndexedDB / `location.hash` ใน `beforeEach` ทุกไฟล์

---

## 0. WP0 — Harness ที่ต้องมีก่อน

| ID | งาน | รายละเอียด |
|---|---|---|
| FE-HRN-001 | ติดตั้ง `@vitest/coverage-v8` | เป็น devDependency; ปัจจุบัน `npx vitest run --coverage` ล้มด้วย `MISSING DEPENDENCY` จึงยังไม่มี baseline |
| FE-HRN-002 | เพิ่ม `test` block ใน `vite.config.ts` | `environment: "happy-dom"`, `globals: false`, `setupFiles: ["tests/setup.ts"]`, `coverage: { provider: "v8", exclude: ["src/api/schema.d.ts", "src/main.tsx", "src/vite-env.d.ts"], thresholds: { lines: 85, branches: 78 } }` |
| FE-HRN-003 | สร้าง `tests/setup.ts` | ติดตั้ง `fake-indexeddb/auto`, รีเซ็ต storage/hash/queue ก่อนทุก test, ปิด `console.error` ที่มาจาก act-warning ไม่ให้กลบสัญญาณจริง |
| FE-HRN-004 | สร้าง `tests/helpers.ts` | `stubFetch(routes: Record<string, Handler>)` คืน spy ที่ตรวจ request ได้, `renderPage(node)` ห่อ `act`, `resetBrowserState()` |
| FE-HRN-005 | แยก `npm test` ออกจาก `npm run build` | ปัจจุบัน `"test": "npm run build && vitest run"` ทำให้ทุกครั้งที่รัน test ต้อง build ก่อน — ย้าย `build` ไปอยู่ใน `npm run check` เพียงที่เดียว |
| FE-HRN-006 | แก้ act-warning | `workflow-forms.test.tsx` พ่น "not configured to support act(...)" จำนวนมาก — ตั้ง `globalThis.IS_REACT_ACT_ENVIRONMENT = true` ใน setup |

---

## 1. Utilities

### 1.1 `uuidv7.ts`

ไฟล์: `frontend/tests/uuidv7.test.ts`

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| FE-UTL-001 | `encodes the timestamp, version, and RFC variant` | `uuidv7(1_700_000_000_000, fixedBytes)` | 48 บิตแรก = timestamp; nibble version = `7`; variant = `8/9/a/b` | DR-02 | ✅ |
| FE-UTL-002 | `generates unique values when called repeatedly` | 10,000 ครั้ง | ไม่ซ้ำ | DR-02 | ✅ |
| FE-UTL-003 | `falls back to Math.random when crypto is unavailable` | ลบ `globalThis.crypto` | ยังคืน UUID รูปแบบถูกต้อง ไม่ throw | NFR-403 | 🆕 |
| FE-UTL-004 | `clamps a negative or fractional clock to a valid timestamp` | `uuidv7(-1)`, `uuidv7(1.9)` | ไม่ throw, timestamp ไม่ติดลบ | DR-02 | 🆕 |
| FE-UTL-005 | `formats the canonical 8-4-4-4-12 shape` | ค่าใด ๆ | ตรง regex UUID | DR-02 | ➕ |

### 1.2 `time.ts`

ไฟล์: `frontend/tests/time-payload.test.ts`

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| FE-UTL-020 | `submits datetime-local with an explicit +07:00 offset` | `"2026-01-01T08:30"` | `"2026-01-01T08:30:00+07:00"` | CI-04 | ✅ |
| FE-UTL-021 | `passes through a value that already carries an offset` | `"2026-01-01T01:30:00Z"` | แปลงเป็น ISO ผ่าน `Date` โดยไม่เติม `+07:00` ซ้ำ | CI-04 | ➕ |
| FE-UTL-022 | `accepts a seconds-precision datetime-local value` | `"2026-01-01T08:30:45"` | `"2026-01-01T08:30:45+07:00"` | CI-04 | 🆕 |
| FE-UTL-023 | `returns an empty string for empty input` | `""`, `"   "` | `""` (ไม่ throw) | CI-04 | 🆕 |
| FE-UTL-024 | `rejects a malformed datetime-local value` | `"2026-1-1"`, `"abc"` | throw `"Invalid datetime-local value"` | CI-04 | 🆕 |
| FE-UTL-025 | `round-trips persisted RFC3339 timestamps into browser input format` | `"2026-01-01T01:30:00Z"` | `"2026-01-01T08:30"` | CI-04 | ✅ |
| FE-UTL-026 | `round-trip is stable across a DST-free Bangkok boundary` | ค่าที่ข้ามเที่ยงคืนกรุงเทพ | `local → rfc → local` ได้ค่าเดิม | CI-04 | 🆕 |
| FE-UTL-027 | `displays persisted timestamps in Bangkok 24-hour time` | `"2026-01-01T17:05:00Z"` | `"02/01/2026 00:05"` (ไม่มีคอมมา) | CI-04 | ✅ |
| FE-UTL-028 | `formats an empty timestamp as an empty string` | `""` | `""` | CI-04 | 🆕 |

### 1.3 `filters.ts`

ไฟล์: `frontend/tests/filters.test.ts`

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| FE-UTL-040 | `round-trips supported URL filters and ignores unknown values` | query ที่มีคีย์รู้จักและไม่รู้จัก | เก็บเฉพาะ 13 คีย์ที่รองรับ | FR-801 | ✅ |
| FE-UTL-041 | `keeps only filters implemented by analytics endpoints` | filter ครบ 13 คีย์ | `analyticsFilters()` เหลือ 8 คีย์ | FR-801 | ✅ |
| FE-UTL-042 | `trims whitespace and drops empty parameters` | `?siteId=%20%20` | ไม่ถูกเก็บ | FR-801 | ➕ |
| FE-UTL-043 | `filterQuery preserves the declared key order` | filter หลายคีย์ | ลำดับตาม `filterKeys` เสมอ (URL เทียบกันได้ใน test) | FR-801 | 🆕 |
| FE-UTL-044 | `withFilters appends with the correct separator` | path ที่มี/ไม่มี `?` อยู่แล้ว | ได้ `&` หรือ `?` ถูกต้อง; filter ว่าง → path เดิม | FR-801 | ➕ |
| FE-UTL-045 | `updateFilterURL replaces state without touching the hash` | มี `#fish` อยู่ | hash คงอยู่, ไม่มีรายการใหม่ใน history | FR-801 | 🆕 |

### 1.4 `types.ts`

ไฟล์: `frontend/tests/types.test.ts` *(ใหม่)*

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| FE-UTL-060 | `every Thai copy key has an English counterpart` | `Object.keys(text.th)` vs `text.en` | ชุดคีย์เหมือนกันทุกตัว (กัน UI ไทยแสดง `undefined`) | NFR-701 | 🆕 |
| FE-UTL-061 | `no copy value is empty` | ทุกค่าใน `text.th` และ `text.en` | ไม่มี string ว่าง | NFR-701 | 🆕 |
| FE-UTL-062 | `every Page value has a navigation entry` | `Page` union vs `navItems` ใน `App.tsx` | ครบทั้ง 10 หน้า | FR-800 | 🆕 |

---

## 2. API client — `api/client.ts`

ไฟล์: `frontend/tests/api-client.test.ts`

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| FE-API-001 | `persists one UUID v7 device identifier` | เรียก `deviceId()` สองครั้ง | ค่าเดียวกัน และคงอยู่ใน `localStorage` | API-03 | ✅ |
| FE-API-002 | `keeps the selected operator in the browser session and sends both identifiers` | ตั้ง operator ใน sessionStorage | header `X-Operator-Id` + `X-Device-Id` ถูกส่ง | API-03 | ✅ |
| FE-API-003 | `migrates a legacy localStorage operator into the session once` | มีค่าเก่าใน localStorage | ย้ายไป sessionStorage และลบของเดิม; เรียกครั้งถัดไปไม่กลับไปอ่าน localStorage | API-03 | 🆕 |
| FE-API-004 | `rejects every mutation before network access when no operator is selected` | ไม่มี operator | โยน `OPERATOR_REQUIRED` และ `fetch` ไม่ถูกเรียกเลย | API-03 | ✅ |
| FE-API-005 | `sends a fresh idempotency key per mutation` | เรียก `mutationHeaders()` สองครั้ง | key ต่างกัน; ส่ง key ที่กำหนดได้เมื่อระบุ | FR-1002 | ➕ |
| FE-API-006 | `only mutations carry write-context headers` | GET vs POST | GET ไม่มี `X-Operator-Id`; POST มีครบสามตัว | API-03 | 🆕 |
| FE-API-007 | `sets JSON content type only when a body is present` | `request(path)` vs `request(path,{body})` | ตั้ง `Content-Type` เฉพาะกรณีมี body | API-02 | 🆕 |
| FE-API-008 | `caller supplied headers win over defaults` | ส่ง `headers: {"Content-Type":"text/csv"}` | ใช้ค่าที่ส่งมา | FR-208 | 🆕 |
| FE-API-009 | `preserves structured API error details for row-level feedback` | ตอบ 422 พร้อม `error.details.rows` | error ที่โยนมี `.status` และ `.details` ครบ | FR-208 | ✅ |
| FE-API-010 | `falls back to an HTTP status message when the body is not JSON` | ตอบ 500 body ว่าง | ข้อความ `"HTTP 500"` | NFR-502 | 🆕 |
| FE-API-011 | `resolves the base URL from the build-time environment` | ตั้ง/ไม่ตั้ง `VITE_API_BASE_URL` | ใช้ค่าที่ตั้ง หรือ `/api/v1` เป็นค่าเริ่มต้น | NFR-401 | 🆕 |

---

## 3. Offline write queue — `offline.ts`

ไฟล์: `frontend/tests/offline.test.ts`, `frontend/tests/offline-replay.test.ts`

### 3.1 Backoff & identity

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| FE-OFF-001 | `uses bounded exponential backoff` | attempt 0…12 | เพิ่มแบบ 2^n และเพดาน 15 นาที; ต่ำสุด 250 ms | FR-1004 | ✅ |
| FE-OFF-002 | `applies jitter within ±10 percent` | random = 0, 0.5, 1 | ค่าอยู่ในช่วงที่คำนวณได้ ไม่หลุดเพดาน | FR-1004 | ➕ |
| FE-OFF-003 | `calculates the next attempt from a supplied clock` | `nextAttemptAt(2, 1000, () => 0.5)` | ค่าคงที่ตรวจสอบได้ | FR-1004 | ✅ CLOCK |
| FE-OFF-004 | `write identity ignores clientUuid and key order` | body ที่สลับลำดับคีย์และมี `clientUuid` ต่างกัน | identity เท่ากัน | FR-1005 | ➕ |
| FE-OFF-005 | `write identity separates different operators and devices` | operator/device ต่างกัน | identity ต่างกัน (กันปะปนข้ามผู้ใช้เครื่องเดียวกัน) | FR-1005 | 🆕 |
| FE-OFF-006 | `write identity normalizes nested arrays and objects` | body ซ้อนลึก | identity เสถียร | FR-1005 | 🆕 |
| FE-OFF-007 | `replays the original operator, device, and idempotency key` | queued item | `queuedHeaders()` คืนสี่เฮดเดอร์เดิม | FR-1002 | ✅ |
| FE-OFF-008 | `defaults the content type when the record has none` | item ที่ `contentType=""` | ใช้ `application/json` | FR-1002 | 🆕 |

### 3.2 Durability & replay

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| FE-OFF-020 | `persists a write through refresh and replays it exactly once online` | enqueue → รีโหลดโมดูล → drain | `fetch` ถูกเรียกครั้งเดียวด้วย key เดิม | AC-1002 | ✅ |
| FE-OFF-021 | `reuses the pending key for a repeated logical write` | ส่ง logical write เดิมซ้ำ | ไม่มีรายการที่สอง; คืน key เดิม | FR-1005 | ✅ |
| FE-OFF-022 | `dedupes concurrent enqueues of the same write` | เรียก `putQueue` พร้อมกัน 5 ครั้ง | ได้ record เดียว (in-flight map ทำงาน) | FR-1005 | ➕ |
| FE-OFF-023 | `writes the durable record before any network attempt` | ทำให้ `fetch` แขวน | record อยู่ใน IndexedDB แล้วก่อน `fetch` resolve | AC-1002 | ➕ |
| FE-OFF-024 | `acknowledges a 204 mutation without attempting JSON parsing` | ตอบ 204 | ไม่ throw, record ถูกลบ | FR-1002 | ✅ |
| FE-OFF-025 | `ignores a non-JSON or empty success body` | ตอบ 200 `text/plain` / body ว่าง | คืน `{}` ไม่ throw | FR-1002 | ➕ |
| FE-OFF-026 | `keeps 429 responses pending for retry` | ตอบ 429 | ยัง `pending`, `attempt` เพิ่ม, `nextAttempt` เลื่อน | FR-1004 | ✅ |
| FE-OFF-027 | `keeps 5xx and network failures pending` | ตอบ 500 / `fetch` reject | ยัง `pending` | FR-1004 | ➕ |
| FE-OFF-028 | `marks a business rejection instead of retrying it` | ตอบ 422 | `status="rejected"` + `lastError`; ไม่ยิงซ้ำ | FR-1006 | ✅ |
| FE-OFF-029 | `retries an uncertain response with the original idempotency key` | timeout แล้วสำเร็จ | key เดิมทั้งสองครั้ง | AC-1003 | ✅ |
| FE-OFF-030 | `continues draining after one item is rejected` | 3 รายการ ตัวกลางถูกปฏิเสธ | ตัวที่สามยังถูกส่ง | FR-1006 | ✅ |
| FE-OFF-031 | `does not report a save when IndexedDB cannot open` | ทำให้ `indexedDB.open` ล้มเหลว | ไม่แจ้งว่าบันทึกแล้ว; นับคิวเป็น 0 อย่างปลอดภัย | NFR-403 | ✅ |
| FE-OFF-032 | `falls back to a direct request when IndexedDB is absent` | ลบ `window.indexedDB` | ยิง `fetch` ตรงและคืนผลจริง (ไม่ใช่ `{queued:true}`) | NFR-403 | 🆕 |
| FE-OFF-033 | `queues without transmitting while offline` | `navigator.onLine=false` | เก็บลงคิว, `fetch` ไม่ถูกเรียก | FR-1001 | ➕ |
| FE-OFF-034 | `does not discard a rejected write after it has been moved back to pending` | retry แล้วสั่ง discard ด้วย id เดิม | ไม่ถูกลบ (ป้องกัน race) | FR-1006 | ✅ |
| FE-OFF-035 | `retryRejected moves every rejected item back to pending and clears its error` | 2 รายการที่ถูกปฏิเสธ | ทั้งคู่ `pending`, `lastError` ว่าง, ยิง drain | FR-1006 | ➕ |
| FE-OFF-036 | `drainQueue is single-flight` | เรียกซ้อน 3 ครั้ง | ส่ง request ชุดเดียว; promise เดียวกันถูกคืน | FR-1004 | ➕ |
| FE-OFF-037 | `respects nextAttempt unless forced` | item ที่ `nextAttempt` อยู่อนาคต | `drainQueue()` ข้าม; `drainQueue(true)` ส่ง | FR-1004 | 🆕 CLOCK |
| FE-OFF-038 | `emits the full queue event lifecycle` | enqueue → drain → สำเร็จ / ถูกปฏิเสธ / discard | ยิง `queue-enqueued`, `queue-syncing`, `queue-drained`/`queue-rejected`, `queue-discarded`, `queue-sync-idle` ครบตามลำดับ | FR-1007 | ➕ |
| FE-OFF-039 | `counts pending and rejected items separately` | คิวผสม | `queueCount()` / `rejectedQueueCount()` แยกกันถูกต้อง | FR-1007 | 🆕 |
| FE-OFF-040 | `startQueueSync drains on interval and on the online event` | ใช้ fake timers | drain ทุก 5 วินาที และเมื่อ `online`; `cleanup()` หยุดทั้งสองอย่าง | FR-1003 | 🆕 CLOCK |
| FE-OFF-041 | `queued headers survive an operator change in another tab` | เปลี่ยน operator หลัง enqueue | replay ยังใช้ operator เดิมที่บันทึกไว้ | FR-1002 | 🆕 |

---

## 4. Service worker (app shell)

ไฟล์: `frontend/tests/service-worker.test.ts` *(ทดสอบสคริปต์ที่ปลั๊กอิน `hashedShell` สร้าง)*

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| FE-SW-001 | `service worker leaves API requests to the network` | request ไป `/api/...` | ไม่ถูก intercept | FR-1008 | ✅ |
| FE-SW-002 | `service worker prefers the deployed shell for online navigation` | navigate ขณะออนไลน์ | ใช้ network แล้วอัปเดต cache | FR-1008 | ✅ |
| FE-SW-003 | `navigation falls back to the cached shell when offline` | network reject, มี `/` ใน cache | คืน shell ที่ cache ไว้ | FR-1008 | 🆕 |
| FE-SW-004 | `navigation returns 503 when nothing is cached` | network reject, cache ว่าง | Response 503 ไม่ใช่ exception | FR-1008 | 🆕 |
| FE-SW-005 | `non-GET and cross-origin requests are ignored` | POST, request ไป origin อื่น | ไม่ถูก intercept | FR-1008 | 🆕 |
| FE-SW-006 | `activate deletes caches from older shell versions` | cache เก่าค้างอยู่ | ถูกลบ; cache ปัจจุบันคงอยู่ | FR-1008 | 🆕 |
| FE-SW-007 | `install precaches the hashed asset list` | รัน install | `addAll` ได้ `/`, `/manifest.webmanifest` และ asset ทุกตัวจาก `index.html` | FR-1008 | 🆕 |
| FE-SW-008 | `the first registration does not reload the page` | `navigator.serviceWorker.controller` ว่างตอนโหลด แล้วเกิด `controllerchange` | ไม่ `location.reload()` | FR-1008 | 🆕 |
| FE-SW-009 | `a later controller change reloads exactly once` | มี controller อยู่ก่อน แล้ว `controllerchange` สองครั้ง | reload ครั้งเดียว | FR-1008 | 🆕 |

---

## 5. Shared components — `components.tsx`

ไฟล์: `frontend/tests/components.test.tsx` *(ใหม่)*

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| FE-CMP-001 | `translates client sentinel codes instead of showing them raw` | `<ErrorMessage message="OPERATOR_REQUIRED" />` | แสดงข้อความผู้ใช้ ไม่ใช่รหัส | NFR-701 | ✅ |
| FE-CMP-002 | `passes server messages through unchanged` | ข้อความจากเซิร์ฟเวอร์ | แสดงตรงตัว | NFR-701 | ✅ |
| FE-CMP-003 | `error message follows the html lang for its copy` | `<html lang="en">` vs `"th"` | เลือกภาษาตาม `lang` | NFR-701 | ➕ |
| FE-CMP-004 | `error message is announced and focusable` | render | `role="alert"`, `tabIndex=-1` | NFR-702 | 🆕 |
| FE-CMP-005 | `report panel shows a loading status before its content` | `loading` | มี `role="status"` และ `aria-busy="true"`; ไม่ render children | NFR-702 | 🆕 |
| FE-CMP-006 | `report panel localizes its loading copy from the title script` | title ภาษาไทย vs อังกฤษ | ข้อความโหลดตรงภาษา | NFR-701 | 🆕 |
| FE-CMP-007 | `report panel shows the empty message and still renders the quality note` | `empty` + `quality` | แสดงทั้งสองอย่าง | FR-803 | 🆕 |
| FE-CMP-008 | `report table renders a scrollable labelled region` | headers ยาว | `role="region"` มี accessible name และโฟกัสได้ (`tabIndex=0`) | NFR-702 | 🆕 |
| FE-CMP-009 | `report table spans the empty row across every column` | `rows=[]` | หนึ่ง `<td colSpan={headers.length}>` | NFR-702 | 🆕 |
| FE-CMP-010 | `report table localizes the default empty message from Thai headers` | header ภาษาไทย | "ไม่มีข้อมูล" | NFR-701 | 🆕 |
| FE-CMP-011 | `collapsed report table hides its data behind a disclosure` | `collapsed` | มี `<details>` พร้อม summary ที่กำหนด | FR-803 | 🆕 |
| FE-CMP-012 | `empty state renders its optional action only when a handler exists` | มี/ไม่มี `onAction` | ปุ่มปรากฏเฉพาะเมื่อมีทั้ง label และ handler | NFR-702 | 🆕 |
| FE-CMP-013 | `metric renders its label and value` | `<Metric>` | ทั้งสองค่าแสดง | FR-802 | 🆕 |

---

## 6. Application shell — `App.tsx`

ไฟล์: `frontend/tests/browser-workflows.test.tsx`

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| FE-APP-001 | `keeps the lab navigation keyboard reachable and switches language` | Tab ผ่านเมนู แล้วสลับภาษา | ทุกปุ่มโฟกัสได้; ข้อความเปลี่ยนภาษา และ `<html lang>` ตาม | NFR-701, NFR-702 | ✅ |
| FE-APP-002 | `announces route changes and restores focus for history navigation` | navigate → back | `#main-content` ได้โฟกัส; `aria-current="page"` ย้ายตาม | NFR-702 | ✅ |
| FE-APP-003 | `keeps a dropdown selection between its native input and change events` | เลือกใน `<select>` | ค่าไม่ถูกรีเซ็ต | NFR-702 | ✅ |
| FE-APP-004 | `marks invalid required fields and links them to the error summary` | submit ฟอร์มที่ยังไม่ครบ | ทุกช่องผิดได้ `aria-invalid`, `aria-describedby` ชี้ id ใน summary; summary ได้โฟกัส | NFR-702 | ✅ |
| FE-APP-005 | `clears a field error as soon as the value becomes valid` | แก้ค่าให้ถูก | `aria-invalid` และรายการใน summary หายไป | NFR-702 | ➕ |
| FE-APP-006 | `generates unique ids for unlabeled invalid controls` | สองช่องที่ไม่มี `id` | ได้ `invalid-<page>-1`, `-2` ไม่ชนกัน | NFR-702 | 🆕 |
| FE-APP-007 | `keeps rejected writes visible until the user reviews or discards them` | มี write ที่ถูกปฏิเสธ | แสดงรายการ + จำนวน; ปุ่ม discard ถามยืนยันก่อน | FR-1006 | ✅ |
| FE-APP-008 | `navigates to the page that owns a rejected write` | คลิก "เปิดหน้าที่เกี่ยวข้อง" ของ path แต่ละกลุ่ม | ไปหน้า due/batches/fish/timing/promotions/controls/master ตาม `pageForWrite()` ครบทุกกรณี | FR-1006 | ➕ |
| FE-APP-009 | `shows saved, syncing and pending counts from queue events` | ยิง event คิวแต่ละแบบ | ข้อความสถานะเปลี่ยนเป็น `บันทึกแล้ว` / `กำลังส่ง…` / `ค้าง N รายการ` | FR-1007 | ➕ |
| FE-APP-010 | `warns before closing the tab while writes are outstanding` | คิวไม่ว่าง แล้วยิง `beforeunload` | `preventDefault()` ถูกเรียก; คิวว่าง → ไม่เตือน | FR-1007 | ➕ |
| FE-APP-011 | `reflects the browser online and offline state` | ยิง event `offline`/`online` | ตัวบ่งชี้เปลี่ยนและ `aria-live="polite"` | FR-1003 | ➕ |
| FE-APP-012 | `blocks write pages until an operator is selected` | ไม่มี operator, ไปหน้า `due` | `operator-gate` ปรากฏ (`role="alert"`) และ fieldset ถูก `disabled` | API-03 | ➕ |
| FE-APP-013 | `read-only pages stay usable without an operator` | ไปหน้า `dashboard`/`audit`/`export` | ไม่มี gate, fieldset ใช้งานได้ | API-03 | 🆕 |
| FE-APP-014 | `selecting an operator stores it in the session` | เลือกใน dropdown | `sessionStorage["chronofish.operator_id"]` ถูกตั้ง | API-03 | ➕ |
| FE-APP-015 | `restores the page from the location hash on load` | โหลดด้วย `#fish` | เปิดหน้า fish; hash ที่ไม่รู้จัก → dashboard | FR-800 | ➕ |
| FE-APP-016 | `hashchange and popstate both follow navigation` | ยิงทั้งสอง event | เปลี่ยนหน้าเฉพาะเมื่อ hash เป็นหน้าที่รู้จัก | FR-800 | 🆕 |
| FE-APP-017 | `sets the document title from the current page` | เปลี่ยนหน้า | `document.title` = `"<หน้า> · KUVTH Zebrafish LIMS"` | NFR-701 | 🆕 |
| FE-APP-018 | `persists the language choice across reloads` | สลับภาษาแล้ว render ใหม่ | อ่านจาก `localStorage` ได้ค่าเดิม | NFR-701 | 🆕 |
| FE-APP-019 | `an operator list failure does not break the shell` | `GET /operators` ตอบ 500 | ยัง render ได้ ไม่มี unhandled rejection | NFR-403 | 🆕 |
| FE-APP-020 | `the skip link reaches the main content` | โฟกัสลิงก์แรกแล้ว activate | ไปที่ `#main-content` | NFR-702 | 🆕 |

---

## 7. หน้า Due Now & checkpoint — `pages/due.tsx`

ไฟล์: `frontend/tests/due-workflow.test.tsx`, `frontend/tests/checkpoint-preview.test.ts`

### 7.1 ฟังก์ชันบริสุทธิ์

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| FE-DUE-001 | `shows only the next checkpoint for each injection lot` | หลาย checkpoint ของ lot เดียว | `nextCheckpoints()` คืนหนึ่งรายการต่อ lot คือตัวที่ช้าที่สุด | BR-07 | ✅ |
| FE-DUE-002 | `counts how many stages are still pending per lot` | 3 stage ที่เลย due | `pendingStages=3` | BR-07 | ➕ |
| FE-DUE-003 | `sorts lots by lateness` | หลาย lot | เรียงมาก→น้อย | BR-07 | ➕ |
| FE-DUE-004 | `treats a missing minutesLate as zero` | รายการที่ไม่มีค่า | ไม่ NaN, ไม่หลุดลำดับ | BR-07 | 🆕 |
| FE-DUE-010 | `renders the exact BR-23 label at the boundary` | deviation < 1 นาที | `"ตรงกับสากล"` | BR-23 | ✅ |
| FE-DUE-011 | `formats timing previews as H:MM with the BR-23 hours/minutes form` | 1.5 ชม. | `"ช้ากว่าสากล 1 ชม. 30 นาที"` | BR-23 | ✅ |
| FE-DUE-012 | `formats a sub-hour deviation without the hours part` | −0.5 | `"เร็วกว่าสากล 30 นาที"` | BR-23 | ➕ |
| FE-DUE-013 | `uses editable observedAt while keeping live T+ separate` | `checkpointTiming()` | `observedMinutes` มาจากค่าที่กรอก; `liveMinutes` มาจากนาฬิกา | FR-408 | ✅ CLOCK |
| FE-DUE-014 | `returns null metrics for an unparseable observed time` | `observedAt="abc"` | `actual`/`deviation`/`observedMinutes` เป็น `null` ไม่ throw | FR-408 | ➕ |
| FE-DUE-015 | `clamps negative elapsed time to zero` | `observedAt` ก่อน `activatedAt` | `observedMinutes=0` | BR-01 | 🆕 |
| FE-DUE-016 | `live minutes stay available even when the input is invalid` | input เสีย แต่ `activatedAt` ใช้ได้ | `liveMinutes` ยังคำนวณได้ | FR-408 | 🆕 |

### 7.2 หน้าจอคิวงาน (SCR-01)

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| FE-DUE-030 | `shows overdue/upcoming time and filters the due queue by site and operator` | ตอบ due-checkpoints พร้อม filter | ส่ง query ถูกต้อง และแสดงเวลาที่อ่านได้ | FR-401 | ✅ |
| FE-DUE-031 | `renders an empty state when nothing is due` | `overdue=[]`, `upcoming=[]` | แสดง empty state ไม่ใช่ตารางว่าง | FR-401 | 🆕 |
| FE-DUE-032 | `surfaces a load failure with a retry` | ตอบ 500 | `ErrorMessage` + ปุ่มลองใหม่ยิง request ซ้ำ | NFR-403 | 🆕 |
| FE-DUE-033 | `refreshes the queue on the 60 second interval` | fake timers | ยิง request รอบใหม่หลัง 60 วินาที และหยุดเมื่อ unmount | FR-401 | 🆕 CLOCK |
| FE-DUE-034 | `shows the pending promotion count as an entry point` | `pendingPromotionCount=4` | ตัวเลขปรากฏและลิงก์ไปหน้า promotions | FR-501 | 🆕 |

### 7.3 หน้าบันทึก checkpoint (SCR-02)

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| FE-DUE-050 | `renders a compact plate map with one selected-well editor` | 96-well | แผนผังแสดง, เลือกได้ทีละหลุม | FR-409 | ✅ |
| FE-DUE-051 | `opens the first physical well when the checkpoint API order is unsorted` | API คืนลำดับสลับ | เปิด well ที่ตำแหน่งกายภาพแรก (A1 ก่อน B1) | FR-409 | ✅ |
| FE-DUE-052 | `falls back to a list layout on a narrow viewport` | ความกว้าง 375 px | ใช้รายการแทนแผนผัง | FR-409 | ➕ |
| FE-DUE-053 | `applies one stage to a same-stage round before confirming all embryos` | เลือก stage เดียวสำหรับทั้งรอบ | ทุกตัวได้ stage นั้นก่อนกดยืนยัน | FR-410 | ✅ |
| FE-DUE-054 | `records only selected embryos with independent stages and timestamps the confirmation` | เลือกบางตัว, stage ต่างกัน | payload มีเฉพาะที่เลือก พร้อม stage/เวลาของแต่ละตัว | FR-404, FR-410 | ✅ |
| FE-DUE-055 | `counts an abnormal default as unreviewed until its stage is selected while keeping it in exceptions` | ตัวที่ default ABNORMAL | ยังนับเป็นยังไม่ตรวจ และอยู่ในรายการข้อยกเว้น | FR-403 | ✅ |
| FE-DUE-056 | `all-alive records every remaining embryo in one request` | กด "รอดทั้งหมด" | หนึ่ง request ครอบคลุมตัวที่เหลือทั้งหมด | FR-411 | ➕ |
| FE-DUE-057 | `remaining-dead marks only the embryos not yet recorded` | กด "ที่เหลือตาย" | ไม่ทับตัวที่บันทึกไปแล้ว | FR-411 | ➕ |
| FE-DUE-058 | `exception cycling walks alive → dead → abnormal` | คลิกซ้ำที่หลุมเดียว | สถานะวนตามลำดับที่ออกแบบไว้ | FR-410 | ➕ |
| FE-DUE-059 | `keeps the checkpoint open and reports every rejected save row` | ตอบ partial rejection | แสดงเหตุผลรายแถวและเปิดให้ลองใหม่ | FR-406 | ✅ |
| FE-DUE-060 | `captures confirm time and supports confirmed correction and ten-second undo` | ยืนยันแล้วกด undo ภายใน 10 วินาที | ยิงการแก้ไข/ยกเลิกถูกต้อง; เลย 10 วินาทีแล้วปุ่มหาย | FR-1101 | ✅ CLOCK |
| FE-DUE-061 | `every embryo carries a fresh clientUuid` | บันทึก 5 ตัว | 5 `clientUuid` ไม่ซ้ำและเป็น UUID | BR-18 | 🆕 |
| FE-DUE-062 | `a dead embryo is shown as closed and cannot be re-recorded` | ตัวที่ `isDead` | ไม่อยู่ในชุดที่ส่ง และมีป้ายบอกสถานะ | BR-19 | ➕ |
| FE-DUE-063 | `the plate grid is keyboard navigable with visible labels` | Tab/ลูกศรบนแผนผัง | ทุกหลุมมี accessible name เป็นรหัสตัวอ่อน + ตำแหน่ง | NFR-702 | ➕ |
| FE-DUE-064 | `backdated entry keeps the live T+ readout distinct from the entered time` | กรอกเวลาย้อนหลัง | ทั้งสองค่าแสดงแยกกัน ไม่ปนกัน | BR-22 | ➕ |

---

## 8. หน้า Batch — `pages/batches.tsx` (SCR-04/05/06/11)

ไฟล์: `frontend/tests/workflow-forms.test.tsx` + `frontend/tests/batches.test.tsx` *(แยกไฟล์ใหม่)*

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| FE-BAT-001 | `exposes required batch fields and foreign-key selectors` | เปิดฟอร์มสร้าง | ทุกช่องบังคับมี `required` และ label ที่อ่านได้ | FR-302 | ✅ |
| FE-BAT-002 | `edits the complete mutable batch record through the shared batch form` | แก้ batch | ส่ง PATCH ครบทุกฟิลด์ที่แก้ได้ | FR-306 | ✅ |
| FE-BAT-003 | `never renders internal master IDs while batch names are loading` | master ยังโหลดไม่เสร็จ | ไม่แสดง UUID บนหน้าจอ | NFR-701 | ✅ |
| FE-BAT-004 | `resolves inactive master data in historical batch details without offering it for new records` | master ที่ปิดใช้งาน | รายละเอียดเก่าแสดงชื่อได้; dropdown สร้างใหม่ไม่มีตัวเลือกนั้น | FR-111 | ✅ |
| FE-BAT-005 | `shows a 96-well planner, mobile fallback, and confirms before creating a lot` | สร้าง lot | ยืนยันก่อนสร้าง; แผนผัง/รายการตามความกว้างจอ | FR-310 | ✅ |
| FE-BAT-006 | `offers activation for copied injection-lot drafts` | lot ที่ยังไม่ activate | ปุ่ม activate ปรากฏ และส่ง PATCH ที่ถูกต้อง | FR-309 | ✅ |
| FE-BAT-007 | `previews the embryo codes before the lot is created` | กรอก `lotNo` + จำนวน | preview `{batchCode}_{lotNo}_{n}` ตรงกับที่ backend จะสร้าง | FR-308 | ➕ |
| FE-BAT-008 | `blocks duplicate well selection in the planner` | เลือก well เดิมสองครั้ง | ไม่ส่งค่าซ้ำ และแจ้งผู้ใช้ | FR-310 | 🆕 |
| FE-BAT-009 | `duplicates a batch with the copy-lots choice` | กด duplicate | ส่ง `POST /batches/{id}/duplicate` พร้อม `experimentDate`, `dayNo`, `copyInjectionLots` ตามที่เลือก | FR-309 | 🆕 |
| FE-BAT-010 | `surfaces a batch code conflict from the server` | ตอบ 409 | แสดงข้อความ conflict และคงข้อมูลในฟอร์มไว้ | FR-303 | 🆕 |
| FE-BAT-011 | `shows an ENU warning returned with a created lot` | response มี `warnings` | ข้อความเตือนปรากฏ แต่ lot ยังถูกสร้าง | FR-307 | 🆕 |
| FE-BAT-012 | `moves an embryo to a free well and reports a conflict` | PATCH สำเร็จ / ตอบ 409 | อัปเดตแผนผัง / แสดง conflict โดยไม่ย้ายจริง | FR-310 | 🆕 |
| FE-BAT-013 | `confirms before soft-deleting an embryo` | กดลบ | มีการยืนยัน แล้วจึงยิง DELETE | BR-17 | 🆕 |
| FE-BAT-014 | `adds embryos to an activated lot` | กดเพิ่มตัวอ่อน | ส่ง `POST /injection-lots/{id}/embryos` พร้อม `count` | FR-308 | 🆕 |
| FE-BAT-015 | `filters the batch list by date, site, operator and treatment group` | ตั้ง filter | query string ตรงกับที่เลือก | FR-305 | ➕ |
| FE-BAT-016 | `paginates the batch list with the server cursor` | มี `nextCursor` | ปุ่มโหลดเพิ่มส่ง cursor ที่ได้รับ | FR-305 | 🆕 |
| FE-BAT-017 | `loads existing control rows and shows their totals` | เปิดหน้า control (SCR-11) | แสดง normal/abnormal/รวม ถูกต้อง | FR-702 | ✅ |
| FE-BAT-018 | `rejects duplicate or negative control rows before sending` | กรอกซ้ำ / ค่าติดลบ | บล็อกก่อน submit พร้อมข้อความ | FR-701 | ➕ |
| FE-BAT-019 | `sends the full control set as one PUT` | บันทึก | หนึ่ง request ที่มี `items` ครบชุด | FR-701 | ➕ |

---

## 9. หน้า Fish — `pages/fish.tsx` (SCR-08/09/10)

ไฟล์: `frontend/tests/fish.test.tsx` *(แยกจาก `workflow-forms.test.tsx`)*

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| FE-FSH-001 | `exposes Bangkok roll-call outcomes and registry filters` | เปิดหน้า | ตัวเลือก outcome ครบ 5 ค่า; filter ทำงาน | FR-602, FR-607 | ✅ |
| FE-FSH-002 | `sends the daily roll-call draft in one request` | เลือกผลหลายตัวแล้วบันทึก | หนึ่ง `POST /observations/fish` ที่มีทุกแถว | FR-608 | ✅ |
| FE-FSH-003 | `one-tap all-alive submits every unrecorded fish` | กด "รอดทั้งหมด" | หนึ่ง request ครอบคลุมตัวที่ยังไม่บันทึก | FR-608 | ➕ |
| FE-FSH-004 | `corrects an already-recorded roll-call outcome through the audit endpoint` | แก้ผลที่บันทึกแล้ว | ยิง `PATCH /observations/fish/{id}` พร้อม `correctionReason` | FR-1101 | ✅ |
| FE-FSH-005 | `sends a backdated roll-call range with an audit reason in one request` | เลือกช่วงวัน + เหตุผล | หนึ่ง request ที่มีทุกวันในช่วง พร้อม `overrideReason` | FR-609 | ✅ |
| FE-FSH-006 | `requires a reason before a backdated submission` | ช่วงย้อนหลังโดยไม่กรอกเหตุผล | บล็อกก่อนส่ง | FR-609 | ➕ |
| FE-FSH-007 | `rejects a roll-call date in the future` | เลือกวันพรุ่งนี้ | บล็อกก่อนส่ง | BR-15 | 🆕 CLOCK |
| FE-FSH-008 | `confirms selected pending promotions in one bulk request` | เลือกหลายตัวแล้วยืนยัน | หนึ่ง `POST /promotions` พร้อม `clientUuid` ต่อรายการ | FR-502 | ✅ |
| FE-FSH-009 | `shows suggested fish codes and running numbers before promoting` | รายการรอเลื่อนขั้น | แสดง `suggestedFishCode` / `suggestedRunningNo` และแก้ไขได้ | BR-11 | ➕ |
| FE-FSH-010 | `reports per-row promotion rejections without losing the rest` | response ผสม created/rejected | แสดงเหตุผลรายแถว; ตัวที่สำเร็จหายไปจากรายการรอ | FR-502 | ➕ |
| FE-FSH-011 | `collects an audit reason when manually registering an older fish` | สร้างปลาย้อนหลัง | ช่องเหตุผลบังคับ และถูกส่ง | FR-606 | ✅ |
| FE-FSH-012 | `manual fish form blocks a future date of birth` | เลือก dob พรุ่งนี้ | บล็อกก่อนส่ง | FR-606 | 🆕 CLOCK |
| FE-FSH-013 | `fish detail shows observations, specimens and the embryo timeline` | เปิดรายละเอียด | ทั้งสามส่วนแสดงครบ เรียงตามเวลา | FR-604 | ➕ |
| FE-FSH-014 | `fish detail edits only the mutable fields` | แก้ `sex`/`fishBoxId`/`remarks`/`finClipped` | PATCH มีเฉพาะฟิลด์ที่แก้ | FR-605 | ➕ |
| FE-FSH-015 | `specimen form validates dates before sending` | frozen < collected, วันอนาคต | บล็อกก่อนส่ง | BR-16 | 🆕 |
| FE-FSH-016 | `specimen form requires frozen date when storage is chosen` | เลือก `-80` โดยไม่มี `frozenOn` | บล็อกก่อนส่ง | BR-16 | 🆕 |
| FE-FSH-017 | `mark-fin-clipped is sent with the specimen` | ติ๊ก markFinClipped | payload มีค่านั้นและสถานะปลาอัปเดตหลังตอบกลับ | BR-16 | ➕ |
| FE-FSH-018 | `registry layout stays usable at 375 px` | viewport 375 | ไม่มี horizontal scroll ในเนื้อหาหลัก | NFR-703 | ✅ |
| FE-FSH-019 | `registry paginates with the server cursor` | มี `nextCursor` | โหลดเพิ่มส่ง cursor ที่ได้รับ | FR-602 | 🆕 |
| FE-FSH-020 | `abnormal fish are visibly marked beyond colour alone` | ปลา ABNORMAL | มีข้อความ/ไอคอนกำกับ ไม่พึ่งสีอย่างเดียว | NFR-702 | ➕ |

---

## 10. หน้า Master data — `pages/master.tsx` (SCR-12/13)

ไฟล์: `frontend/tests/master-form.test.tsx`

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| FE-MST-001 | `blocks an empty required master field before submission` | submit ว่าง | native validation กันไว้; ไม่มี request | FR-102 | ✅ |
| FE-MST-002 | `recovers from master loading and queued-write failures` | GET ล้ม / write ถูกปฏิเสธ | แสดง error พร้อม retry; โหลด state จากเซิร์ฟเวอร์ใหม่หลังถูกปฏิเสธ | NFR-403 | ✅ |
| FE-MST-003 | `renders every configured resource with its own fields` | *(parametrize 6 resource ใน `masterConfig` + sites)* | ช่องกรอกตรงตามที่กำหนดต่อ resource | FR-101 | 🆕 |
| FE-MST-004 | `enum fields render as selects with only allowed values` | `preparation`, `armType` | ตัวเลือกตรงกับ backend enum เป๊ะ | FR-105, FR-106 | 🆕 |
| FE-MST-005 | `creates a record through the offline queue` | submit ที่ถูกต้อง | `putQueue` ถูกเรียกด้วย path/method/body ที่ถูก | FR-1001 | ➕ |
| FE-MST-006 | `edits an existing record with PATCH` | เลือกแก้ไข | ส่ง PATCH ไป `/{resource}/{id}` | FR-101 | ➕ |
| FE-MST-007 | `deactivates a record and reloads the list` | กดปิดใช้งาน | ส่ง `{"active": false}` แล้ว refresh | FR-111 | ➕ |
| FE-MST-008 | `shows a duplicate conflict as an alert and restores server state` | ตอบ 409 | แสดง alert; รายการกลับมาตรงกับเซิร์ฟเวอร์ | FR-103 | ✅ |
| FE-MST-009 | `renders an empty state for a resource with no records` | list ว่าง | `Empty` พร้อมปุ่มเพิ่มรายการ | NFR-702 | 🆕 |
| FE-MST-010 | `labels every field in both languages` | สลับภาษา | ใช้ `thaiField`/`thaiResource` ครบทุกคีย์ ไม่มี `undefined` | NFR-701 | 🆕 |
| FE-MST-011 | `the site selector for fish boxes lists only active sites` | มี site ที่ปิดใช้งาน | ไม่อยู่ในตัวเลือก | FR-111 | 🆕 |

---

## 11. หน้า Timing / Promotions / Controls — `pages/settings.tsx` (SCR-15)

ไฟล์: `frontend/tests/timing.test.tsx` *(แยกจาก `workflow-forms.test.tsx`)*

### 11.1 Timing profile

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| FE-SET-001 | `shows timing version history, old/new values, and confirms a new version` | เปิดหน้า | แสดง version/ผู้แก้/เวลา/ค่าที่เปลี่ยน; ยืนยันก่อนสร้าง | FR-206 | ✅ |
| FE-SET-002 | `localizes timing input names for Thai screen readers` | ภาษาไทย | ทุก input มี accessible name ภาษาไทย | NFR-702 | ✅ |
| FE-SET-003 | `summarizes the first three changed stages and counts the rest` | version ที่เปลี่ยน 5 stage | แสดง 3 รายการ + `+2 ระยะ` | FR-206 | ➕ |
| FE-SET-004 | `reports an initial profile without a previous version` | version 1 | `"ค่าเริ่มต้น · 36 ระยะ"` | FR-206 | 🆕 |
| FE-SET-005 | `reports when a new version changed no timing values` | entries เหมือนเดิมทุกตัว | `"ไม่มีค่าเวลาเปลี่ยนแปลง"` | FR-206 | 🆕 |
| FE-SET-006 | `sends only the overridden stages` | แก้ 2 stage | payload `entries` มี 2 รายการ ไม่ใช่ 36 | FR-205 | ➕ |
| FE-SET-007 | `blocks a negative or non-numeric expected hour before sending` | กรอก −1 / ตัวอักษร | บล็อกก่อน submit | FR-205 | ➕ |

### 11.2 CSV preview & import

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| FE-SET-020 | `previews timing CSV rows before importing them` | เลือกไฟล์ที่ถูกต้อง | แสดงตาราง preview พร้อมปุ่ม import | FR-208 | ✅ |
| FE-SET-021 | `rejects a mismatched header at row one` | header ผิด | ข้อความ `Row 1: expected header ...` และปิดปุ่ม import | FR-208 | ➕ |
| FE-SET-022 | `flags a stage code that does not match its order` | order/code ไม่ตรง | error รายแถว | FR-208 | ➕ |
| FE-SET-023 | `flags duplicate stage rows` | stage ซ้ำ | error `duplicate stage` | FR-208 | 🆕 |
| FE-SET-024 | `flags a row that does not have exactly four columns` | 3 หรือ 5 คอลัมน์ | error `must contain exactly 4 columns` | FR-208 | 🆕 |
| FE-SET-025 | `flags a negative, empty or non-numeric expected hour` | `-1`, `""`, `abc` | error ทั้งสามกรณี | FR-208 | ➕ |
| FE-SET-026 | `reports an unclosed quoted value on its own row` | `"abc` | error `unclosed quoted value` เฉพาะแถวนั้น แถวอื่นยัง preview ได้ | FR-208 | 🆕 |
| FE-SET-027 | `parses escaped double quotes inside a quoted cell` | `"a""b"` | ค่าเป็น `a"b` | FR-208 | 🆕 |
| FE-SET-028 | `strips a UTF-8 BOM before parsing the header` | ไฟล์จาก Excel | header ผ่าน | FR-208 | ➕ |
| FE-SET-029 | `skips blank lines and reports a file with no data rows` | header อย่างเดียว / มีบรรทัดว่างคั่น | `Row 2: CSV must contain at least one data row`; บรรทัดว่างถูกข้าม | FR-208 | ➕ |
| FE-SET-030 | `disables import while any row has an error` | preview ที่มี error | ปุ่ม import ถูก disable | FR-208 | ✅ |
| FE-SET-031 | `renders server row errors returned by the import` | ตอบ 422 พร้อม `details.rows` | แสดง `Row N: message` ทุกแถว (`apiError()`) | FR-208 | ➕ |
| FE-SET-032 | `falls back to the plain message when the server sends no rows` | 422 ไม่มี `details` | แสดงข้อความหลัก | FR-208 | 🆕 |

### 11.3 Promotions & controls

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| FE-SET-050 | `promotions page lists candidates with age and abnormality context` | รายการรอเลื่อนขั้น | แสดง `ageDays`, `firstAbnormalStageLabel` | FR-501 | ➕ |
| FE-SET-051 | `promotions page supports select-all and per-row exclusion` | เลือก/ยกเลิก | payload ตรงกับที่เลือกจริง | FR-502 | 🆕 |
| FE-SET-052 | `promotions page shows an empty state when nothing is eligible` | list ว่าง | `Empty` แทนตารางว่าง | NFR-702 | 🆕 |
| FE-SET-053 | `promotions page assigns an optional fish box per row` | เลือก box | payload มี `fishBoxId` เฉพาะแถวที่เลือก | BR-14 | 🆕 |
| FE-SET-054 | `controls page keeps a stage/arm matrix consistent with the server response` | โหลด/บันทึก | ตารางสะท้อน `items` ที่ตอบกลับ | FR-702 | ➕ |

---

## 12. หน้า Dashboard — `pages/dashboard.tsx` (SCR-14/16)

ไฟล์: `frontend/tests/dashboard.test.tsx` + `frontend/tests/dashboard-helpers.test.ts` *(ใหม่)*

### 12.1 ฟังก์ชันบริสุทธิ์

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| FE-DSH-001 | `falls back to Stage 1 for an invalid URL tab` | `?tab=zzz` | `"stage1"` | FR-801 | ✅ |
| FE-DSH-002 | `parses the stage comparison parameters with safe fallbacks` | `?stage1Compare=xxx`, `?stage2Compare=xxx` | `"strain"` / `"overall"` | FR-804 | ➕ |
| FE-DSH-003 | `dashboardDataPath always groups stage 1 by site plus the comparison` | comparison แต่ละค่า | มี `stage1GroupBy=site` และ `stage1GroupBy=<comparison>` เสมอ | FR-804 | ➕ |
| FE-DSH-004 | `dashboardDataPath omits stage2GroupBy for the overall comparison` | `stage2Comparison="overall"` | ไม่มีพารามิเตอร์นั้น | FR-804 | 🆕 |
| FE-DSH-005 | `dashboardDataPath maps abnormalityGroup to the condition dimension` | `"abnormalityGroup"` | `stage2GroupBy=condition` | FR-804 | 🆕 |
| FE-DSH-006 | `percent formats two decimals and reports unknown for null` | `0.1234`, `null`, `undefined` | `"12.34%"`, `"Unknown"` | FR-803 | ➕ |
| FE-DSH-007 | `formatDeviationHours signs, splits hours and minutes, and localizes` | `+1.5`, `−0.5`, `0`, `null`, `NaN` | `"+1 hr 30 min"` / `"−30 min"` / `"0 min"` / `"Unknown"`; ภาษาไทยใช้ `ชม./นาที` และ `"ไม่ทราบ"` | BR-23 | 🆕 |
| FE-DSH-008 | `stepPath produces a monotone step line` | จุดหลายจุด | path มีส่วน H และ V สลับกัน ไม่มี NaN | FR-805 | 🆕 |
| FE-DSH-009 | `chartEndLabelPositions separates coincident labels into distinct lanes` | สองซีรีส์จบที่ค่าเดียวกัน | ตำแหน่ง label ไม่ทับกัน | NFR-702 | ✅ |
| FE-DSH-010 | `sampleChartPoints thins dense series without dropping the endpoints` | 200 จุด | จุดแรก/สุดท้ายยังอยู่ | NFR-101 | 🆕 |
| FE-DSH-011 | `ciBandPath returns an empty path when confidence bounds are missing` | จุดที่ไม่มี CI | คืน `""` ไม่ใช่ path ที่มี NaN | FR-813 | 🆕 |
| FE-DSH-012 | `smallSeriesMessage warns only when a series is under-powered` | n = 3 vs n = 30 | เตือนเฉพาะซีรีส์ที่เล็ก | FR-803 | ➕ |

### 12.2 พฤติกรรมหน้าจอ

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| FE-DSH-030 | `requests one consistent dashboard snapshot with URL filters and exposes data quality` | โหลดหน้า | หนึ่ง request ไป `/analytics/dashboard`; แสดง `meta` เป็นหมายเหตุคุณภาพ | FR-801, FR-803 | ✅ |
| FE-DSH-031 | `guards headline candidates by their own risk set even when total n is five` | dataset ขอบ | ไม่โชว์ตัวเลขนำที่ไม่มีน้ำหนักทางสถิติ | FR-803 | ✅ |
| FE-DSH-032 | `uses high-contrast fish series with non-color line patterns` | หลายซีรีส์ | เส้นต่างกันด้วย dash ไม่ใช่สีอย่างเดียว | NFR-702 | ✅ |
| FE-DSH-033 | `renders step paths, accessible checkpoint points, KM uncertainty and censor/event marks` | dataset ปกติ | จุดมี accessible name; แสดง censor/event | FR-805, FR-813 | ✅ |
| FE-DSH-034 | `uses a taller, wider mobile chart geometry with fewer axis ticks` | viewport แคบ | geometry เปลี่ยนตามที่ออกแบบ | NFR-703 | ✅ |
| FE-DSH-035 | `uses readable selected dimensions in visible chart summaries` | เปลี่ยน comparison | สรุปใช้ชื่อที่อ่านได้ ไม่ใช่ id | NFR-701 | ✅ |
| FE-DSH-036 | `shows Thai pipeline labels and percentages without relying on the bar fill` | ภาษาไทย | ตัวเลขและป้ายอ่านได้โดยไม่ต้องดูแท่ง | NFR-702 | ✅ |
| FE-DSH-037 | `renders supporting composition, bins, box census, Day 5 guards and timing summaries` | dataset ครบ | ทุกแผงแสดงถูกต้อง | FR-814 | ✅ |
| FE-DSH-038 | `keeps filters when drilling down to another page` | คลิก drill-down | navigate พร้อม query filter เดิม | FR-801 | ➕ |
| FE-DSH-039 | `switching tabs pushes history and restores on back` | สลับแท็บแล้วกด back | แท็บกลับค่าเดิม | FR-801 | ➕ |
| FE-DSH-040 | `shows a loading state before the snapshot arrives` | request ค้าง | `aria-busy` + ข้อความโหลด | NFR-702 | 🆕 |
| FE-DSH-041 | `shows an error with retry when the snapshot fails` | ตอบ 500 | `ErrorMessage` + ปุ่มลองใหม่ | NFR-403 | 🆕 |
| FE-DSH-042 | `renders an explicit no-data panel instead of an empty chart` | dataset ว่าง | ข้อความ "ยังไม่มีข้อมูล" ไม่ใช่กราฟเปล่า | FR-803 | ➕ |
| FE-DSH-043 | `the scope bar summarizes active filters and clears them` | มี filter | สรุปเป็นชื่อที่อ่านได้; ปุ่มล้างรีเซ็ต URL ด้วย | FR-801 | ➕ |
| FE-DSH-044 | `every chart has a table equivalent for screen readers` | ทุกแผง | มี `ReportTable` คู่กัน (collapsed ได้) | NFR-702 | ➕ |

---

## 13. หน้า Export — `pages/export.tsx` (SCR-17)

ไฟล์: `frontend/tests/export.test.tsx`

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| FE-EXP-001 | `loads the printable report from one filtered dashboard snapshot` | เปิดหน้า | หนึ่ง request; ทุกแผงมาจาก snapshot เดียว | FR-908 | ✅ |
| FE-EXP-002 | `downloads Excel with the active analytics filters` | กดดาวน์โหลด Excel | `POST /exports/excel` body `{locale:"th", filters}` ที่ตรงกับ filter บนหน้าจอ | FR-902 | ➕ |
| FE-EXP-003 | `downloads the R table with filters in the query string` | กดดาวน์โหลด CSV | `GET /exports/r-table?<filters>` | FR-907 | ➕ |
| FE-EXP-004 | `shows a progress status while a download is running` | request ค้าง | ข้อความ `role="status"`, ปุ่ม `aria-busy` + disabled | NFR-702 | ➕ |
| FE-EXP-005 | `reports a download failure without leaving the button disabled` | ตอบ 500 | แสดง `ErrorMessage`; ปุ่มกลับมาใช้งานได้ | NFR-403 | 🆕 |
| FE-EXP-006 | `revokes the object URL after a successful download` | ดาวน์โหลดสำเร็จ | `URL.revokeObjectURL` ถูกเรียก และ `<a>` ชั่วคราวถูกลบออกจาก DOM | NFR-403 | 🆕 |
| FE-EXP-007 | `print is disabled until the report is ready` | ก่อน/หลังโหลดเสร็จ | ปุ่มพิมพ์ถูก disable แล้วเปิดใช้; ข้อความอธิบายเปลี่ยนตาม | FR-908 | ➕ |
| FE-EXP-008 | `preview toggles the report panel` | กดปุ่มดูตัวอย่าง | สลับสถานะเปิด/ปิด และข้อความปุ่มเปลี่ยน | FR-908 | 🆕 |
| FE-EXP-009 | `filter changes update the URL and the report together` | เปลี่ยน filter | `updateFilterURL` ถูกเรียก และ report โหลดใหม่ | FR-801 | ➕ |
| FE-EXP-010 | `restores filters from history navigation` | กด back | filter กลับค่าก่อนหน้าและ report ตาม | FR-801 | 🆕 |
| FE-EXP-011 | `summarizes the filter context on the printable report` | มี filter | `filterSummary()` แสดง `key=value` คั่นด้วย `·`; ไม่มี filter → `"All records"` | FR-904 | ➕ |

---

## 14. หน้า Audit — `pages/audit.tsx` (SCR-18)

ไฟล์: `frontend/tests/audit.test.tsx`

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| FE-AUD-001 | `loads change context and only applies filters on submit` | พิมพ์ filter แล้วยังไม่ submit | ไม่มี request จนกว่าจะ submit | FR-1103 | ✅ |
| FE-AUD-002 | `shows operator, device, timestamp and before/after values` | รายการ audit | ทุกคอลัมน์แสดง; ค่าเป็น JSON ที่อ่านได้ | FR-1100 | ✅ |
| FE-AUD-003 | `paginates with the opaque server cursor` | มี `nextCursor` | ปุ่มโหลดเพิ่มส่ง cursor เดิมที่ได้รับ และต่อท้ายรายการ | FR-1103 | ➕ |
| FE-AUD-004 | `hides the load-more control on the last page` | `nextCursor=null` | ปุ่มหายไป | FR-1103 | 🆕 |
| FE-AUD-005 | `renders a loading state and an empty state distinctly` | request ค้าง / ผลว่าง | `"กำลังโหลด…"` vs `"ไม่พบประวัติที่ตรงกับตัวกรอง"` | NFR-702 | ➕ |
| FE-AUD-006 | `surfaces a query rejection from the server` | ตอบ 400 `invalid_query` | แสดงข้อความ ไม่ล้างตัวกรองที่ผู้ใช้กรอก | FR-1103 | 🆕 |
| FE-AUD-007 | `localizes action and table labels` | `INSERT`/`UPDATE`/`DELETE`, ทุกชื่อตาราง | ป้ายภาษาไทย/อังกฤษถูกต้อง; ค่าที่ไม่รู้จักแสดงค่าดิบ ไม่ใช่ `undefined` | NFR-701 | ➕ |
| FE-AUD-008 | `clear resets every filter and reloads the first page` | กดล้าง | ฟอร์มว่าง และยิง request ที่ไม่มีตัวกรอง | FR-1103 | 🆕 |
| FE-AUD-009 | `timestamps are shown in Bangkok time` | `occurredAt` เป็น UTC | แสดงเวลาไทย 24 ชั่วโมง | CI-04 | ➕ |
| FE-AUD-010 | `renders null before/after values without crashing` | audit INSERT (`oldValues=null`) | แสดง `—` หรือค่าว่างที่อ่านได้ | FR-1100 | 🆕 |

---

## 15. Accessibility & responsive

ไฟล์: `frontend/tests/accessibility-tokens.test.ts` + เพิ่มใน test ของแต่ละหน้า

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| FE-A11Y-001 | `keeps strong UI boundaries at 3:1 contrast against white` | design token | ผ่าน 3:1 | NFR-702 | ✅ |
| FE-A11Y-002 | `body and muted text meet 4.5:1 against their backgrounds` | token ข้อความ | ผ่าน 4.5:1 ทั้งบนพื้นปกติและพื้นแผง | NFR-702 | ➕ |
| FE-A11Y-003 | `status colours are paired with text or an icon` | สถานะ online/offline/pending/abnormal | ทุกสถานะมีข้อความกำกับ | NFR-702 | ➕ |
| FE-A11Y-004 | `interactive targets are at least 44 by 44 CSS pixels` | ปุ่ม/หลุมบนแผนผัง/ลิงก์ | ผ่านเกณฑ์ขั้นต่ำ | NFR-703 | ➕ |
| FE-A11Y-005 | `focus is always visible on keyboard navigation` | Tab ทั่วทุกหน้า | มี focus ring ที่มองเห็นได้ | NFR-702 | ➕ |
| FE-A11Y-006 | `no page scrolls horizontally at 375 px` | ทุกหน้า viewport 375 | ไม่มี overflow แนวนอนของ body | NFR-703 | ➕ |
| FE-A11Y-007 | `every form control has a programmatic label` | ทุกฟอร์ม | ทุก `input/select/textarea` มี label หรือ `aria-label` | NFR-702 | ➕ |
| FE-A11Y-008 | `live regions are used only for genuinely dynamic status` | สถานะคิว/เครือข่าย | `aria-live` อยู่เฉพาะจุดที่เปลี่ยนจริง ไม่กระจายทั่วหน้า | NFR-702 | ✅ |

---

## 16. สรุปจำนวน test case

| หมวด | จำนวน case | ✅ มีแล้ว | ➕ ต้องเสริม | 🆕 ต้องเขียนใหม่ |
|---|---:|---:|---:|---:|
| Harness (WP0) | 6 | 0 | 0 | 6 |
| Utilities (uuid/time/filters/types) | 22 | 6 | 5 | 11 |
| API client | 11 | 4 | 1 | 6 |
| Offline queue | 30 | 10 | 12 | 8 |
| Service worker | 9 | 2 | 0 | 7 |
| Shared components | 13 | 2 | 1 | 10 |
| App shell | 20 | 7 | 7 | 6 |
| Due & checkpoint | 26 | 9 | 11 | 6 |
| Batches & controls | 19 | 7 | 5 | 7 |
| Fish | 20 | 6 | 9 | 5 |
| Master data | 11 | 3 | 3 | 5 |
| Timing / promotions / controls | 24 | 4 | 10 | 10 |
| Dashboard | 26 | 9 | 8 | 9 |
| Export | 11 | 1 | 6 | 4 |
| Audit | 10 | 2 | 4 | 4 |
| Accessibility & responsive | 8 | 2 | 6 | 0 |
| **รวม** | **266** | **74** | **88** | **104** |

---

## 17. Traceability — หน้าจอ SRS ↔ ไฟล์ test

| SCR | หน้าจอ | ไฟล์ test |
|---|---|---|
| SCR-01 | Due Now | `due-workflow.test.tsx` |
| SCR-02 | Embryo checkpoint entry | `due-workflow.test.tsx`, `checkpoint-preview.test.ts` |
| SCR-03 | Batch list | `batches.test.tsx` *(ใหม่)* |
| SCR-04/05/06 | Batch create / edit / duplicate | `batches.test.tsx` |
| SCR-07 | Pending promotions | `fish.test.tsx`, `timing.test.tsx` |
| SCR-08 | Fish registry | `fish.test.tsx` |
| SCR-09 | Fish detail | `fish.test.tsx` |
| SCR-10 | Daily roll-call | `fish.test.tsx` |
| SCR-11 | Control arm counts | `batches.test.tsx` |
| SCR-12/13 | Master data | `master-form.test.tsx` |
| SCR-14 | Dashboard | `dashboard.test.tsx`, `dashboard-helpers.test.ts` *(ใหม่)* |
| SCR-15 | Timing profile | `timing.test.tsx` *(ใหม่)* |
| SCR-16 | Printable dashboard | `export.test.tsx` |
| SCR-17 | Export downloads | `export.test.tsx` |
| SCR-18 | Audit history | `audit.test.tsx` |
| — | App shell / navigation | `browser-workflows.test.tsx` |
| — | Offline resilience | `offline.test.ts`, `offline-replay.test.ts`, `service-worker.test.ts` |

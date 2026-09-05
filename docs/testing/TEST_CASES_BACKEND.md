# KUVTH Zebrafish LIMS — Backend Unit Test Case Design

> เวอร์ชัน: 1.0 · 2 กันยายน 2026 · ประกอบ [`TEST_PLAN.md`](TEST_PLAN.md)
> ระบบที่ทดสอบ: `backend/src/chronofish/**` · API contract `api/openapi.yaml` (52 paths / 71 operations)

## วิธีอ่านเอกสารนี้

| คอลัมน์ | ความหมาย |
|---|---|
| **ID** | รหัสอ้างอิงถาวร ใช้ผูกกับชื่อฟังก์ชัน test และรายงานผล |
| **Test** | ชื่อฟังก์ชัน test ที่จะเขียน (snake_case, บอกกฎที่ปกป้อง) |
| **Setup / Input** | สถานะตั้งต้นและข้อมูลที่ส่ง |
| **Expected** | ผลที่ต้องได้ รวมทั้ง state ที่ต้องอ่านกลับมายืนยัน |
| **Ref** | รหัส requirement / business rule ใน SRS |
| **St** | สถานะ: `✅` มี test ครอบคลุมอยู่แล้ว · `➕` มีบางส่วน ต้องเสริม · `🆕` ต้องเขียนใหม่ |

สัญลักษณ์เพิ่มเติมในคอลัมน์ Expected:
- `DB` = ต้องมี test คู่ใน `test_sql_integration.py` ด้วย (พฤติกรรมนี้ขึ้นกับ persistence จริง)
- `CLOCK` = ต้องใช้ fixture `fixed_clock` ห้ามพึ่ง wall clock

---

## 1. Configuration — `config.py`

ไฟล์เป้าหมาย: `backend/tests/test_config.py`

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-CFG-001 | `test_load_config_normalizes_runtime_values` | env ครบ ค่าปกติ | `Config` มี port/app_env/driver/urls ตามที่ตั้ง; `app_env` ถูก lower+strip | NFR-501 | ✅ |
| BE-CFG-002 | `test_load_config_rejects_memory_in_production` | `APP_ENV=production`, `DB_DRIVER=memory` | `ValueError("DB_DRIVER=memory is only allowed for development or test")` | NFR-505 | ✅ |
| BE-CFG-003 | `test_default_driver_is_memory_only_for_dev_and_test` | `APP_ENV` = `dev`/`development`/`test` โดยไม่ตั้ง `DB_DRIVER` | driver = `memory` ทั้ง 3 ค่า | NFR-505 | 🆕 |
| BE-CFG-004 | `test_default_driver_is_postgres_when_app_env_is_unset` | ไม่ตั้ง `APP_ENV`, ไม่ตั้ง `DB_DRIVER`, ตั้ง `DATABASE_URL` | driver = `postgres` | NFR-505 | 🆕 |
| BE-CFG-005 | `test_unknown_driver_is_rejected` | `DB_DRIVER=sqlite` | `ValueError("DB_DRIVER must be memory, postgres, or mysql")` | NFR-505 | 🆕 |
| BE-CFG-006 | `test_non_memory_driver_requires_database_url` | `DB_DRIVER=postgres`, `DATABASE_URL=""` | `ValueError("DATABASE_URL is required...")` | NFR-505 | 🆕 |
| BE-CFG-007 | `test_port_must_be_an_integer` | `PORT=abc` | `ValueError("PORT must be an integer")` | NFR-501 | 🆕 |
| BE-CFG-008 | `test_port_below_one_is_rejected` | `PORT=0` | `ValueError("PORT must be at least 1")` | NFR-501 | 🆕 |
| BE-CFG-009 | `test_db_pool_size_and_overflow_bounds` | `DB_POOL_SIZE=0` / `DB_MAX_OVERFLOW=-1` | ปฏิเสธทั้งคู่; ค่า `DB_MAX_OVERFLOW=0` ยอมรับได้ (minimum 0) | NFR-201 | 🆕 |
| BE-CFG-010 | `test_ip_allowlist_accepts_bare_address_and_cidr` | `IP_ALLOWLIST="10.0.0.5, 192.168.1.0/24"` | 2 network; ค่าเดี่ยวถูกแปลงเป็น `/32` | NFR-503 | 🆕 |
| BE-CFG-011 | `test_ip_allowlist_rejects_invalid_entry` | `IP_ALLOWLIST="not-an-ip"` | `ValueError` ที่มีค่าที่ผิดอยู่ในข้อความ | NFR-503 | 🆕 |
| BE-CFG-012 | `test_empty_allowlist_and_origins_produce_empty_tuples` | `IP_ALLOWLIST=""`, `CORS_ALLOWED_ORIGINS=" , "` | ทั้งคู่เป็น `()` | NFR-503 | 🆕 |
| BE-CFG-013 | `test_cors_origins_are_split_and_trimmed` | `CORS_ALLOWED_ORIGINS="https://a.example , https://b.example"` | tuple 2 รายการ ไม่มีช่องว่างติด | NFR-503 | 🆕 |
| BE-CFG-014 | `test_migrations_dir_defaults_per_driver_and_honours_override` | driver=`mysql` ไม่ตั้ง `MIGRATIONS_DIR` / ตั้ง `MIGRATIONS_DIR=/tmp/x` | ค่า default ชี้ `db/migrations/mysql`; override ชนะ | NFR-506 | 🆕 |

---

## 2. Application & middleware — `app.py`

ไฟล์เป้าหมาย: `backend/tests/test_app_middleware.py` *(ใหม่ — ย้ายบางส่วนจาก `test_foundation.py`)*

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-APP-001 | `test_health` | `GET /api/v1/health` | 200, `{"status":"ok","version":...}` | NFR-601 | ✅ |
| BE-APP-002 | `test_security_headers_on_every_response` | GET ใด ๆ และ response error | มี `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy` ครบทั้ง success และ error | NFR-504 | ➕ |
| BE-APP-003 | `test_production_sets_strict_transport_security` | `app_env="production"` | มี `Strict-Transport-Security: max-age=31536000; includeSubDomains` | NFR-504 | ✅ |
| BE-APP-004 | `test_non_production_omits_hsts` | `app_env="test"` | ไม่มีเฮดเดอร์ HSTS | NFR-504 | 🆕 |
| BE-APP-005 | `test_json_responses_declare_utf8_charset` | GET ที่คืน JSON ที่มีข้อความไทย | `Content-Type: application/json; charset=utf-8` และตัวอักษรไทยไม่ถูก escape | NFR-506 | 🆕 |
| BE-APP-006 | `test_network_allowlist_denies_unknown_client` | `ip_allowlist=("10.0.0.0/8",)`, client `127.0.0.1` | 403 `network_denied` + security headers | NFR-503 | ✅ |
| BE-APP-007 | `test_network_allowlist_admits_listed_client` | allowlist ครอบคลุม client | 200 ตามปกติ | NFR-503 | 🆕 |
| BE-APP-008 | `test_unparseable_client_host_is_denied_when_allowlist_is_set` | client host ไม่ใช่ IP (unix socket / hostname) | 403 `network_denied` ไม่ใช่ 500 | NFR-503 | 🆕 |
| BE-APP-009 | `test_rate_limit_blocks_after_120_requests_per_minute` | ยิง GET 121 ครั้งจาก IP เดียว | ครั้งที่ 121 ได้ 429 `rate_limited` + `Retry-After: 60` | NFR-202 | 🆕 |
| BE-APP-010 | `test_rate_limit_window_slides` | ยิงจนติดลิมิต แล้วเลื่อน monotonic clock ไป 61 วินาที | request ถัดไปได้ 200 | NFR-202 | 🆕 CLOCK |
| BE-APP-011 | `test_rate_limit_is_per_source_ip` | IP A ติดลิมิต | IP B ยังได้ 200 | NFR-202 | 🆕 |
| BE-APP-012 | `test_rate_limit_client_bookkeeping_is_bounded` | client ไม่ซ้ำเกิน `MAX_RATE_LIMIT_CLIENTS` (10,000) | `app.state.rate_limit_hits` ไม่โตเกินเพดาน และตัวเก่าสุดถูกทิ้งแบบ LRU | NFR-202 | ✅ |
| BE-APP-013 | `test_oversized_declared_body_is_rejected` | `Content-Length` > 10 MB | 413 `request_too_large` | NFR-203 | ✅ |
| BE-APP-014 | `test_oversized_chunked_body_is_rejected_with_common_envelope` | ส่ง body ทีละก้อนจนเกิน 10 MB โดยไม่ประกาศ `Content-Length` | 413 พร้อม `ErrorResponse` envelope | NFR-203 | ✅ |
| BE-APP-015 | `test_invalid_content_length_header_is_rejected` | `Content-Length: abc` | 400 `invalid_request` "Content-Length is invalid" | NFR-203 | 🆕 |
| BE-APP-016 | `test_writes_require_json_and_use_the_common_error_envelope` | POST ด้วย `Content-Type: text/plain` | 400 `invalid_request` "Content-Type must be application/json" | API-02 | ✅ |
| BE-APP-017 | `test_timing_csv_upload_accepts_its_contract_content_type` | `POST /timing-profiles/csv` ด้วย `text/csv` | ผ่านการตรวจ content type | FR-208 | ✅ |
| BE-APP-018 | `test_timing_csv_endpoint_rejects_json_content_type` | `POST /timing-profiles/csv` ด้วย `application/json` | 400 "Content-Type must be text/csv" | FR-208 | 🆕 |
| BE-APP-019 | `test_get_with_body_is_content_type_checked` | GET ที่มี `Content-Length > 0` และ content type ผิด | 400 `invalid_request` | API-02 | 🆕 |
| BE-APP-020 | `test_malformed_json_uses_the_common_error_envelope` | POST body = `{`  | 400 `{"error":{"code":"invalid_request",...}}` ไม่ใช่ FastAPI default | API-02 | ✅ |
| BE-APP-021 | `test_unhandled_exception_returns_redacted_500` | monkeypatch route ให้โยน `RuntimeError("secret detail")` | 500 `internal_error` "an unexpected error occurred"; ข้อความภายในไม่รั่วใน body | NFR-502 | 🆕 |
| BE-APP-022 | `test_api_error_raised_inside_a_route_is_serialized_once` | route โยน `APIError(409, "conflict", ...)` พร้อม `details` | body มี `error.details` ครบและ status 409 | API-02 | 🆕 |
| BE-APP-023 | `test_cors_headers_present_only_when_origins_configured` | สร้าง app ด้วย `allowed_origins=("https://x",)` และอีกตัวไม่ตั้ง | preflight OPTIONS ตอบ header CORS เฉพาะตัวแรก; allow-headers ครอบคลุม `X-Operator-Id`, `X-Device-Id`, `X-Idempotency-Key` | NFR-503 | 🆕 |
| BE-APP-024 | `test_create_app_selects_sql_store_for_non_memory_driver` | `create_app(Config(db_driver="postgres", ...))` โดย monkeypatch `SQLStore` | ใช้ `SQLStore` ไม่ใช่ `MemoryStore`; ลงทะเบียน shutdown handler ที่เรียก `close()` | NFR-505 | 🆕 |
| BE-APP-025 | `test_openapi_and_docs_routes_are_disabled` | `GET /docs`, `/redoc`, `/openapi.json` | 404 ทั้งหมด (ไม่เปิดเผย schema จาก runtime) | NFR-502 | 🆕 |
| BE-APP-026 | `test_request_log_records_metadata_only` | ยิง POST ที่มีข้อมูลผู้ป่วย/ตัวอย่างใน body และจับ log | log มีแค่ method/path/status/duration ไม่มีเนื้อ body | NFR-507 | 🆕 |

---

## 3. Runtime — `runtime/values.py`, `runtime/errors.py`, `runtime/mutations.py`

ไฟล์เป้าหมาย: `backend/tests/test_runtime.py` *(ใหม่)*

### 3.1 Values

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-RUN-001 | `test_uuid7_shape` | เรียก `uuid7()` | version nibble = 7, variant = RFC 4122 | DR-02 | ✅ |
| BE-RUN-002 | `test_uuid7_values_are_time_ordered_and_unique` | สร้าง 1,000 ค่า | ไม่ซ้ำ; 48 บิตแรกไม่ลดลงตามเวลา | DR-02 | 🆕 |
| BE-RUN-003 | `test_iso_now_is_utc_with_z_suffix` | `iso_now()` | ลงท้ายด้วย `Z` ไม่ใช่ `+00:00` และ parse กลับได้ | CI-04 | 🆕 |
| BE-RUN-004 | `test_parse_datetime_converts_offsets_to_utc` | `"2026-01-01T07:00:00+07:00"` | เท่ากับ `2026-01-01T00:00:00Z` | CI-04 | 🆕 |
| BE-RUN-005 | `test_parse_datetime_accepts_z_suffix` | `"2026-01-01T00:00:00Z"` | parse ได้ tzinfo=UTC | CI-04 | 🆕 |
| BE-RUN-006 | `test_parse_datetime_rejects_naive_timestamp` | `"2026-01-01T00:00:00"` | `APIError(422)` "timestamp ต้องระบุ timezone" | CI-04 | 🆕 |
| BE-RUN-007 | `test_parse_datetime_rejects_garbage` | `"tomorrow"`, `""`, `None` | `APIError(422)` "ต้องเป็น ISO 8601 พร้อม timezone" | CI-04 | 🆕 |
| BE-RUN-008 | `test_normalize_trims_strings_recursively` | dict ซ้อน list ซ้อน dict ที่มีช่องว่างหน้า/หลัง | ทุก string ถูก strip; ตัวเลข/bool/None ไม่เปลี่ยน | DR-01 | 🆕 |
| BE-RUN-009 | `test_error_response_shape_and_optional_details` | `APIError(422,"validation_error","x")` และอีกตัวที่มี `details` | body = `{"error":{"code","message"}}`; ใส่ `details` เฉพาะเมื่อไม่ใช่ `None` | API-02 | 🆕 |

### 3.2 Write context & idempotency

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-RUN-020 | `test_write_context_headers_are_required` | POST ไม่มี `X-Operator-Id` | 400 `invalid_context` | API-03 | ✅ |
| BE-RUN-021 | `test_operator_header_must_be_uuid` | `X-Operator-Id: bob` | 400 "X-Operator-Id ต้องเป็น UUID" | API-03 | 🆕 |
| BE-RUN-022 | `test_device_id_length_and_control_characters` | `X-Device-Id` = `""`, 65 ตัวอักษร, มี `\n` | 400 ทั้ง 3 กรณี | API-03 | 🆕 |
| BE-RUN-023 | `test_unknown_or_inactive_operator_is_rejected` | operator id ที่ไม่มีในระบบ / ที่ `active=false` | 400 "operator ไม่ถูกต้องหรือถูกปิดใช้งาน" | API-03, FR-104 | 🆕 |
| BE-RUN-024 | `test_operator_creation_is_exempt_from_operator_lookup` | `POST /operators` ด้วย operator id ที่ยังไม่มีในระบบ | สำเร็จ (bootstrap ผู้ใช้คนแรกได้) | FR-101 | 🆕 |
| BE-RUN-025 | `test_idempotency_key_must_be_uuid` | `X-Idempotency-Key: 123` | 400 "ทุกการบันทึกต้องมี X-Idempotency-Key ที่เป็น UUID" | FR-1002 | 🆕 |
| BE-RUN-026 | `test_master_create_normalizes_rejects_duplicate_and_replays` | POST เดิมซ้ำด้วย key เดิม | ครั้งที่สองคืน status/body เดิม ไม่สร้างซ้ำ | FR-1002 | ✅ |
| BE-RUN-027 | `test_idempotency_key_rejects_different_payload` | key เดิม body ต่าง | 409 `idempotency_conflict` | FR-1002 | ✅ |
| BE-RUN-028 | `test_idempotency_replay_preserves_no_content_status` | DELETE ซ้ำด้วย key เดิม | 204 ทั้งสองครั้ง ไม่ใช่ 200 + body ว่าง | FR-1002 | ✅ |
| BE-RUN-029 | `test_idempotency_scope_includes_method_path_and_query` | key เดียวกันแต่ path/query ต่างกัน | ถือเป็นคนละ scope ทำงานได้ทั้งคู่ | FR-1002 | 🆕 |
| BE-RUN-030 | `test_request_fingerprint_ignores_key_order_and_whitespace` | body เดียวกันสลับลำดับ key และมีช่องว่างรอบค่า string | fingerprint เท่ากัน → replay ไม่ขึ้น 409 | FR-1002 | 🆕 |
| BE-RUN-031 | `test_audit_entry_captures_operator_device_and_deep_copies` | ทำ UPDATE แล้วแก้ dict ต้นทางภายหลัง | audit row เก็บ `operatorId`/`deviceId`/`occurredAt` และ `oldValues` ไม่เปลี่ยนตาม (deep copy) | FR-1100 | 🆕 |
| BE-RUN-032 | `test_encode_result_supports_bytes_and_custom_media_type` | operation คืน `(200, b"...", "text/csv")` | ส่งออกเป็น bytes เดิม พร้อม media type ที่กำหนด | FR-902 | 🆕 |

---

## 4. Entry point — `__main__.py`

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-MAIN-001 | `test_main_runs_migrations_before_serving_for_sql_drivers` | monkeypatch `migrate` และ `uvicorn.run` ด้วย driver `postgres` | `migrate()` ถูกเรียกก่อน `uvicorn.run()` เสมอ | NFR-506 | 🆕 |
| BE-MAIN-002 | `test_main_skips_migrations_for_memory_driver` | driver `memory` | ไม่เรียก `migrate()` | NFR-505 | 🆕 |
| BE-MAIN-003 | `test_main_binds_configured_port` | `PORT=9090` | `uvicorn.run` ได้ port 9090 | NFR-501 | 🆕 |

---

## 5. Domain rules — `domain/rules.py`, `domain/state.py`

ไฟล์เป้าหมาย: `backend/tests/test_domain_rules.py` *(ใหม่ — แยกออกจาก `test_foundation.py`)*

### 5.1 Stage taxonomy

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-DOM-001 | `test_stage_code_covers_all_36_orders` | order 1…36 | ได้รหัสรูปแบบ `stage_NN_SUFFIX` ครบ 36 ตัว ไม่ซ้ำ; ตรงกับ `STAGE_SUFFIXES` | FR-201 | ➕ |
| BE-DOM-002 | `test_stage_code_out_of_range_has_no_suffix` | order 0 และ 37 | คืน `stage_00` / `stage_37` โดยไม่มี suffix ค้างขีดล่าง | FR-201 | 🆕 |
| BE-DOM-003 | `test_stage_number_parses_and_rejects` | `stage_07_64C` → 7; `stage_xx` / `""` / `stage_00_X` → 0 | ตรงตามที่ระบุ | FR-201 | ➕ |
| BE-DOM-004 | `test_stage_label_boundaries` | order 1, 2, 10, 11, 12, 21, 22, 36 | `Activated (1-cell)`, `2-cell`, `512-cell`, `1k-cell`, `High`, `90% epiboly`, `Day 1`, `Day 15` | FR-201 | ➕ |
| BE-DOM-005 | `test_stage_phase_boundaries` | order 10/11, 15/16, 21/22 | `CLEAVAGE`→`BLASTULA`→`GASTRULA`→`LARVAL` เปลี่ยนตรงจุดที่กำหนด | FR-201 | 🆕 |
| BE-DOM-006 | `test_stage_short_label_matches_suffix_table` | order 1…36 และนอกช่วง | ตรงกับ `STAGE_SUFFIXES`; นอกช่วงคืน `""` | FR-201 | 🆕 |
| BE-DOM-007 | `test_default_expected_hpa_matches_zfin_table` | ทุก stage code | ตรงกับ `EXPECTED_HPA` ตำแหน่งเดียวกัน; รหัสไม่รู้จักคืน `0.0` | BR-03 | ➕ |
| BE-DOM-008 | `test_day5_stage_order_closes_stage_one` | ค่าคงที่ | `DAY5_STAGE_ORDER == 26` และ `stage_label(26) == "Day 5"` | BR-09 | 🆕 |

### 5.2 การคำนวณเวลาและส่วนต่าง

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-DOM-020 | `test_round4_uses_half_up_not_bankers` | 0.00005, 2.5 → ปัดขึ้น; ค่าลบ | ROUND_HALF_UP ตามที่ระบุ ไม่ใช่ round() ของ Python | DR-05 | ➕ |
| BE-DOM-021 | `test_round4_keeps_four_decimals` | 1/3 | `0.3333` | DR-05 | 🆕 |
| BE-DOM-022 | `test_deviation_label_at_the_one_minute_boundary` | ±1/60 ชม. พอดี และน้อยกว่า | น้อยกว่า → "ตรงกับสากล" / "matches reference" | BR-23 | ✅ |
| BE-DOM-023 | `test_deviation_label_under_one_hour` | −0.5, +0.5 | "เร็วกว่าสากล 30 นาที" / "30 minutes slower than reference" | BR-23 | ✅ |
| BE-DOM-024 | `test_deviation_label_over_one_hour` | +1.5 | "ช้ากว่าสากล 1 ชม. 30 นาที" / "1 hr 30 min slower than reference" | BR-23 | ✅ |
| BE-DOM-025 | `test_deviation_label_singular_minute_in_english` | +1/60·1.2 (≈1 นาที) | "1 minute slower than reference" (ไม่ใช่ minutes) | BR-23 | 🆕 |
| BE-DOM-026 | `test_is_backdated_at_the_fifteen_minute_boundary` | ต่าง 15 นาทีพอดี / 15 นาที 1 วินาที | `False` / `True`; ทดสอบทั้งทิศอดีตและอนาคต | BR-22 | ➕ |
| BE-DOM-030 | `test_age_days_on_counts_calendar_days` | dob 2026-01-01, observed 2026-01-02 | 1 (ไม่ใช่ 24 ชม.) | BR-06 | ➕ |
| BE-DOM-031 | `test_age_days_on_is_negative_before_dob` | observed ก่อน dob | ค่าติดลบ (ผู้เรียกเป็นผู้ปฏิเสธ) | BR-06 | 🆕 |

### 5.3 ENU และเกณฑ์เลื่อนขั้น

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-DOM-040 | `test_enu_window_rejects_finish_before_start` | finish ≤ start | `ValueError("enu finish must be after enu start")` | FR-307 | ➕ |
| BE-DOM-041 | `test_enu_window_warns_when_finish_is_after_activation` | finish > activated | คืนข้อความเตือน (ไม่ใช่ exception) | FR-307 | ✅ |
| BE-DOM-042 | `test_enu_window_returns_none_when_consistent` | start < finish ≤ activated | คืน `None` | FR-307 | 🆕 |
| BE-DOM-043 | `test_promotion_eligible_requires_all_conditions` | ตารางความจริงของ (`has_exit`, `latest_alive`, `days`, `now` เทียบ `activated+days`) | เข้าเกณฑ์เฉพาะเมื่อ ไม่มี exit ∧ ยังมีชีวิต ∧ days>0 ∧ now > activated+days | BR-09 | ➕ |
| BE-DOM-044 | `test_promotion_is_not_eligible_exactly_at_the_threshold` | now == activated + days พอดี | `False` (ต้องเกิน ไม่ใช่เท่ากับ) | BR-09 | 🆕 |
| BE-DOM-050 | `test_fish_outcome_and_condition_enums` | ค่าใน/นอกชุดที่อนุญาต | `fish_outcome_valid` รับ 5 ค่า; `condition_valid` รับ 3 ค่า; ค่าอื่นทั้งหมด `False` รวม lowercase | FR-601 | ➕ |

### 5.4 Seeded state

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-DOM-060 | `test_seeded_state_contains_every_resource_bucket` | `State.seeded()` | มี key ครบทุกตัวใน `RESOURCES` | DR-01 | 🆕 |
| BE-DOM-061 | `test_seeded_timing_profile_has_36_current_entries` | `State.seeded()` | profile เดียว `isCurrent=True` มี 36 entries เรียงตาม order พร้อม `stageScope` STAGE_1 (1–26) / STAGE_2 (27–36) | FR-201, FR-202 | ➕ |
| BE-DOM-062 | `test_seeded_protocol_default_stage1_max_age_is_five_days` | `State.seeded()` | `stage1MaxAgeDays == 5` | BR-09 | 🆕 |

---

## 6. Store

### 6.1 MemoryStore — `store/memory.py`

ไฟล์เป้าหมาย: `backend/tests/test_store_memory.py` *(ใหม่)*

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-MEM-001 | `test_snapshot_is_an_isolated_deep_copy` | แก้ค่าใน snapshot ที่ได้ | state จริงไม่เปลี่ยน | DR-01 | 🆕 |
| BE-MEM-002 | `test_failed_mutation_leaves_state_untouched` | operation ที่โยน `APIError` กลางทางหลังแก้ working copy | state เดิมไม่มีร่องรอยการเขียนบางส่วน | NFR-301 | 🆕 |
| BE-MEM-003 | `test_successful_mutation_commits_working_copy_atomically` | operation ที่แก้หลาย entity | เห็นครบทั้งหมดใน snapshot ถัดไป | NFR-301 | 🆕 |
| BE-MEM-004 | `test_idempotency_cache_stores_status_media_type_and_body` | mutation ที่คืน CSV/bytes | replay คืน media type และ bytes เดิม | FR-1002 | 🆕 |
| BE-MEM-005 | `test_concurrent_mutations_are_serialized_by_the_lock` | ยิง mutation จาก 8 thread พร้อมกัน | ไม่มีข้อมูลหาย, จำนวน record ตรง | NFR-301 | 🆕 |

### 6.2 SQLStore — `store/sql.py` *(รันเฉพาะ DB job)*

ไฟล์เป้าหมาย: `backend/tests/test_sql_integration.py`

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-SQL-001 | `test_sql_store_persists_workflow_idempotency_and_audit_across_instances` | สร้าง batch/lot/embryo/observation แล้วสร้าง `SQLStore` ตัวใหม่ | อ่านข้อมูลกลับได้ครบ, idempotency replay ยังทำงาน | NFR-301 | ✅ |
| BE-SQL-002 | `test_concurrent_timing_versions_are_serialized_with_one_current_profile` | สร้าง version พร้อมกันหลาย thread | เหลือ `isCurrent` เพียง 1 และ version ไม่ซ้ำ | FR-205 | ✅ |
| BE-SQL-003 | `test_concurrent_batch_codes_and_live_wells_remain_unique` | สร้าง batchCode เดียวกัน / well เดียวกันพร้อมกัน | database constraint กันได้ ผู้แพ้ได้ 409 | FR-303, FR-310 | ✅ |
| BE-SQL-004 | `test_concurrent_promotions_allocate_unique_fish_numbers` | promote พร้อมกัน | running number ไม่ซ้ำภายใต้ lock | BR-10 | ✅ |
| BE-SQL-005 | `test_concurrent_observation_save_correction_and_soft_delete_are_consistent` | save/correct/delete พร้อมกัน | state สุดท้ายสอดคล้อง audit | BR-19, FR-1101 | ✅ |
| BE-SQL-006 | `test_camel_snake_column_mapping_round_trips` | เขียน entity ที่มีฟิลด์ camelCase ครบทุกตาราง | อ่านกลับได้ค่าเดิมทุกฟิลด์ (ตรวจ `_camel`/`_snake`) | DR-04 | 🆕 |
| BE-SQL-007 | `test_json_columns_round_trip_null_and_nested_values` | audit `oldValues`/`newValues` เป็น `None` และ dict ซ้อน | อ่านกลับได้รูปเดิม ไม่กลายเป็น string | FR-1100 | 🆕 |
| BE-SQL-008 | `test_derived_embryo_and_fish_projections_are_hydrated_on_load` | ปิด process แล้วโหลด state ใหม่ | `exitReason`, `firstAbnormal*`, `status` ถูกคำนวณกลับมาถูกต้อง | BR-13, BR-20 | 🆕 |
| BE-SQL-009 | `test_next_fish_no_is_restored_from_persisted_maximum` | promote 3 ตัวแล้วสร้าง store ใหม่ | `next_fish_no` ต่อจากเลขสูงสุด ไม่ย้อนกลับไป 1 | BR-10 | 🆕 |
| BE-SQL-010 | `test_soft_deleted_rows_are_excluded_from_read_models_but_kept_in_storage` | soft delete embryo/observation | ไม่ปรากฏใน API แต่ยังอยู่ในตารางและ audit | BR-17 | 🆕 |
| BE-SQL-011 | `test_query_audits_keyset_pagination_matches_memory_fallback` | สร้าง audit > 1 หน้า | ลำดับและ `nextCursor` ตรงกับผลของ MemoryStore | FR-1103 | 🆕 |
| BE-SQL-012 | `test_idempotency_conflict_is_detected_across_connections` | ส่ง key เดิม payload ต่าง จากคนละ connection | 409 `idempotency_conflict` | FR-1002 | 🆕 |
| BE-SQL-013 | `test_timing_entries_sync_replaces_the_full_stage_set` | สร้าง version ใหม่จาก partial override | ตาราง `stage_timing` มี 36 แถวของ version ใหม่ ไม่ปะปนกับของเก่า | FR-205 | 🆕 |
| BE-SQL-014 | `test_store_close_disposes_the_engine` | เรียก `close()` | connection pool ถูกปิด, เรียกซ้ำไม่ระเบิด | NFR-201 | 🆕 |

### 6.3 Migrations — `store/migrations.py`, `store/database.py`

ไฟล์เป้าหมาย: `backend/tests/test_migrations.py` *(ใหม่ — ใช้ SQLite/ mock engine สำหรับส่วนที่ไม่ผูกกับ engine จริง + DB job สำหรับส่วนที่ผูก)*

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-MIG-001 | `test_migration_files_are_sorted_numerically_not_lexically` | ไฟล์ `2_...`, `10_...` | ลำดับ 2 มาก่อน 10 | NFR-506 | 🆕 |
| BE-MIG-002 | `test_missing_migration_directory_raises_clearly` | ชี้ dir ที่ไม่มีอยู่ | `RuntimeError` ที่ระบุ path | NFR-506 | 🆕 |
| BE-MIG-003 | `test_empty_migration_directory_raises_clearly` | dir ว่าง / มีแต่ไฟล์ `.down.sql` | `RuntimeError("no up migrations found...")` | NFR-506 | 🆕 |
| BE-MIG-004 | `test_only_up_migrations_are_collected` | มีทั้ง `.up.sql` และ `.down.sql` | เลือกเฉพาะ `.up.sql` | NFR-506 | 🆕 |
| BE-MIG-005 | `test_dirty_schema_blocks_startup` | `schema_migrations` มี `dirty=TRUE` | `RuntimeError("...is dirty; restore or repair it before startup")` และไม่รัน SQL ใด ๆ ต่อ | NFR-506 | 🆕 DB |
| BE-MIG-006 | `test_already_applied_versions_are_skipped` | current version = 5, มีไฟล์ 1–9 | รันเฉพาะ 6–9 | NFR-506 | 🆕 DB |
| BE-MIG-007 | `test_failed_migration_leaves_the_version_marked_dirty` | ไฟล์ที่มี SQL ผิด | โยน exception และ `schema_migrations.dirty = TRUE` ที่ version นั้น | NFR-506 | 🆕 DB |
| BE-MIG-008 | `test_advisory_lock_is_released_even_on_failure` | migration ล้มเหลว | ยังปล่อย lock (รันซ้ำได้ทันที ไม่ค้าง) | NFR-506 | 🆕 DB |
| BE-MIG-009 | `test_mysql_lock_acquisition_failure_is_fatal` | `GET_LOCK` คืนค่า ≠ 1 | `RuntimeError("could not acquire the MySQL migration lock")` | NFR-506 | 🆕 DB |
| BE-MIG-010 | `test_migrations_are_idempotent_when_run_twice` | รัน `migrate()` สองรอบบน DB สะอาด | รอบที่สองไม่มีอะไรเปลี่ยน และไม่ error | NFR-506 | 🆕 DB |
| BE-MIG-011 | `test_postgres_and_mysql_migrations_produce_the_same_logical_schema` | apply ทั้งสอง engine | ตาราง/คอลัมน์/ดัชนีที่ระบุใน SRS §5.8 ตรงกัน | NFR-506 | ➕ DB |
| BE-DB-001 | `test_sqlalchemy_url_rewrites_postgres_schemes` | `postgres://`, `postgresql://` | ได้ `postgresql+psycopg://` ทั้งคู่ | NFR-505 | 🆕 |
| BE-DB-002 | `test_sqlalchemy_url_rewrites_mysql_scheme` | `mysql://` | ได้ `mysql+pymysql://` | NFR-505 | 🆕 |
| BE-DB-003 | `test_sqlalchemy_url_passes_through_explicit_drivers` | `postgresql+psycopg://...` | ไม่เปลี่ยนค่า | NFR-505 | 🆕 |
| BE-DB-004 | `test_mysql_engine_enables_multi_statements` | สร้าง engine ด้วย driver mysql (mock `create_engine`) | `connect_args["client_flag"]` มี `MULTI_STATEMENTS` | NFR-506 | 🆕 |

---

## 7. Master data — `api/routes/master.py`

ทดสอบ 7 resource: `sites`, `operators`, `donor-cell-lines`, `recipient-egg-lots`, `csof-lots`, `treatment-groups`, `fish-boxes` — รวม 21 operations
ไฟล์เป้าหมาย: `backend/tests/test_master.py` *(ใหม่)*

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-MST-001 | `test_every_master_resource_supports_list_create_update` | *(parametrize ทั้ง 7 resource)* สร้าง → อ่าน → แก้ | 201/200/200 ครบทุก resource; `id`, `active`, `createdAt`, `updatedAt` ถูกเซ็ต | FR-101 | ➕ |
| BE-MST-002 | `test_required_fields_are_enforced_per_resource` | *(parametrize)* ส่ง body ที่ขาดฟิลด์บังคับทีละตัว | 422 `validation_error` "ต้องระบุ &lt;field&gt;" | FR-102 | ➕ |
| BE-MST-003 | `test_whitespace_only_required_field_is_rejected` | `{"code": "   "}` | 422 (strip แล้วว่าง) | FR-102 | 🆕 |
| BE-MST-004 | `test_uniqueness_is_case_insensitive_per_resource` | *(parametrize)* สร้างซ้ำต่างตัวพิมพ์ | 409 `conflict` ทุก resource | FR-103 | ➕ |
| BE-MST-005 | `test_donor_cell_line_uniqueness_uses_the_three_field_key` | strain+preparation เดิม แต่ batchCode ต่าง | สร้างได้; ถ้า batchCode เดิมด้วย → 409 | FR-103 | 🆕 |
| BE-MST-006 | `test_inactive_records_do_not_block_new_unique_values` | ปิดใช้งานรายการเดิม แล้วสร้างค่าเดิมใหม่ | สร้างได้ 201 | FR-103, FR-111 | 🆕 |
| BE-MST-007 | `test_donor_preparation_enum_is_enforced` | `preparation="OTHER"` | 422 "preparation ต้องเป็น DISSOCIATED หรือ CHUNKS" | FR-105 | 🆕 |
| BE-MST-008 | `test_treatment_group_arm_type_enum_is_enforced` | `armType="CONTROL"` | 422 "armType ไม่ถูกต้อง" | FR-106 | 🆕 |
| BE-MST-009 | `test_operator_and_fish_box_site_reference_must_be_active` | `siteId` ที่ไม่มี / ที่ปิดใช้งาน | 422 "siteId references an inactive or missing sites" | FR-104 | 🆕 |
| BE-MST-010 | `test_inactive_master_is_hidden_by_default_but_resolvable_for_history` | ปิดใช้งาน 1 รายการ | `GET` ปกติไม่เห็น; `?includeInactive=true` เห็น | FR-111 | ✅ |
| BE-MST-011 | `test_deactivation_stamps_deleted_at` | `PATCH {"active": false}` | มี `deletedAt` และ audit `UPDATE` บันทึก before/after | BR-17 | 🆕 |
| BE-MST-012 | `test_reactivation_revalidates_uniqueness` | ปิดรายการ A, สร้าง B ที่ code เดียวกัน, เปิด A กลับ | 409 `conflict` (ไม่ปล่อยให้มี active ซ้ำสองตัว) | FR-103 | 🆕 |
| BE-MST-013 | `test_update_cannot_change_the_identifier` | `PATCH {"id": "<other-uuid>"}` | `id` เดิมไม่เปลี่ยน | DR-02 | 🆕 |
| BE-MST-014 | `test_update_on_missing_record_returns_404` | PATCH id ที่ไม่มี | 404 `not_found` | FR-101 | 🆕 |
| BE-MST-015 | `test_list_is_sorted_by_code_then_id_case_insensitively` | สร้าง `b`, `A`, `a` | เรียง `A`,`a`,`b` (casefold) และ tie-break ด้วย id | FR-107 | 🆕 |
| BE-MST-016 | `test_list_pagination_walks_the_full_set_without_gaps` | สร้าง 250 รายการ, `limit=100` | 3 หน้า, ไม่มีซ้ำ/ตกหล่น, หน้าสุดท้าย `nextCursor=null` | FR-108 | 🆕 |
| BE-MST-017 | `test_list_rejects_invalid_cursor_and_clamps_limit` | `cursor=abc` → 400 `invalid_query`; `limit=0` / `limit=501` | 400/422 ตาม FastAPI bound (ge=1, le=500) | FR-108 | 🆕 |
| BE-MST-018 | `test_negative_cursor_is_treated_as_zero` | `cursor=-5` | คืนหน้าแรก ไม่ error | FR-108 | 🆕 |
| BE-MST-019 | `test_client_supplied_id_is_honoured_for_offline_creation` | POST พร้อม `id` ที่ client สร้าง | ใช้ id นั้น (รองรับ offline-first) | FR-1001 | 🆕 |
| BE-MST-020 | `test_master_create_writes_an_insert_audit_row` | สร้าง site | `GET /audit-log?table=sites` เห็น `INSERT` พร้อม `newValues` | FR-1100 | ➕ |

---

## 8. Protocol & timing profile — `api/routes/timing.py`

ไฟล์เป้าหมาย: `backend/tests/test_timing.py` *(ใหม่ — ย้ายจาก `test_foundation.py`)*

### 8.1 อ่าน

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-TIM-001 | `test_protocols_are_listed_sorted_by_name` | สร้าง protocol เพิ่ม | เรียงตามชื่อ casefold, `nextCursor=null` | FR-201 | 🆕 |
| BE-TIM-002 | `test_protocol_stages_are_canonical_definitions_in_order` | `GET /protocols/{id}/stages` | 36 รายการ เรียงตาม `stageOrder` มีคีย์ `id,stageOrder,code,label,shortLabel,phase,stageScope` | FR-201 | ✅ |
| BE-TIM-003 | `test_protocol_stages_404_for_unknown_protocol` | id มั่ว | 404 "ไม่พบ protocol" | FR-201 | 🆕 |
| BE-TIM-004 | `test_protocol_stages_404_when_no_current_profile` | protocol ที่ไม่มี timing profile | 404 "no current timing profile" | FR-202 | 🆕 |
| BE-TIM-005 | `test_current_timing_profile_requires_uuid_protocol_id` | `?protocolId=abc` | 400 `invalid_query` "protocolId must be UUID" | FR-202 | 🆕 |
| BE-TIM-006 | `test_current_timing_profile_returns_36_entries` | seeded protocol | `isCurrent=true`, 36 entries | FR-202 | ➕ |
| BE-TIM-007 | `test_timing_profile_history_is_sorted_newest_first` | สร้าง version 2 และ 3 | `GET /timing-profiles?protocolId=` คืนเรียง version มาก→น้อย | FR-206 | 🆕 |

### 8.2 สร้าง version ใหม่

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-TIM-020 | `test_timing_profile_partial_override_keeps_36_stages` | override 2 stage | version ใหม่มี 36 entries; ค่าที่ไม่ override คงเดิม | FR-205 | ✅ |
| BE-TIM-021 | `test_new_version_atomically_demotes_the_previous_current` | สร้าง version ใหม่ | เก่ากลายเป็น `isCurrent=false` พร้อม audit UPDATE; ใหม่เป็น current | FR-205 | ➕ DB |
| BE-TIM-022 | `test_version_number_increments_from_the_maximum` | มี version 1,2 | ใหม่ = 3 | FR-206 | 🆕 |
| BE-TIM-023 | `test_created_by_operator_is_recorded` | สร้าง version | `createdByOperatorId` = ค่าใน `X-Operator-Id` | FR-1102 | 🆕 |
| BE-TIM-024 | `test_timing_profile_rejects_duplicate_stage_overrides_without_changing_current` | ส่ง stage เดียวกันสองครั้ง | 422; current profile เดิมไม่เปลี่ยน | FR-205 | ✅ |
| BE-TIM-025 | `test_stage_code_and_stage_order_must_agree` | `stageCode=stage_03_4C` กับ `stageOrder=4` | 422 "stageOrder and stageCode must match" | FR-205 | 🆕 |
| BE-TIM-026 | `test_expected_hpa_rejects_negative_nan_and_infinity` | −1, NaN, Infinity, `true` | 422 ทุกกรณี | FR-205 | ➕ |
| BE-TIM-027 | `test_expected_hpa_must_be_present` | entry ไม่มี `expectedHpa` | 422 "expectedHpa ต้องเป็นตัวเลข" | FR-205 | 🆕 |
| BE-TIM-028 | `test_profile_name_is_required_and_bounded` | ไม่มี name / name ยาว 201 ตัว | 422 | FR-205 | 🆕 |
| BE-TIM-029 | `test_source_note_and_reference_temp_are_validated` | `sourceNote` 501 ตัว; `referenceTempC="28.5"` (string) / `true` | 422 ทั้งคู่ | FR-205 | 🆕 |
| BE-TIM-030 | `test_entries_must_be_a_non_empty_list_of_objects` | `entries=[]`, `entries="x"`, `entries=[1]` | 422 ทุกกรณี | FR-205 | 🆕 |
| BE-TIM-031 | `test_protocol_without_current_profile_cannot_receive_a_version` | protocol ใหม่ที่ไม่มี profile | 422 "protocol has no current timing profile" | FR-205 | 🆕 |
| BE-TIM-032 | `test_new_timing_version_only_applies_to_new_batches` | batch เก่า + version ใหม่ + batch ใหม่ | batch เก่าคง `timingProfileId` เดิม; batch ใหม่ผูก version ใหม่ | AC-204, T-08 | ✅ |
| BE-TIM-033 | `test_existing_observations_keep_their_hpa_snapshot_after_a_new_version` | observe → สร้าง version ใหม่ | `hpaExpectedSnapshot` ของ observation เดิมไม่เปลี่ยน | BR-03 | ✅ |

### 8.3 CSV import / export

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-TIM-050 | `test_timing_csv_export_can_be_imported_without_changing_entries` | export → import | round-trip ได้ค่าเดิม | FR-207 | ✅ |
| BE-TIM-051 | `test_csv_export_headers_and_disposition` | `GET /timing-profiles/csv` | header `stage_order,stage_code,label,expected_hpa`, `Content-Disposition: attachment`, media type `text/csv; charset=utf-8` | FR-207 | 🆕 |
| BE-TIM-052 | `test_csv_export_404_when_protocol_has_no_profile` | protocol ไม่มี profile | 404 | FR-207 | 🆕 |
| BE-TIM-053 | `test_timing_csv_reports_every_invalid_row_before_writing` | หลายแถวผิดพร้อมกัน | 422 พร้อม `details.rows` ครบทุกแถว; ไม่มี version ใหม่ถูกสร้าง | FR-208 | ✅ |
| BE-TIM-054 | `test_timing_csv_reports_a_malformed_quoted_header` | header ที่มี quote ไม่ปิด | 422 `details.rows[0].field == "header"` | FR-208 | ✅ |
| BE-TIM-055 | `test_csv_header_mismatch_is_reported_with_the_expected_columns` | header สลับคอลัมน์ | 422 message "expected stage_order,stage_code,label,expected_hpa" | FR-208 | 🆕 |
| BE-TIM-056 | `test_csv_rejects_non_integer_stage_order` | `stage_order=x` | 422 field `stage_order` "must be an integer" | FR-208 | 🆕 |
| BE-TIM-057 | `test_csv_rejects_duplicate_stage_rows` | stage เดียวกันสองแถว | 422 field `stage_code` "duplicate stage" | FR-208 | 🆕 |
| BE-TIM-058 | `test_csv_rejects_row_with_extra_columns` | แถวที่มีคอลัมน์เกิน | 422 field `row` "has too many columns" | FR-208 | 🆕 |
| BE-TIM-059 | `test_csv_with_only_a_header_is_rejected` | ไฟล์ที่มีแต่ header | 422 "CSV must contain at least one data row" | FR-208 | 🆕 |
| BE-TIM-060 | `test_csv_accepts_utf8_bom` | ไฟล์ที่ขึ้นต้นด้วย BOM (Excel บันทึกแบบนี้) | import สำเร็จ | FR-208 | 🆕 |
| BE-TIM-061 | `test_csv_rejects_non_utf8_payload` | ไบต์ที่ decode UTF-8 ไม่ได้ | 422 "CSV ต้องเข้ารหัสเป็น UTF-8" | FR-208 | 🆕 |
| BE-TIM-062 | `test_csv_partial_upload_creates_a_full_36_stage_version` | CSV 3 แถว | version ใหม่มี 36 entries (merge กับ current) | FR-205, FR-208 | 🆕 |

---

## 9. Experiments — `api/routes/experiments.py`

ไฟล์เป้าหมาย: `backend/tests/test_experiments.py`

### 9.1 Batch

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-EXP-001 | `test_batch_lot_and_embryos_are_created_atomically` | สร้าง batch + lot 5 ตัวอ่อน | ทุกอย่างเห็นพร้อมกัน; embryoCode = `{batchCode}_{lotNo}_{n}` | FR-301, FR-308 | ✅ |
| BE-EXP-002 | `test_required_batch_fields_are_enforced` | ขาด `experimentDate`/`siteId`/`operatorId`/`protocolId`/`treatmentGroupId` ทีละตัว | 422 "ต้องระบุ &lt;field&gt;" | FR-302 | ➕ |
| BE-EXP-003 | `test_experiment_date_must_be_iso_date` | `experimentDate="01/02/2026"` | 422 "experimentDate ต้องเป็น YYYY-MM-DD" | FR-302 | ➕ |
| BE-EXP-004 | `test_foreign_keys_must_reference_active_records` | ส่ง `siteId`/`treatmentGroupId`/`csofLotId`/`recipientEggLotId` ที่ปิดใช้งาน | 422 "ไม่พบ &lt;field&gt; ที่ active" ทีละตัว | FR-302 | ➕ |
| BE-EXP-005 | `test_day_no_and_replicate_no_must_be_positive_integers` | 0, −1, 1.5, `true` | 422 ทุกกรณี | FR-303 | ➕ |
| BE-EXP-006 | `test_incubation_temp_bounds` | −1, 51, NaN, `"28"` | 422; ค่า 0 และ 50 ยอมรับได้ | FR-303 | ➕ |
| BE-EXP-007 | `test_batch_code_and_clutch_code_length_limits` | batchCode 101 ตัว; clutchCode 51 ตัว; ค่าว่าง | 422 | FR-303 | 🆕 |
| BE-EXP-008 | `test_batch_code_is_generated_when_omitted` | ไม่ส่ง `batchCode` | ได้ `{dayNo}_{operatorName}_{treatmentCode}` โดยช่องว่างถูกแทนด้วย `-` | FR-304 | ➕ |
| BE-EXP-009 | `test_day_no_auto_increments_per_operator_protocol_and_group` | สร้าง batch 3 รอบด้วยชุดเดียวกัน | dayNo = 1,2,3; ชุดอื่นเริ่มที่ 1 ใหม่ | FR-304 | 🆕 |
| BE-EXP-010 | `test_duplicate_batch_code_is_rejected` | สร้าง batchCode ซ้ำ (ต่างตัวพิมพ์) | 409 `conflict` | FR-303 | ➕ DB |
| BE-EXP-011 | `test_batches_always_pin_current_timing_and_cannot_be_rebound` | สร้าง batch → PATCH `protocolId` ใหม่ | 409 `invalid_state`; `timingProfileId` เดิมคงอยู่ | AC-204 | ✅ |
| BE-EXP-012 | `test_batch_creation_requires_a_current_timing_profile` | protocol ที่ไม่มี current profile | 422 "ไม่พบ timing profile" | FR-302 | 🆕 |
| BE-EXP-013 | `test_batch_filter_and_update_validate_the_public_contract` | filter ทุกตัว: `dateFrom/dateTo/batchId/siteId/operatorId/treatmentGroupId/donorCellLineId/strain` | คืนเฉพาะที่ตรงเงื่อนไข | FR-305 | ✅ |
| BE-EXP-014 | `test_strain_filter_matches_case_insensitively_through_lots` | strain ต่างตัวพิมพ์ | ยัง match | FR-305 | 🆕 |
| BE-EXP-015 | `test_batch_list_is_sorted_newest_first_and_paginates` | หลาย batch ต่างวันที่ | เรียง `experimentDate` desc, tie-break `batchCode` desc; cursor เดินครบ | FR-305 | ➕ |
| BE-EXP-016 | `test_batch_update_preserves_inactive_historical_references` | batch ที่อ้าง master ที่ปิดใช้งานภายหลัง แล้ว PATCH ฟิลด์อื่น | ผ่าน ไม่ถูกบังคับให้เปลี่ยน reference | FR-111 | ✅ |
| BE-EXP-017 | `test_get_batch_returns_nested_lots_and_embryos_sorted` | batch + 2 lot + embryo | `injectionLots` เรียงตาม `lotNo`, `embryos` เรียงตาม `seqInLot`; ไม่รวมที่ soft delete | FR-306 | ➕ |
| BE-EXP-018 | `test_get_batch_404_for_missing_or_deleted_batch` | id มั่ว / batch ที่ปิดใช้งาน | 404 | FR-306 | 🆕 |

### 9.2 Duplicate batch

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-EXP-030 | `test_duplicate_batch_lot_template_can_be_activated_once` | duplicate พร้อม `copyInjectionLots=true` → activate | lot สำเนามี `activatedAt=null`, `nActivated=0`; activate ได้ครั้งเดียว | FR-309 | ✅ |
| BE-EXP-031 | `test_duplicate_generates_a_unique_batch_code_instead_of_conflicting` | duplicate โดยไม่ให้ batchCode | ต่อท้ายด้วย 8 ตัวแรกของ id ใหม่ ไม่ใช่ 409 | FR-309 | ➕ |
| BE-EXP-032 | `test_duplicate_does_not_copy_lots_by_default` | ไม่ส่ง `copyInjectionLots` | batch ใหม่ไม่มี lot | FR-309 | 🆕 |
| BE-EXP-033 | `test_duplicate_resets_enu_and_activation_fields` | lot ต้นทางมี ENU ครบ | สำเนามี `enuStartAt/enuFinishAt/activatedAt = null` | FR-309 | ➕ |
| BE-EXP-034 | `test_duplicate_of_a_missing_batch_returns_404` | id มั่ว | 404 | FR-309 | 🆕 |
| BE-EXP-035 | `test_duplicate_uses_the_supplied_experiment_date_and_day_no` | ส่ง `experimentDate`, `dayNo` | ใช้ค่าที่ส่ง ไม่ใช่ของต้นฉบับ | FR-309 | 🆕 |

### 9.3 Injection lot

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-EXP-050 | `test_lot_requires_lot_no_donor_activated_at_and_n_activated` | ขาดทีละตัว | 422 | FR-307 | ➕ |
| BE-EXP-051 | `test_lot_no_must_be_a_string_within_20_characters` | 21 ตัว / ตัวเลข | 422 | FR-307 | 🆕 |
| BE-EXP-052 | `test_lot_rejects_fractional_counts_without_leaving_partial_data` | `nActivated=5.5` | 422 และไม่มี lot/embryo ถูกสร้าง | FR-307 | ✅ |
| BE-EXP-053 | `test_n_activated_bounds_are_zero_to_96` | −1, 97 | 422; 0 และ 96 ยอมรับ | FR-308 | ➕ |
| BE-EXP-054 | `test_enu_numeric_bounds` | `enuPowerPct=101`, `enuPulseUs=-1`, `enuLed=-1`, `nEggs=-1` | 422 "ค่าจำนวนอยู่นอกช่วงที่กำหนด" | FR-307 | ➕ |
| BE-EXP-055 | `test_enu_after_activation_is_warning_not_rejection` | `enuFinishAt` > `activatedAt` | 201 พร้อม `warnings[0]` | FR-307 | ✅ |
| BE-EXP-056 | `test_enu_finish_before_start_is_rejected` | finish ≤ start | 422 | FR-307 | ➕ |
| BE-EXP-057 | `test_well_positions_must_be_unique_and_in_a1_to_h12` | `["A0"]`, `["I1"]`, `["A13"]`, ซ้ำกัน, ไม่ใช่ list, จำนวนเกิน `nActivated` | 422 ทุกกรณี | FR-310 | ➕ |
| BE-EXP-058 | `test_well_positions_are_assigned_in_sequence_order` | 3 well กับ 5 ตัวอ่อน | ตัวอ่อน 1–3 ได้ well ตามลำดับ, 4–5 เป็น `null` | FR-310 | ➕ |
| BE-EXP-059 | `test_duplicate_lot_no_within_a_batch_is_rejected` | lotNo ซ้ำในหมายเลข batch เดียวกัน (ต่างตัวพิมพ์) | 409 "lotNo ซ้ำใน batch" | FR-307 | ➕ |
| BE-EXP-060 | `test_same_lot_no_is_allowed_in_a_different_batch` | lotNo `L1` ใน 2 batch | สำเร็จทั้งคู่ | FR-307 | 🆕 |
| BE-EXP-061 | `test_lot_creation_on_a_missing_batch_returns_404` | batch id มั่ว | 404 | FR-307 | 🆕 |
| BE-EXP-062 | `test_uat_batch_three_lots_create_fifteen_embryos_without_partial_lots` | 1 batch, 3 lot × 5 | 15 embryo, รหัสเรียงลำดับ, ไม่มี lot ที่ค้างครึ่ง | T-01 | ✅ |
| BE-EXP-063 | `test_activating_a_template_twice_is_rejected` | activate lot ที่มี `activatedAt` แล้ว | 409 `invalid_state` | FR-309 | ✅ |
| BE-EXP-064 | `test_activation_requires_activated_at_and_n_activated` | PATCH ที่ขาดค่าใดค่าหนึ่ง | 422 | FR-309 | ➕ |
| BE-EXP-065 | `test_activation_ignores_fields_outside_the_allowed_set` | PATCH พร้อม `batchId`, `lotNo` ใหม่ | ค่าเหล่านั้นไม่เปลี่ยน | FR-309 | 🆕 |
| BE-EXP-066 | `test_activation_of_a_lot_whose_batch_is_deleted_is_rejected` | soft delete batch ก่อน | 409 `invalid_state` | FR-309 | 🆕 |

### 9.4 Embryo

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-EXP-080 | `test_list_lot_embryos_sorted_and_alive_only_filter` | lot ที่มีทั้งตัวรอดและตัวที่มี `exitReason` | ไม่มี filter = ทั้งหมด; `aliveOnly=true` = เฉพาะที่ไม่มี exit; เรียงตาม `seqInLot` | FR-308 | ➕ |
| BE-EXP-081 | `test_list_embryos_404_for_missing_or_inactive_lot` | lot id มั่ว | 404 | FR-308 | 🆕 |
| BE-EXP-082 | `test_add_embryos_continues_the_sequence` | lot ที่มี 5 ตัว, `count=3` | ได้ seq 6,7,8 พร้อม embryoCode ต่อเนื่อง | FR-308 | 🆕 |
| BE-EXP-083 | `test_add_embryos_requires_an_activated_lot` | lot template ที่ยังไม่ activate | 409 "ต้อง activate injection lot template ก่อนเพิ่ม embryo" | FR-308 | 🆕 |
| BE-EXP-084 | `test_add_embryos_validates_count_type_and_total_cap` | `count=0`, `count=true`, `count="3"`, ยอดรวมเกิน 96 | 422 ทุกกรณี | FR-308 | 🆕 |
| BE-EXP-085 | `test_add_embryos_counts_soft_deleted_rows_in_the_sequence` | ลบตัวที่ 5 แล้วเพิ่ม 1 | ตัวใหม่ได้ seq 6 (ไม่ reuse) | FR-308 | 🆕 |
| BE-EXP-086 | `test_add_embryos_404_or_409_for_broken_parents` | lot ที่ถูกลบ / batch หาย | 404 / 409 ตามลำดับ | FR-308 | 🆕 |
| BE-EXP-087 | `test_embryo_patch_only_changes_a_unique_valid_well` | PATCH `wellPosition` ที่ถูกต้อง / ซ้ำในล็อต / นอกช่วง / PATCH ฟิลด์อื่น | สำเร็จ / 409 / 422 / ฟิลด์อื่นไม่เปลี่ยน | FR-310 | ✅ DB |
| BE-EXP-088 | `test_embryo_well_can_be_cleared_to_null` | PATCH `{"wellPosition": null}` | สำเร็จ, well ว่าง | FR-310 | 🆕 |
| BE-EXP-089 | `test_deleted_embryo_frees_its_well_for_reuse` | ลบตัวอ่อนแล้วย้ายตัวอื่นมาที่ well เดิม | สำเร็จ | FR-310 | ➕ DB |
| BE-EXP-090 | `test_delete_embryo_is_a_soft_delete_with_audit` | DELETE | 204; record มี `active=false`, `deletedAt`; audit `UPDATE` มี before/after | BR-17 | ➕ |
| BE-EXP-091 | `test_delete_missing_embryo_returns_404` | id มั่ว | 404 | FR-308 | 🆕 |

### 9.5 Control arm counts

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-EXP-100 | `test_control_replacement_validates_all_rows_and_revives_soft_deleted` | PUT ชุดใหม่ที่มีแถวเคยถูกลบ | แถวเดิมถูกเปิดใช้อีกครั้ง; แถวที่หายไปจากชุดถูก soft delete | FR-701 | ✅ |
| BE-EXP-101 | `test_control_counts_return_canonical_labels_in_deterministic_order` | GET หลัง PUT | เรียงตาม `stageOrder` แล้ว `armType`; มี `stageLabel` | FR-702 | ✅ |
| BE-EXP-102 | `test_control_arm_type_and_stage_code_are_validated` | `armType="SCNT"` (ไม่อนุญาต), stageCode นอก 1–36 | 422 "armType or stageCode is invalid" | FR-701 | ➕ |
| BE-EXP-103 | `test_control_counts_must_be_non_negative_integers` | `nNormal=-1`, `nAbnormal=1.5`, `true` | 422 | FR-701 | ➕ |
| BE-EXP-104 | `test_duplicate_arm_and_stage_pair_is_rejected` | สองแถวคีย์เดียวกัน | 422 "duplicate armType and stageCode" | FR-701 | ➕ |
| BE-EXP-105 | `test_control_items_must_be_a_list_of_objects` | `items` ไม่ใช่ list / สมาชิกไม่ใช่ object | 422 | FR-701 | 🆕 |
| BE-EXP-106 | `test_control_put_on_missing_batch_returns_404` | batch id มั่ว | 404 | FR-701 | 🆕 |
| BE-EXP-107 | `test_empty_control_list_soft_deletes_every_existing_row` | PUT `{"items": []}` | ทุกแถวถูกปิด, GET คืนรายการว่าง | FR-701 | 🆕 |
| BE-EXP-108 | `test_control_changes_are_audited_per_row` | PUT ที่แก้ 1 แถวและลบ 1 แถว | audit มี UPDATE ทั้งสองแถวพร้อม before/after | FR-1100 | 🆕 |

---

## 10. Observations (Stage 1) — `api/routes/observations.py`

ไฟล์เป้าหมาย: `backend/tests/test_observations.py`

### 10.1 Due checkpoints

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-OBS-001 | `test_due_queue_honors_dashboard_batch_and_date_filters` | filter ทั้ง 8 ตัว | คืนเฉพาะที่ตรง | FR-401 | ✅ |
| BE-OBS-002 | `test_overdue_is_sorted_by_lateness_and_upcoming_by_due_time` | หลาย lot ต่างเวลา | `overdue` เรียง `minutesLate` มาก→น้อย; `upcoming` เรียง `dueAt` เพิ่มขึ้น | BR-07 | ➕ CLOCK |
| BE-OBS-003 | `test_only_one_upcoming_checkpoint_per_lot_is_returned` | lot ที่ยังไม่ถึงหลาย stage | มีรายการ upcoming แค่ stage ถัดไปเท่านั้น | BR-07 | ➕ |
| BE-OBS-004 | `test_due_and_checkpoint_read_models_track_original_and_surviving_embryos` | บันทึกตายบางตัว | `embryosRemaining` ลดลง, `totalEmbryos` เท่าเดิม | FR-402 | ✅ |
| BE-OBS-005 | `test_lots_without_activation_or_embryos_are_not_due` | lot template, lot ที่ไม่มีตัวอ่อน, lot ที่ตัวอ่อนออกหมด | ไม่ปรากฏในคิว | BR-07 | ➕ |
| BE-OBS-006 | `test_due_uses_the_batch_pinned_timing_profile` | สร้าง timing version ใหม่หลัง batch | `dueAt` ยังคำนวณจาก snapshot เดิม | BR-03 | ✅ |
| BE-OBS-007 | `test_due_stops_at_stage_26` | lot ที่ observe ถึง stage 26 | ไม่มี stage 27+ ในคิว | BR-09 | 🆕 |
| BE-OBS-008 | `test_pending_promotion_count_is_returned_with_the_queue` | ตัวอ่อนที่ครบเกณฑ์ | `pendingPromotionCount` ตรงกับจำนวนจริง | FR-501 | ➕ CLOCK |
| BE-OBS-009 | `test_uat_t04_reports_exactly_twenty_five_minutes_late` | activate แล้วเลื่อนเวลาให้เกิน 25 นาที | `minutesLate == 25` | T-04 | ✅ CLOCK |

### 10.2 Checkpoint read model

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-OBS-010 | `test_checkpoint_and_bulk_observation_snapshot_timing` | `GET /injection-lots/{id}/checkpoints/{stageCode}` | `activatedAt`, `expectedHpa`, `dueAt`, `stages` 26 รายการ | BR-01, BR-03 | ✅ |
| BE-OBS-011 | `test_checkpoint_404_and_422_boundaries` | lot มั่ว → 404; `stageCode` นอกช่วง → 422 | ตามที่ระบุ | FR-402 | ➕ |
| BE-OBS-012 | `test_checkpoint_returns_prior_outcome_and_default_condition` | ตัวอ่อนที่เคยบันทึก ABNORMAL | `defaultCondition="ABNORMAL"`, `priorOutcome`, `priorStageCode` ถูกต้อง | FR-403 | ✅ |
| BE-OBS-013 | `test_checkpoint_marks_dead_embryos_and_excludes_promoted_ones` | ตัวที่ตายและตัวที่ `exitReason=PROMOTED` | ตัวที่ตายมี `isDead=true` ยังแสดง; ตัวที่ promote ไม่แสดง | BR-19, BR-12 | ➕ |
| BE-OBS-014 | `test_checkpoint_entry_supports_independent_embryo_stages` | ตัวอ่อนอยู่คนละ stage | คืนข้อมูลถูกต้องรายตัว | FR-404 | ✅ |
| BE-OBS-015 | `test_checkpoint_exposes_first_abnormal_stage_label` | ตัวอ่อนที่เคยผิดปกติ | `firstAbnormalStageLabel` เป็น label ที่อ่านได้ | FR-405 | ➕ |

### 10.3 Bulk create

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-OBS-020 | `test_uat_t02_saves_all_fifteen_alive_observations` | 15 รายการในคำขอเดียว | ทุกแถว `status="created"` | T-02, BR-08 | ✅ |
| BE-OBS-021 | `test_bulk_observation_shape_and_time_boundaries_are_enforced` | `observations` ไม่ใช่ list, ว่าง, 201 รายการ | 422 "observations ต้องมี 1 ถึง 200 รายการ" | BR-08 | ✅ |
| BE-OBS-022 | `test_row_level_rejections_do_not_block_valid_rows` | 3 แถวถูก 2 แถวผิด | 200 พร้อม `results` ผสม `created` และ `rejected` | FR-406 | ✅ |
| BE-OBS-023 | `test_non_object_row_is_rejected_without_client_uuid` | สมาชิกเป็น string | แถวนั้น `status="rejected"` message "รูปแบบ observation ไม่ถูกต้อง" | FR-406 | 🆕 |
| BE-OBS-024 | `test_missing_required_observation_fields_are_reported_per_field` | ขาด `embryoId`/`stageCode`/`observedAt`/`outcome`/`condition`/`clientUuid` | message "ต้องระบุ &lt;field&gt;" ตรงตัว | FR-406 | ➕ |
| BE-OBS-025 | `test_client_uuid_must_be_a_uuid` | `clientUuid="abc"` | rejected "clientUuid ต้องเป็น UUID" | BR-18 | 🆕 |
| BE-OBS-026 | `test_invalid_outcome_or_condition_is_rejected` | `outcome="MAYBE"`, `condition="ok"` | rejected "outcome หรือ condition ไม่ถูกต้อง" | FR-406 | ➕ |
| BE-OBS-027 | `test_observed_at_before_activation_is_rejected` | `observedAt` < `activatedAt` | rejected "observedAt ต้องไม่ก่อน activatedAt" | BR-01 | ✅ |
| BE-OBS-028 | `test_observed_at_more_than_five_minutes_in_the_future_is_rejected` | +6 นาที และ +4 นาที | rejected / accepted | FR-406 | ✅ CLOCK |
| BE-OBS-029 | `test_observation_on_an_inactive_lot_or_embryo_is_rejected` | soft delete lot / embryo | rejected พร้อมข้อความที่ระบุ | FR-406 | ➕ |
| BE-OBS-030 | `test_client_uuid_replayed_four_times_creates_one_audited_observation` | ส่งซ้ำ 4 ครั้ง | `status="duplicate"` ตั้งแต่ครั้งที่ 2; มี audit เดียว | BR-18, AC-1003 | ✅ |
| BE-OBS-031 | `test_same_embryo_and_stage_is_deduplicated_even_with_a_new_client_uuid` | clientUuid ใหม่ แต่ embryo+stage เดิม | `status="duplicate"` คืน id เดิม | BR-18 | ➕ |
| BE-OBS-032 | `test_duplicate_response_recomputes_deviation_labels_and_percentage` | replay | `deviationLabel`, `deviationLabelEn`, `deviationPct` ครบ; `deviationPct=null` เมื่อ expected = 0 | BR-23 | 🆕 |
| BE-OBS-033 | `test_computed_hpa_expected_and_deviation_use_the_pinned_profile` | override expectedHpa ใน profile ของ batch | `hpaExpectedSnapshot` มาจาก profile นั้น ไม่ใช่ค่า default | BR-03 | ✅ |
| BE-OBS-034 | `test_interval_metrics_are_derived_from_the_previous_stage` | บันทึก stage 3 หลัง stage 2 | `intervalActual/Expected/DeviationH` ถูกต้อง; stage แรกไม่มีคีย์เหล่านี้ | BR-04 | ➕ |
| BE-OBS-035 | `test_backdated_observation_is_flagged` | `observedAt` ย้อน 20 นาที | `isBackdated=true`; 10 นาที → `false` | BR-22 | ➕ CLOCK |
| BE-OBS-036 | `test_exit_recorded_flag_matches_terminal_outcomes` | outcome `DEAD`/`DEGENERATED`/`ALIVE`/`NOT_OBSERVED` | `exitRecorded` = true เฉพาะสองตัวแรก | BR-19 | ➕ |
| BE-OBS-037 | `test_partial_checkpoint_save_remains_due_until_every_active_embryo_is_recorded` | บันทึกบางตัว | checkpoint ยังอยู่ในคิว | FR-407 | ✅ |

### 10.4 Monotonic survival & lifecycle

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-OBS-040 | `test_dead_embryo_rejects_later_observation_even_with_override` | ตายที่ stage 5 แล้วส่ง stage 6 | rejected "ตัวอ่อนตายแล้ว…" | BR-19, AC-406 | ✅ |
| BE-OBS-041 | `test_dead_embryo_rejects_a_later_timestamp_at_the_same_stage` | เวลาหลังเวลาตาย stage เดิม | rejected | BR-19 | ➕ |
| BE-OBS-042 | `test_earlier_stage_before_the_death_is_still_accepted` | บันทึก stage 3 หลังจากบันทึกตายที่ stage 5 (เวลาก่อนหน้า) | accepted | BR-20 | ✅ |
| BE-OBS-043 | `test_terminal_observation_is_the_earliest_death_not_the_latest` | มีการบันทึกตายสองครั้ง | `exitAt` = ครั้งที่เกิดก่อน | BR-19 | ➕ |
| BE-OBS-044 | `test_monotonic_survival_allows_earlier_observation_but_never_later_resurrection` | ลำดับบันทึกสลับ | survival ไม่เพิ่มขึ้น | BR-20 | ✅ |
| BE-OBS-045 | `test_skipped_checkpoints_are_implied_alive_without_creating_fake_rows` | ข้าม stage 4–6 แล้วบันทึก 7 ALIVE | analytics นับ 4–6 ว่ารอด แต่ไม่มี observation row เพิ่ม | BR-21 | ✅ |
| BE-OBS-046 | `test_abnormal_observation_updates_embryo_projection` | บันทึก ABNORMAL | embryo ได้ `firstAbnormalObservationId/StageCode/StageId/On/AgeDays` | FR-405 | ✅ |
| BE-OBS-047 | `test_first_abnormal_is_the_earliest_not_the_latest` | ABNORMAL สอง stage | projection ชี้ stage ที่เกิดก่อน | FR-405 | ➕ |
| BE-OBS-048 | `test_first_abnormal_age_uses_bangkok_calendar_days` | ABNORMAL ข้ามเที่ยงคืนกรุงเทพ | `firstAbnormalAgeDays` นับตามวันปฏิทิน | BR-06 | 🆕 CLOCK |

### 10.5 Correction & soft delete

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-OBS-050 | `test_observation_duplicate_and_delete_requires_reason` | DELETE ไม่มี `reason` | 422 "reason is required" | BR-17, FR-1101 | ✅ |
| BE-OBS-051 | `test_delete_soft_deletes_and_records_the_reason` | DELETE พร้อม reason | 204; row มี `deletedAt`, `overrideReason`; audit `DELETE` | BR-17 | ✅ |
| BE-OBS-052 | `test_correction_only_changes_public_fields_and_deleted_observations_stay_deleted` | PATCH ที่พยายามแก้ `hpaActual`, `embryoId` | ฟิลด์เหล่านั้นไม่เปลี่ยน; observation ที่ลบแล้ว PATCH ได้ 404 | FR-1101 | ✅ |
| BE-OBS-053 | `test_correction_requires_a_reason` | PATCH ไม่มี `correctionReason`/`overrideReason` | 422 "ต้องระบุ correctionReason" | FR-1101 | ➕ |
| BE-OBS-054 | `test_correction_recomputes_hpa_deviation_and_interval` | แก้ `observedAt` | `hpaActual`, `deviationH`, `interval*` คำนวณใหม่ แต่ `hpaExpectedSnapshot` คงเดิม | BR-03, BR-04 | ✅ |
| BE-OBS-055 | `test_correction_can_reopen_an_embryo_by_changing_a_death_to_alive` | แก้ outcome DEAD → ALIVE | embryo หมด `exitReason`; checkpoint กลับมาอยู่ในคิว | BR-19 | ➕ |
| BE-OBS-056 | `test_correcting_the_terminal_observation_is_exempt_from_the_dead_guard` | PATCH ตัวที่เป็น terminal เอง | ไม่ถูกปฏิเสธด้วยกฎ "ตายแล้ว" | BR-19 | ➕ |
| BE-OBS-057 | `test_interval_metrics_are_cleared_when_no_earlier_stage_remains` | ลบ observation ก่อนหน้า แล้วแก้ตัวถัดไป | คีย์ `interval*` หายไป ไม่ค้างค่าเก่า | BR-04 | 🆕 |
| BE-OBS-058 | `test_deleting_an_observation_recomputes_the_embryo_projection_and_audits_both` | ลบ observation ที่เป็น first abnormal | embryo หมด `firstAbnormal*`; มี audit ทั้ง observation และ embryo | FR-1101 | ✅ |
| BE-OBS-059 | `test_correction_on_a_missing_observation_returns_404` | id มั่ว | 404 | FR-1101 | 🆕 |

---

## 11. Promotion, fish & specimens — `api/routes/fish.py`, `services/fish.py`

ไฟล์เป้าหมาย: `backend/tests/test_fish.py`, `backend/tests/test_fish_observations.py` *(ใหม่)*

### 11.1 Pending promotions

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-FSH-001 | `test_pending_promotions_lists_only_eligible_embryos` | ตัวอ่อนอายุครบ/ไม่ครบ/ตาย/promote แล้ว | เห็นเฉพาะที่เข้าเกณฑ์ BR-09 | BR-09 | ➕ CLOCK |
| BE-FSH-002 | `test_pending_promotions_filters_by_site` | `?siteId=` | คืนเฉพาะ site นั้น | FR-501 | 🆕 |
| BE-FSH-003 | `test_pending_promotion_uses_protocol_stage1_max_age` | protocol ที่ `stage1MaxAgeDays=3` | เข้าเกณฑ์เร็วขึ้นตามที่ตั้ง | BR-09 | 🆕 CLOCK |
| BE-FSH-004 | `test_promotion_threshold_never_falls_below_one_day` | protocol ที่ `stage1MaxAgeDays=0` | ใช้ค่า 1 | BR-09 | 🆕 |
| BE-FSH-005 | `test_suggested_running_numbers_are_sequential_within_one_response` | 3 ตัวเข้าเกณฑ์ | `suggestedRunningNo` ต่อเนื่องจาก `next_fish_no` | BR-10 | 🆕 |
| BE-FSH-006 | `test_suggested_fish_code_format` | ตัวอ่อน seq 3, strain `AB`, activated วันที่ 07 | `No.{n}_Clone3-AB cell-07`; strain ว่าง → `unknown` | BR-11 | 🆕 |
| BE-FSH-007 | `test_pending_promotion_carries_abnormality_context` | ตัวอ่อนที่เคย ABNORMAL | `firstAbnormalOn/AgeDays/StageCode/StageLabel` ครบ | BR-13 | ➕ |

### 11.2 Bulk promotion

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-FSH-010 | `test_promotion_allocates_running_number_and_closes_embryo` | promote 1 ตัว | fish `runningNo` ใหม่, embryo `exitReason=PROMOTED` + `exitAt` | BR-10, BR-12 | ✅ |
| BE-FSH-011 | `test_abnormal_promotion_inherits_first_marker_and_replays_idempotently` | ตัวอ่อน ABNORMAL, ส่งซ้ำ | fish `condition="ABNORMAL"` + `firstAbnormalSource="embryo"`; ครั้งที่สอง `status="duplicate"` | BR-13, BR-18 | ✅ |
| BE-FSH-012 | `test_promotion_rejects_an_unknown_fish_box_without_closing_embryo` | `fishBoxId` มั่ว | แถว rejected; embryo ยังไม่ถูกปิด | BR-14 | ✅ |
| BE-FSH-013 | `test_promotion_rejects_a_fish_box_from_another_site` | box ที่ `siteId` ต่าง | rejected "ไม่พบ fishBoxId ที่ active ใน site นี้" | BR-14 | 🆕 |
| BE-FSH-014 | `test_promotion_accepts_a_site_agnostic_box` | box ที่ไม่มี `siteId` | สำเร็จ | BR-14 | 🆕 |
| BE-FSH-015 | `test_promotion_rejects_an_ineligible_embryo` | ตัวอ่อนที่ตาย / อายุไม่ถึง / ไม่มี observation | rejected "embryo ยังไม่เข้าเกณฑ์เลื่อนขั้น" | BR-09 | ➕ |
| BE-FSH-016 | `test_promotion_rejects_an_invalid_client_uuid` | `clientUuid="x"` | rejected "clientUuid ต้องเป็น UUID" | BR-18 | 🆕 |
| BE-FSH-017 | `test_promotion_rejects_a_duplicate_fish_code` | ส่ง `fishCode` ที่มีอยู่แล้ว (ต่างตัวพิมพ์) | rejected "fishCode ซ้ำกับรายการเดิม" | BR-11 | 🆕 |
| BE-FSH-018 | `test_promotions_body_must_be_a_non_empty_list` | `promotions` ว่าง / ไม่ใช่ list | 422 | FR-502 | 🆕 |
| BE-FSH-019 | `test_concurrent_promotions_allocate_unique_running_numbers` | promote พร้อมกัน | ไม่มีเลขซ้ำ | BR-10 | ✅ DB |
| BE-FSH-020 | `test_promotion_writes_both_fish_insert_and_embryo_update_audits` | promote | audit 2 แถว | FR-1100 | ➕ |

### 11.3 Fish registry

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-FSH-030 | `test_fish_list_supports_every_documented_filter` | filter ทั้ง 13 ตัว (`status`, `siteId`, `boxId`, `treatmentGroupId`, `batchId`, `operatorId`, `dateFrom/To`, `donorCellLineId`, `strain`, `condition`, `dobFrom/To`) | คืนเฉพาะที่ตรงเงื่อนไข ทีละตัวและรวมกัน | FR-602 | ➕ |
| BE-FSH-031 | `test_strain_filter_is_a_case_insensitive_substring_match` | strain `"ab"` กับข้อมูล `"ABC"` | match | FR-602 | 🆕 |
| BE-FSH-032 | `test_fish_list_is_sorted_by_running_number_and_paginates` | 250 ตัว | เรียงตาม `runningNo`, cursor เดินครบ, cursor ผิด → 400 | FR-602 | ➕ |
| BE-FSH-033 | `test_enriched_fish_exposes_derived_context` | fish ที่มาจาก promotion | `ageDays`, `strain`, `fishBoxCode`, `treatmentGroup(Id)`, `batchId/Code`, `operatorId` ครบ | FR-603 | ➕ |
| BE-FSH-034 | `test_enriched_fish_age_falls_back_to_zero_for_unusable_dob` | fish ที่ `dob` เสีย | `ageDays=0` ไม่ระเบิด | FR-603 | 🆕 |
| BE-FSH-035 | `test_get_fish_returns_observations_specimens_and_embryo_timeline` | fish ที่มีทั้งสามอย่าง | ทุกรายการเรียงตามเวลา และไม่รวมที่ถูกลบ | FR-604 | ➕ |
| BE-FSH-036 | `test_get_fish_404_for_missing_or_deleted_fish` | id มั่ว | 404 | FR-604 | 🆕 |
| BE-FSH-037 | `test_partial_fish_update_preserves_box_and_accepts_contract_fields` | PATCH `sex`/`finClipped`/`remarks`/`fishCode`/`fishBoxId` | อัปเดตเฉพาะที่ส่ง; `fishBoxId` ไม่ถูกล้างเมื่อไม่ส่ง | FR-605 | ✅ |
| BE-FSH-038 | `test_fish_update_rejects_fields_outside_the_allowed_set` | PATCH `status`, `dob` | 422 "แก้ไข field นี้ไม่ได้: &lt;field&gt;" | FR-605 | ➕ |
| BE-FSH-039 | `test_empty_fish_update_body_is_rejected` | PATCH `{}` | 422 "ต้องระบุข้อมูลที่ต้องการแก้ไข" | FR-605 | 🆕 |
| BE-FSH-040 | `test_fish_update_validates_sex_fin_clipped_and_blank_code` | `sex="X"`, `finClipped="yes"`, `fishCode="  "` | 422 ทีละกรณี | FR-605 | 🆕 |
| BE-FSH-041 | `test_fish_box_can_be_cleared_with_null` | PATCH `{"fishBoxId": null}` | `fishBoxId=None` | FR-605 | 🆕 |
| BE-FSH-042 | `test_fish_update_rejects_a_duplicate_or_inactive_box` | fishCode ซ้ำ → 409; box ที่ปิด → 422 | ตามที่ระบุ | FR-605 | ➕ |

### 11.4 Manual fish registration

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-FSH-050 | `test_manual_fish_requires_reason_when_backdated_and_roll_call_tracks_write` | `dob` เมื่อวาน ไม่มี `overrideReason` | 422 "ต้องระบุ overrideReason เมื่อเพิ่มปลาย้อนหลัง" | FR-606 | ✅ CLOCK |
| BE-FSH-051 | `test_manual_fish_rejects_a_future_dob` | `dob` พรุ่งนี้ (กรุงเทพ) | 422 "dob ห้ามอยู่ในอนาคต" | FR-606 | ➕ CLOCK |
| BE-FSH-052 | `test_manual_fish_requires_code_dob_and_donor` | ขาดทีละตัว | 422 "ต้องระบุ &lt;field&gt;" | FR-606 | ➕ |
| BE-FSH-053 | `test_manual_fish_validates_dob_format` | `dob="2026/01/01"` | 422 "dob ต้องเป็น YYYY-MM-DD" | FR-606 | 🆕 |
| BE-FSH-054 | `test_manual_fish_requires_active_donor_site_and_box` | อ้างรายการที่ปิดใช้งาน | 422 ทีละฟิลด์ | FR-606 | ➕ |
| BE-FSH-055 | `test_manual_fish_rejects_duplicate_code_and_invalid_enums` | fishCode ซ้ำ → 409; `condition`/`sex` ผิด → 422 | ตามที่ระบุ | FR-606 | ➕ |
| BE-FSH-056 | `test_manual_fish_defaults_status_condition_sex_and_fin_clipped` | สร้างโดยไม่ส่งค่า | `ALIVE`/`NORMAL`/`UNKNOWN`/`false` | FR-606 | 🆕 |
| BE-FSH-057 | `test_manual_fish_is_not_counted_as_promoted` | สร้าง manual + promote 1 ตัว | analytics `nPromoted` นับเฉพาะที่มี `embryoId` | FR-802 | ✅ |
| BE-FSH-058 | `test_manual_fish_override_reason_is_stored_in_the_audit_not_the_record` | สร้างย้อนหลังพร้อมเหตุผล | fish record ไม่มี `overrideReason`; audit `newValues` มี | FR-1102 | 🆕 |

### 11.5 Roll-call (Stage 2)

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-FSH-070 | `test_roll_call_only_returns_alive_fish_and_validates_specimen_dates` | ปลาที่ตายแล้ว | ไม่อยู่ในรายชื่อของวันหลังวันตาย | BR-15 | ✅ |
| BE-FSH-071 | `test_roll_call_defaults_to_today_in_bangkok` | ไม่ส่ง `date` | `date` = วันนี้ตามกรุงเทพ | BR-06 | ➕ CLOCK |
| BE-FSH-072 | `test_roll_call_rejects_an_invalid_date` | `?date=32-01-2026` | 422 "invalid Bangkok date" | BR-06 | 🆕 |
| BE-FSH-073 | `test_backdate_range_is_recorded_and_historical_risk_set_is_queryable` | ถามย้อนหลังวันก่อนปลาตาย | ปลายังอยู่ในรายชื่อ | BR-15 | ✅ |
| BE-FSH-074 | `test_roll_call_excludes_fish_before_their_dob` | ถามวันก่อน `dob` | ไม่ปรากฏ | BR-15 | ➕ |
| BE-FSH-075 | `test_roll_call_filters_by_site_and_box` | `?siteId=`, `?boxId=` | คืนเฉพาะที่ตรง | FR-607 | 🆕 |
| BE-FSH-076 | `test_roll_call_marks_already_recorded_entries` | บันทึกไปแล้ว 1 ตัว | `alreadyRecorded=true`, `observationId`, `recordedOutcome` ครบ | FR-607 | ➕ |
| BE-FSH-077 | `test_roll_call_reports_age_days_for_the_queried_date` | ถามวันย้อนหลัง | `ageDays` เทียบวันที่ถาม ไม่ใช่วันนี้ | BR-06 | ➕ |
| BE-FSH-078 | `test_roll_call_is_sorted_by_fish_code` | หลายตัว | เรียงตาม `fishCode` | FR-607 | 🆕 |

### 11.6 Fish observations

ไฟล์เป้าหมาย: `backend/tests/test_fish_observations.py` *(ใหม่ — ปิดช่องว่างใหญ่ที่สุดของ backend)*

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-FSH-090 | `test_bulk_fish_observations_create_and_close_fish` | outcome `DEAD` | `status="created"`, `fishClosed=true`, fish `status="DEAD"` + `exitDate` | FR-608 | ➕ |
| BE-FSH-091 | `test_alive_and_not_observed_keep_the_fish_open` | outcome `ALIVE` / `NOT_OBSERVED` | fish `status="ALIVE"`, ไม่มี `exitDate` | FR-608 | 🆕 |
| BE-FSH-092 | `test_observations_field_must_be_a_list` | ไม่ส่ง / ส่ง string | 422 "ต้องระบุ observations" | FR-608 | 🆕 |
| BE-FSH-093 | `test_unknown_fields_are_rejected_per_row` | ส่ง `ageDays` มาด้วย | rejected "field นี้ไม่ได้รับอนุญาต: ageDays" | FR-608 | 🆕 |
| BE-FSH-094 | `test_invalid_uuid_date_or_enum_is_rejected_per_row` | `clientUuid` ผิด / `observedOn` ผิดรูป / `outcome` ผิด / `condition` ผิด | rejected พร้อมข้อความที่กำหนด | FR-608 | ➕ |
| BE-FSH-095 | `test_observed_on_before_dob_or_in_the_future_is_rejected` | ก่อน `dob` / พรุ่งนี้ | rejected "วันที่หรือ enum ไม่ถูกต้อง" | BR-15 | ➕ CLOCK |
| BE-FSH-096 | `test_backdated_fish_observation_requires_an_override_reason` | `observedOn` เมื่อวาน ไม่มี reason | rejected "ต้องระบุ overrideReason สำหรับข้อมูลย้อนหลัง" | FR-609 | 🆕 CLOCK |
| BE-FSH-097 | `test_reopening_a_closed_fish_requires_an_override_reason` | fish `DEAD` แล้วส่ง `ALIVE` ไม่มี reason | rejected "ต้องระบุ overrideReason เมื่อแก้สถานะปลาที่ปิดแล้ว" | FR-609 | 🆕 |
| BE-FSH-098 | `test_duplicate_is_detected_by_client_uuid_or_by_fish_and_date` | ส่งซ้ำ 2 แบบ | `status="duplicate"` คืน `id`, `ageDays`, `outcome`, `condition` | BR-18 | ➕ |
| BE-FSH-099 | `test_age_days_is_computed_from_dob_in_bangkok_days` | fish dob 2026-01-01, observedOn 2026-01-11 | `ageDays=10` | BR-06 | ➕ |
| BE-FSH-100 | `test_fish_observation_records_operator_device_and_backdated_flag` | บันทึกย้อนหลัง | `operatorId`, `deviceId`, `isBackdated=true` | FR-1102 | 🆕 |
| BE-FSH-101 | `test_fish_observation_patch_requires_a_correction_reason` | PATCH ไม่มี reason | 422 "ต้องระบุ correctionReason" | FR-1101 | 🆕 |
| BE-FSH-102 | `test_fish_observation_patch_rejects_unknown_fields` | PATCH `cloneFishId` | 422 "แก้ไข field นี้ไม่ได้: cloneFishId" | FR-1101 | 🆕 |
| BE-FSH-103 | `test_fish_observation_patch_validates_enums_and_date_window` | outcome ผิด / วันก่อน dob / วันอนาคต | 422 ทีละกรณี | FR-1101 | 🆕 |
| BE-FSH-104 | `test_fish_observation_patch_recomputes_age_days_and_backdated_flag` | แก้ `observedOn` | `ageDays`, `isBackdated` คำนวณใหม่ | BR-06, BR-22 | 🆕 |
| BE-FSH-105 | `test_correcting_an_outcome_recalculates_the_fish_state` | แก้ `DEAD` → `ALIVE` | fish กลับเป็น `ALIVE`, `exitDate`/`exitReason` หายไป, audit ครบสองแถว | FR-1101 | 🆕 |
| BE-FSH-106 | `test_deleting_only_exit_observation_reopens_fish` | ลบ observation ที่ปิดปลา | fish กลับเป็น `ALIVE` | FR-1101 | ✅ |
| BE-FSH-107 | `test_fish_observation_delete_requires_a_reason` | DELETE ไม่มี `reason` | 422 "reason is required" | BR-17 | ➕ |
| BE-FSH-108 | `test_deleted_fish_observation_cannot_be_patched` | PATCH หลังลบ | 404 | FR-1101 | 🆕 |

### 11.7 Specimens

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-FSH-120 | `test_specimen_can_mark_fin_clipped` | สร้าง specimen ด้วย `markFinClipped=true` | fish `finClipped=true` + audit UPDATE | BR-16 | ✅ |
| BE-FSH-121 | `test_specimen_requires_code_kind_and_type` | ขาดทีละตัว | 422 "ต้องระบุ &lt;field&gt;" | BR-16 | ➕ |
| BE-FSH-122 | `test_specimen_kind_and_type_enums` | `specimenKind="XX"`, `specimenType="OTHER"` | 422 | BR-16 | ➕ |
| BE-FSH-123 | `test_specimen_dates_must_be_iso_and_not_in_the_future` | `collectedOn="x"`, `frozenOn` พรุ่งนี้ | 422 ทีละกรณี | BR-16 | ✅ CLOCK |
| BE-FSH-124 | `test_frozen_on_cannot_precede_collected_on` | frozen < collected | 422 "frozenOn ต้องไม่ก่อน collectedOn" | BR-16 | ✅ |
| BE-FSH-125 | `test_storage_requires_frozen_on_and_an_allowed_value` | `storage="-80"` ไม่มี `frozenOn`; `storage="-40"` | 422 ทั้งคู่ | BR-16 | 🆕 |
| BE-FSH-126 | `test_specimen_code_is_unique_case_insensitively` | code ซ้ำต่างตัวพิมพ์ | 409 "specimenCode ซ้ำ" | BR-16 | 🆕 |
| BE-FSH-127 | `test_specimen_on_a_missing_fish_returns_404` | fish id มั่ว | 404 | BR-16 | 🆕 |
| BE-FSH-128 | `test_list_specimens_excludes_deleted_rows` | soft delete 1 รายการ | ไม่ปรากฏใน `GET /fish/{id}/specimens` | BR-17 | 🆕 |

### 11.8 Fish service — `services/fish.py`

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-SVC-001 | `test_fish_was_alive_on_uses_exit_date_boundary` | ปลาที่ตายวันที่ D | `D-1`→True, `D`→False, `D+1`→False; ปลาที่ `status=ALIVE`→True เสมอ; `exitDate` เสีย→False | BR-15 | 🆕 |
| BE-SVC-002 | `test_recompute_fish_uses_the_latest_observation_by_date` | observation หลายวัน | ใช้ตัวที่วันที่มากสุด | FR-608 | ➕ |
| BE-SVC-003 | `test_recompute_fish_clears_exit_when_no_observations_remain` | ลบ observation ทั้งหมด | `status="ALIVE"`, ไม่มี `exitDate`/`exitReason` | FR-1101 | ➕ |
| BE-SVC-004 | `test_fish_abnormality_prefers_the_earliest_source` | ปลา ABNORMAL จาก embryo (D1) และจาก fish observation (D0) | ใช้ D0 พร้อม `firstAbnormalSource="fish"` | BR-13 | 🆕 |
| BE-SVC-005 | `test_fish_abnormality_falls_back_to_the_inherited_embryo_marker` | ไม่มี ABNORMAL ระดับปลา | ใช้ค่าจาก embryo พร้อม `firstAbnormalSource="embryo"` | BR-13 | ➕ |
| BE-SVC-006 | `test_fish_abnormality_is_cleared_when_the_fish_source_disappears` | ลบ observation ABNORMAL ของปลาที่ไม่มี marker จาก embryo | ฟิลด์ `firstAbnormal*` ถูกลบทิ้ง ไม่ค้าง | BR-13 | 🆕 |
| BE-SVC-007 | `test_fish_box_is_assignable_matrix` | box ปกติ / ปิดใช้งาน / ถูกลบ / ต่าง site / ไม่มี site | True/False ตามตาราง BR-14 | BR-14 | 🆕 |
| BE-SVC-008 | `test_find_fish_for_embryo_ignores_deleted_fish` | soft delete ปลา แล้ว promote ตัวอ่อนเดิมอีกครั้ง | ไม่ถือว่า duplicate | BR-12 | 🆕 |

---

## 12. Analytics — `services/analytics.py`, `api/routes/analytics.py`

ไฟล์เป้าหมาย: `backend/tests/test_analytics.py`

### 12.1 ตัวกรองและโครงร่างร่วม

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-ANL-001 | `test_dashboard_endpoints_return_complete_shapes` | ทุก endpoint | โครงสร้าง response ครบตาม OpenAPI | FR-801 | ✅ |
| BE-ANL-002 | `test_dashboard_bundle_uses_one_consistent_snapshot` | เรียก `/dashboard` | ทุกส่วนมาจาก snapshot เดียว | FR-801 | ✅ |
| BE-ANL-003 | `test_analytics_fixture_matches_manual_counts_and_shared_filters` | fixture ที่นับด้วยมือได้ | ตัวเลขตรง; filter ทั้ง 8 ตัวมีผลเหมือนกันทุก endpoint | FR-801 | ✅ |
| BE-ANL-004 | `test_unknown_query_parameters_are_ignored` | `?foo=bar` | ไม่ปรากฏใน `meta.filters` และไม่กระทบผล | FR-801 | 🆕 |
| BE-ANL-005 | `test_meta_reports_filters_denominators_unknown_and_missing` | dataset ที่มีข้อมูลขาด | `meta` มี 4 ส่วนครบ; ค่าที่เป็นศูนย์ถูกตัดจาก `unknown`/`missing` | FR-803 | ✅ |
| BE-ANL-006 | `test_zero_denominator_and_missing_checkpoint_are_explicit` | dataset ว่าง | เปอร์เซ็นต์เป็น `null` ไม่ใช่ 0 หรือ error | FR-803 | ✅ |
| BE-ANL-007 | `test_group_dimensions_parses_repeated_and_comma_forms` | `?groupBy=site,strain` และ `?groupBy=site&groupBy=strain` | ผลเหมือนกัน; มิติที่ไม่รู้จักถูกตัด; ว่างเปล่าใช้ค่า default | FR-804 | 🆕 |
| BE-ANL-008 | `test_dashboard_bundle_smoke_fixture_stays_under_three_seconds` | fixture ขนาดใหญ่ | < 3 วินาที | NFR-101 | ✅ |

### 12.2 KPI, funnel, survival

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-ANL-020 | `test_survival_returns_twenty_six_stages_and_fractional_survival` | dataset ปกติ | 26 จุด, `surv` เป็นสัดส่วน | FR-805 | ✅ |
| BE-ANL-021 | `test_stage1_survival_does_not_increase_when_raw_alive_rises_after_a_gap` | ข้าม checkpoint | survival ไม่เพิ่ม | BR-20, BR-21 | ✅ |
| BE-ANL-022 | `test_funnel_percentages_are_relative_to_activated_count` | dataset ปกติ | `pctOfActivated` ถูกต้อง; เป็น `null` เมื่อ activated = 0 | FR-806 | ➕ |
| BE-ANL-023 | `test_kpi_counts_eggs_activated_shield_day1_and_promoted` | dataset ที่นับมือได้ | ตรงทุกตัว | FR-802 | ✅ |
| BE-ANL-024 | `test_nullable_egg_count_is_reported_without_breaking_kpi` | lot ที่ `nEggs=null` | `missing.nEggs` นับได้; `nEggs` รวมไม่ระเบิด | FR-803 | ✅ |
| BE-ANL-025 | `test_kpi_stage2_status_and_condition_breakdown` | ปลาหลายสถานะ | `nAlive/nDead/nFrozen/nDiscarded/nNormal/nAbnormal/nUndetermined` ตรง | FR-807 | ➕ |
| BE-ANL-026 | `test_mean_age_of_alive_fish_is_null_when_none_are_alive` | ปลาตายหมด | `meanAgeDaysAlive=null` | FR-807 | 🆕 |
| BE-ANL-027 | `test_abnormality_comparison_separates_unknown_from_no_abnormality` | ตัวอ่อนที่ยังไม่มีข้อมูล | `unknown` แยกจาก `noAbnormalityRecorded` | FR-808 | ✅ |
| BE-ANL-028 | `test_control_comparison_pairs_scnt_at_control_stage_and_keeps_zero_unknown` | control counts ที่ stage 3/19/20/22/23/24 | จับคู่ถูก stage และไม่ปน unknown | FR-703 | ✅ |
| BE-ANL-029 | `test_survival_group_by_matrix` | groupBy แต่ละมิติและรวมกัน | คีย์ `siteId/site/strain/treatmentGroup(Id)/operatorId` ถูกใส่เฉพาะมิติที่เลือก | FR-804 | ➕ |

### 12.3 Timing deviation, abnormality onset, gaps, pipeline

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-ANL-040 | `test_timing_deviation_reports_mean_median_sd_and_quartiles` | ชุดค่าที่คำนวณมือได้ | ตรงทุกสถิติ | FR-809 | ✅ |
| BE-ANL-041 | `test_quartiles_handle_a_single_observation` | 1 ค่า | q1 = q3 = ค่านั้น ไม่ระเบิด | FR-809 | 🆕 |
| BE-ANL-042 | `test_timing_deviation_counts_rows_missing_deviation` | observation ที่ไม่มี `deviationH` | นับใน `meta.missing` | FR-803 | 🆕 |
| BE-ANL-043 | `test_abnormality_onset_bins_by_stage` | ตัวอ่อนที่ผิดปกติต่าง stage | แจกแจงตาม stage ถูกต้อง | FR-810 | ✅ |
| BE-ANL-044 | `test_observation_gaps_reports_lots_with_missed_checkpoints` | lot ที่ค้าง checkpoint | คืน `batchCode`, `lotNo`, `lastObservedOn`, `missedDays` | FR-811 | 🆕 |
| BE-ANL-045 | `test_observation_gaps_is_empty_when_everything_is_current` | dataset ที่บันทึกครบ | `items` ว่าง | FR-811 | 🆕 |
| BE-ANL-046 | `test_pipeline_reports_each_step_count` | dataset ปกติ | ทุก step มี `count` และ `pctOf*` สอดคล้องกัน | FR-812 | ✅ |
| BE-ANL-047 | `test_pipeline_is_filtered_by_the_shared_query` | ใส่ filter | ตัวเลขลดตาม | FR-812 | ➕ |

### 12.4 Fish survival (Kaplan–Meier)

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-ANL-060 | `test_fish_survival_uses_kaplan_meier_events_and_last_follow_up_censoring` | dataset ที่คำนวณมือได้ | ค่า survival, risk set, censor ตรง | FR-813 | ✅ |
| BE-ANL-061 | `test_fish_survival_respects_dead_status_without_exit_date` | ปลา `DEAD` ที่ไม่มี `exitDate` | ถือเป็น event ไม่ใช่ censor | FR-813 | ✅ |
| BE-ANL-062 | `test_fish_survival_reports_unusable_dob_instead_of_hiding_it` | `dob` เสีย | นับใน `meta.missing` ไม่ถูกทิ้งเงียบ | FR-803 | ✅ |
| BE-ANL-063 | `test_fish_survival_non_split_aggregates_strain_and_treatment` | `splitByCondition=false` | รวมกลุ่มถูกต้อง | FR-813 | ✅ |
| BE-ANL-064 | `test_fish_group_dimensions_default_by_split_flag` | `splitByCondition` true/false โดยไม่ส่ง `groupBy` | true → `condition,strain,treatmentGroup`; false → ไม่มีมิติ | FR-804 | 🆕 |
| BE-ANL-065 | `test_censor_statuses_are_alive_frozen_and_discarded` | ปลาแต่ละสถานะ | 3 สถานะนี้ถูก censor, `DEAD` เป็น event | FR-813 | ➕ |
| BE-ANL-066 | `test_fish_supporting_analysis_reports_composition_age_and_box_boundaries` | dataset ที่มีทุก bin อายุ | bins `0-6/7-13/14-20/21-27/28+` ครบและขอบถูกต้อง | FR-814 | ✅ |
| BE-ANL-067 | `test_fish_supporting_day5_reports_eligibility_and_condition_denominator` | ปลาที่อายุถึง/ไม่ถึง day 5 | denominator ถูกต้อง | FR-814 | ✅ |

---

## 13. Export & reporting — `api/routes/exports.py`, `reporting/xlsx.py`

ไฟล์เป้าหมาย: `backend/tests/test_contract_exports_audit.py`

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-XLS-001 | `test_excel_export_is_read_only_valid_14_sheet_xlsx` | POST `/exports/excel` | zip เปิดได้, มี 14 sheet ตาม `SHEET_NAMES` เรียงตามชื่อ | FR-901 | ✅ |
| BE-XLS-002 | `test_excel_export_can_select_flat_sheets` | `{"sheets": ["01_Batches"]}` | สร้างเฉพาะที่เลือก (sheet อื่นยังมีหัวแต่ไม่มีแถว) | FR-903 | ✅ |
| BE-XLS-003 | `test_excel_export_rejects_invalid_sheet_selection` | `sheets=[]`, `["ไม่มีจริง"]`, มีชื่อซ้ำ, ไม่ใช่ list | 422 ทุกกรณี | FR-903 | ➕ |
| BE-XLS-004 | `test_excel_export_rejects_unknown_analytics_filters` | `filters={"foo":"bar"}` | 422 "unsupported filter: foo" | FR-902 | ✅ |
| BE-XLS-005 | `test_excel_filters_must_be_an_object_of_strings` | `filters="x"`, `filters={"siteId":1}` | 422 ทีละกรณี | FR-902 | 🆕 |
| BE-XLS-006 | `test_excel_body_must_be_an_object` | body เป็น list | 422 "export request ต้องเป็น object" | FR-902 | 🆕 |
| BE-XLS-007 | `test_metadata_sheet_records_filters_range_versions_and_row_counts` | export พร้อม filter | sheet `00_Metadata` มี filter, data range, timing profile versions, จำนวนแถวต่อ sheet | FR-904 | ➕ |
| BE-XLS-008 | `test_checkpoint_cells_are_numeric_for_readxl` | sheet `03_Embryo_Matrix`, `12_R_Analysis_Table` | เซลล์เป็น number ไม่ใช่ string | FR-905 | ✅ |
| BE-XLS-009 | `test_export_row_order_is_deterministic_under_the_same_filters` | export สองครั้ง | ไบต์เหมือนกัน | FR-906 | ➕ |
| BE-XLS-010 | `test_xlsx_removes_invalid_xml_characters` | ข้อมูลที่มีอักขระควบคุม | ถูกถอดออก, ไฟล์ยังเปิดได้ | FR-901 | ✅ |
| BE-XLS-011 | `test_xlsx_escapes_xml_entities_and_thai_text` | ข้อมูลที่มี `&`, `<`, `"` และภาษาไทย | อ่านกลับได้ค่าเดิม | FR-901 | 🆕 |
| BE-XLS-012 | `test_xlsx_column_reference_beyond_z` | sheet ที่มี > 26 คอลัมน์ | reference เป็น `AA1`, `AB1` ถูกต้อง | FR-901 | 🆕 |
| BE-XLS-013 | `test_r_export_has_stable_30_column_shape` | `GET /exports/r-table` | 4 คอลัมน์ metadata + 26 stage = 30, มี BOM, media type `text/csv; charset=utf-8` | FR-907 | ✅ |
| BE-XLS-014 | `test_r_export_groups_by_site_strain_and_replicate` | dataset หลายกลุ่ม | หนึ่งแถวต่อกลุ่ม, `Strain_Rep` = `{strain}_{replicate}`, เรียงตามคีย์ | FR-907 | ➕ |
| BE-XLS-015 | `test_r_export_counts_alive_per_stage_using_implied_checkpoints` | ตัวอ่อนที่ข้าม checkpoint | นับว่ารอดตาม BR-21 | BR-21 | ➕ |
| BE-XLS-016 | `test_r_export_respects_shared_filters` | ใส่ filter | จำนวนแถวลดตาม | FR-907 | 🆕 |
| BE-XLS-017 | `test_excel_export_replays_identically_for_a_repeated_idempotency_key` | POST ซ้ำด้วย key เดิม | ไบต์เดิม | FR-1002 | ➕ |
| BE-XLS-018 | `test_export_download_headers_declare_a_filename` | ทั้งสอง endpoint | `Content-Disposition: attachment; filename="..."` | FR-908 | ➕ |

---

## 14. Audit log — `api/routes/audit.py`

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-AUD-001 | `test_audit_entries_expose_complete_change_context` | ทำการแก้ไข | มี `tableName`, `recordId`, `action`, `oldValues`, `newValues`, `operatorId`, `deviceId`, `occurredAt` | FR-1100 | ✅ |
| BE-AUD-002 | `test_audit_filters_and_uses_opaque_cursor` | filter + paginate | ผลตรง; `nextCursor` เป็น base64 ที่ decode เองไม่ได้จากภายนอก | FR-1103 | ✅ |
| BE-AUD-003 | `test_audit_rejects_malformed_cursor_without_server_error` | cursor เป็นขยะ / ยาวเกิน 512 | 400 `invalid_query` ไม่ใช่ 500 | FR-1103 | ✅ |
| BE-AUD-004 | `test_audit_rejects_malformed_uuid_filters` | `recordId=abc`, `operatorId=abc` | 400 "must be a UUID" | FR-1103 | ✅ |
| BE-AUD-005 | `test_audit_rejects_oversized_or_control_character_filters` | `table` 129 ตัว / มี `\n` | 400 `invalid_query` | NFR-502 | ➕ |
| BE-AUD-006 | `test_audit_limit_is_clamped_and_validated` | `limit=0`, `limit=9999`, `limit=abc` | clamp เป็น 1/500; ค่าไม่ใช่ตัวเลข → 400 | FR-1103 | ➕ |
| BE-AUD-007 | `test_audit_time_filters_treat_naive_timestamps_as_bangkok` | `from=2026-01-01T00:00:00` | ตีความเป็น `+07:00` | CI-04 | 🆕 |
| BE-AUD-008 | `test_audit_rejects_from_after_to` | `from` > `to` | 400 "from must not be after to" | FR-1103 | 🆕 |
| BE-AUD-009 | `test_audit_is_ordered_newest_first_with_id_tiebreak` | audit ที่ `occurredAt` เท่ากัน | เรียงตาม id เป็น tie-break แบบ deterministic | FR-1103 | ➕ |
| BE-AUD-010 | `test_audit_pagination_walks_every_row_exactly_once` | 250 audit rows, limit 100 | 3 หน้า ไม่ซ้ำ ไม่ตกหล่น, หน้าสุดท้าย `nextCursor=null` | FR-1103 | ➕ DB |
| BE-AUD-011 | `test_memory_and_sql_audit_paths_agree` | ชุดข้อมูลเดียวกัน | ผลของ MemoryStore fallback = ผลของ `query_audits()` | FR-1103 | 🆕 DB |
| BE-AUD-012 | `test_soft_delete_is_recorded_as_an_update_with_before_and_after` | ลบ embryo | audit `UPDATE` ที่ `oldValues.active=true`, `newValues.active=false` | BR-17 | ➕ |

---

## 15. Contract

| ID | Test | Setup / Input | Expected | Ref | St |
|---|---|---|---|---|---|
| BE-CTR-001 | `test_fastapi_registers_every_openapi_operation` | เทียบ route กับ `api/openapi.yaml` | ครบ 71 operations ไม่ขาดไม่เกิน | API-01 | ✅ |
| BE-CTR-002 | `test_every_operation_is_exercised_by_at_least_one_test` | เก็บ path ที่ถูกเรียกระหว่างรัน suite (pytest hook) | ทุก operation ถูกเรียกจริง — รายงานรายการที่ยังไม่ถูกเรียก | §5.2 ข้อ 3 | 🆕 |
| BE-CTR-003 | `test_error_responses_match_the_error_response_schema` | รวบรวม 4xx/5xx ทุกแบบ | ทุกตัวมีรูป `{"error":{"code","message"[,"details"]}}` | API-02 | 🆕 |
| BE-CTR-004 | `test_openapi_document_validates` | `scripts/validate_openapi.py` | 52 paths / 71 operations ผ่าน | API-01 | ✅ |
| BE-CTR-005 | `test_generated_mysql_migrations_match_postgres_source` | `scripts/gen_mysql_migrations.py` + `git diff` | ไม่มี diff | NFR-506 | ✅ |

---

## 16. สรุปจำนวน test case

| หมวด | จำนวน case | ✅ มีแล้ว | ➕ ต้องเสริม | 🆕 ต้องเขียนใหม่ |
|---|---:|---:|---:|---:|
| Config | 14 | 2 | 0 | 12 |
| App & middleware | 26 | 7 | 1 | 18 |
| Runtime | 21 | 4 | 0 | 17 |
| Entry point | 3 | 0 | 0 | 3 |
| Domain rules | 24 | 3 | 9 | 12 |
| Store (memory/sql/migrations/db) | 33 | 5 | 1 | 27 |
| Master data | 20 | 3 | 3 | 14 |
| Timing | 30 | 6 | 3 | 21 |
| Experiments | 47 | 9 | 16 | 22 |
| Observations | 47 | 20 | 17 | 10 |
| Fish & promotion | 57 | 11 | 21 | 25 |
| Analytics | 33 | 17 | 6 | 10 |
| Export & reporting | 18 | 6 | 6 | 6 |
| Audit | 12 | 4 | 5 | 3 |
| Contract | 5 | 3 | 0 | 2 |
| **รวม** | **390** | **100** | **88** | **202** |

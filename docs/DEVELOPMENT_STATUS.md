# ChronoFish Development Status

> อัปเดตล่าสุด: 23 สิงหาคม 2026  
> Branch: `feat/phase-1-hardening`
> Go baseline ก่อนย้ายภาษา: `6adc25e`

## สรุปสถานะ

การย้าย backend จาก Go เป็น Python เสร็จแล้วใน source tree ปัจจุบัน โดยมี OpenAPI 3.1 จำนวน 70 operations ระบบใช้ Python 3.13+, FastAPI, SQLAlchemy synchronous, Uvicorn, PostgreSQL 16 เป็นฐานหลัก และ MySQL 8 เป็น compatibility target ส่วน Go runtime, Go tests และ Go CI ถูกถอดออกหลัง Python ผ่าน behavior, contract และ database integration gates

Frontend ยังคงเป็น Vite + React + TypeScript แบบ static SPA และใช้ generated types จาก `api/openapi.yaml` ซึ่งเป็น HTTP contract แหล่งเดียวของระบบ

## สิ่งที่ implement แล้ว

- API ครบ 70 operations: master data, timing profile, batch/lot/embryo, copied-lot activation, observations, promotion/fish, analytics, audit และ export
- business rules 36 stages, HPA/deviation, Bangkok calendar age, backdated override, embryo/fish lifecycle และ promotion threshold
- durable writes บน PostgreSQL/MySQL: transaction, audit, soft delete, idempotent replay/conflict และ fish running number ภายใต้ database lock
- Python migration runner สำหรับ SQL versions 1–8 พร้อม migration lock และ dirty-state protection
- audit query แบบ indexed keyset pagination โดยไม่ materialize audit history ทั้งหมด
- Excel 14 sheets แบบ flat table, R-ready CSV 30 columns และ binary idempotent replay
- middleware สำหรับ CORS, IP allowlist, rate limit, body-size limit, generic error redaction, security headers และ metadata-only request logging
- บังคับ content type ตาม OpenAPI (JSON และ CSV import) และแปลง FastAPI request-validation failure เป็น `ErrorResponse`/HTTP 400 ตาม SRS
- native required-field validation สำหรับ master-data forms พร้อม tests ของ operator/device persistence
- Dockerfile แบบ non-root, Compose สำหรับ PostgreSQL/MySQL, native virtual-environment workflow และ Python CI
- route-contract test เทียบ OpenAPI ทั้ง 70 operations และ pytest behavior/integration suite

## ผลตรวจล่าสุด

- `ruff format --check` และ `ruff check`: ผ่าน
- pytest memory suite: 28 passed, 1 database-only test skipped
- domain coverage: 91.30% (เกณฑ์ 90%)
- PostgreSQL integration บน clean temporary cluster: ผ่าน migrations 1–8 และ workflow write/replay/duplicate-draft/restart/activate/audit
- MySQL integration บน clean temporary instance: ผ่านชุดเดียวกับ PostgreSQL
- OpenAPI validation: 51 paths / 70 operations ผ่าน
- PostgreSQL → MySQL generated migration parity: ผ่าน
- frontend: build ผ่าน และ 21 tests ผ่าน
- Compose configuration ทั้งสองไฟล์: ผ่าน
- Docker image build: ผ่าน CI ของ PR #1; เครื่องพัฒนานี้ยังไม่มี Docker daemon สำหรับ clean-checkout Compose gate

## Architecture ปัจจุบัน

- Backend entrypoint: `python -m chronofish`
- Migration command: `python -m chronofish migrate`
- Production state: database เป็น source of truth; memory driver ใช้ได้เฉพาะ development/test
- Deployment artifact หลัก: Python Docker image; native venv เป็นทางเลือก
- Migration source: `backend/db/migrations/postgres`; MySQL copy generate ด้วย `scripts/gen_mysql_migrations.py`

## งานที่ยังต้องอาศัยผู้ใช้หรือ infrastructure ภายนอก

- สังเกต workflow จริงในห้องแลปและทำ UAT T-01 ถึง T-23 บน iPad/Safari
- ยืนยัน production hosting, TLS/VPN/IP allowlist, secret store และ deployment owner
- รัน `docker compose up --build` และ health check จาก clean checkout บนเครื่องที่มี Docker daemon
- backup/restore drill กับ production-like infrastructure
- เทียบ Excel/R/PDF กับไฟล์อ้างอิงจริงของห้องแลป
- performance sign-off ด้วยชุดข้อมูลเทียบเท่า 5 ปี; SQLStore ปัจจุบันโหลด operational snapshot สำหรับ analytics/export และมี `ponytail:` marker ให้เปลี่ยนเป็น bounded SQL projections เมื่อ dataset จริงพิสูจน์ว่าจำเป็น

## คำสั่งพัฒนาและตรวจสอบ

```powershell
cd backend
python -m pip install -e ".[dev]"
python -m ruff format --check src tests
python -m ruff check src tests
python -m pytest

cd ../frontend
npm.cmd ci
npm.cmd run generate:api
npm.cmd run check
npm.cmd test -- --run

cd ..
python scripts/validate_openapi.py
docker compose -f compose.yaml config
docker compose -f compose.mysql.yaml --profile mysql config
```

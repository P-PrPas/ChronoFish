# ChronoFish Development Status

> อัปเดตล่าสุด: 23 สิงหาคม 2026  
> Branch: `feat/implement-chronofish-v1`  
> จุดอ้างอิงก่อนย้าย backend: `6adc25e`

## สรุปสำหรับผู้รับช่วงงาน

ChronoFish มี OpenAPI 3.1 จำนวน 69 operations, React frontend, schema/migrations สำหรับ PostgreSQL 16 และ MySQL 8 และ backend เดิมภาษา Go ที่ implement workflow หลักแล้ว งานปัจจุบันคือย้าย backend เป็น Python โดย **คง HTTP contract และ schema เดิม** เพื่อให้ทีมพัฒนาและดูแลต่อได้ง่ายขึ้น

ห้ามเปลี่ยน `api/openapi.yaml` หรือ database schema เพียงเพื่อให้ migration ง่ายขึ้น หาก behavior จำเป็นต้องเปลี่ยน ให้แก้ SRS/OpenAPI เป็น change request ก่อน

## Architecture ที่ตัดสินใจแล้ว

- Frontend: Vite + React + TypeScript แบบ static SPA
- Backend ใหม่: Python 3.13+, FastAPI, SQLAlchemy synchronous และ Uvicorn
- Database หลัก: PostgreSQL 16; ต้องผ่าน integration suite เดียวกันบน MySQL 8
- API contract: `api/openapi.yaml` เป็นแหล่งความจริง
- Migration: คงไฟล์ SQL ที่ `backend/db/migrations/{postgres,mysql}` และใช้ Python migration runner
- Deployment: Docker image เป็น artifact หลัก; native run ใช้ virtual environment และ `python -m chronofish`
- State: backend stateless; database เป็น source of truth; ห้ามพึ่ง local filesystem สำหรับข้อมูลถาวร

## Baseline ก่อนย้ายภาษา

- Go unit/integration tests ผ่านทั้งหมดที่ commit `6adc25e`
- OpenAPI validator ผ่าน: 50 paths / 69 operations
- Frontend มี workflow pages, offline queue, generated API types และ tests
- Docker/Compose รองรับ PostgreSQL และ MySQL
- CI ตรวจ migration upgrade, idempotency, restart durability และ constraint smoke tests บนทั้งสองฐานข้อมูล

## ลำดับ migration

1. ปรับเอกสาร, README, Docker และ CI ให้ระบุ Python stack
2. สร้าง Python composition root, config, middleware, error contract และ health endpoint
3. ย้าย store/migration/idempotency/audit โดย database เป็น canonical source
4. ย้าย endpoints เป็น vertical slice: master data → timing → batch/lot/embryo → observations → promotion/fish → analytics/export
5. ย้าย tests จาก Go เป็น pytest และรัน behavior เดียวกันบน memory, PostgreSQL และ MySQL ตามความเหมาะสม
6. ลบ Go runtime หลัง Python ผ่าน contract, integration, frontend และ Docker gates ทั้งหมด
7. ทำ final spec/code review แล้วจึงเปิด PR

## Release blockers ที่ต้องตรวจซ้ำหลัง migration

- transaction + audit + idempotency ต้อง atomic และปลอดภัยเมื่อมี API หลาย instance
- fish running number ต้องจ่ายจากฐานข้อมูลใน transaction
- read path ห้ามใช้ process cache เป็น source of truth ใน production
- audit ต้อง query แบบ indexed/keyset pagination โดยไม่ตัดประวัติ
- due/analytics/export ต้องไม่โหลด observations ทั้งระบบเข้า memory
- business rules ต้องอยู่ใน service/domain ไม่กองใน HTTP handler และมี coverage อย่างน้อย 90%
- optimistic offline writes, Bangkok time, soft delete และ immutable timing profile ต้องรักษา behavior เดิม

## งานที่ต้องอาศัยผู้ใช้หรือ infrastructure ภายนอก

- สังเกต workflow จริงในห้องแลปและทำ UAT บน iPad/Safari
- ยืนยัน production hosting, TLS/VPN/IP allowlist และผู้รับผิดชอบ deployment
- backup/restore drill
- เทียบ Excel/R/PDF กับไฟล์อ้างอิงจริง
- performance/UAT sign-off ด้วยชุดข้อมูลเทียบเท่า 5 ปี

## คำสั่งเป้าหมายหลัง migration

```powershell
python -m pip install -e ".[dev]"
python -m chronofish
pytest

cd frontend
npm.cmd ci
npm.cmd test -- --run
npm.cmd run check
```


# ADR-001: เปลี่ยน Backend จาก Go เป็น Python

- สถานะ: Accepted
- วันที่: 23 สิงหาคม 2026

## Context

ทีมต้องการลดความยากในการ implement และ maintain ระบบในระยะปัจจุบัน โดยยังต้องรักษา OpenAPI, database schema, portability ระหว่าง PostgreSQL/MySQL, offline idempotency และ auditability ตาม SRS

## Decision

ใช้ Python 3.13+ กับ FastAPI, SQLAlchemy แบบ synchronous และ Uvicorn โดย:

- ใช้ `api/openapi.yaml` เป็น contract เดิม
- ใช้ SQL migrations เดิมและไม่ rewrite migration ที่เคย deploy
- ใช้ database เป็น source of truth ใน production
- แยก HTTP routers, service/domain rules และ store ตาม use case
- ใช้ Docker image เป็น deployment artifact หลัก; native deployment ใช้ virtual environment
- ไม่เพิ่ม async database layer, repository framework, CQRS หรือ code generator จนกว่าจะมีปัญหาจริงที่พิสูจน์ว่าจำเป็น

## Consequences

- ทีม Python สามารถพัฒนาและ debug ได้เร็วขึ้น
- deployment ต้องมี Python runtime หรือ container แทน standalone Go binary
- ต้องย้าย test และ implementation ทั้งหมดก่อนถอด Go ออกจาก CI
- ความถูกต้องของ migration วัดจาก contract/integration tests ไม่ใช่ความเหมือนของโครงสร้างโค้ด


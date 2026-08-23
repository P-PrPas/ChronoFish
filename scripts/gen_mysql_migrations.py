#!/usr/bin/env python3
"""
Generate the MySQL 8 migration set from the canonical PostgreSQL migrations.
The PostgreSQL files under backend/db/migrations/postgres/ are the single source
of truth. This script applies the small, documented set of dialect differences
and writes backend/db/migrations/mysql/. Regenerate after every schema change:

    python3 scripts/gen_mysql_migrations.py

Differences handled (this is the complete list — if you ever need to add to
it, you have probably reached for a non-portable feature; see SRS CON-04):

  1. TIMESTAMP column type      -> DATETIME(3)
     PostgreSQL TIMESTAMP has microsecond range well past 2038; MySQL
     TIMESTAMP tops out in 2038, so DATETIME is the correct counterpart.
  2. TIMESTAMP 'literal'        -> 'literal'
  3. ALTER TABLE .. DROP CONSTRAINT IF EXISTS -> DROP FOREIGN KEY
  4. Table option suffix: ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
     COLLATE=utf8mb4_0900_ai_ci  (utf8mb4 is required for Thai text in notes)
"""
import re
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "backend/db/migrations/postgres"
DST = ROOT / "backend/db/migrations/mysql"
TABLE_OPTS = " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci"
INDEX_TABLES = {
    "ix_stage_timing_profile_stage": "stage_timing",
    "ix_embryo_lot_exit_path": "embryo",
    "ix_fish_observation_fish_date": "fish_observation",
    "ix_observation_embryo_stage": "embryo_observation",
    "ix_audit_occurred_id": "audit_log",
}

HEADER = (
    "-- ===========================================================================\n"
    "-- GENERATED FILE — do not edit by hand.\n"
    "-- Source: backend/db/migrations/postgres/{name}\n"
    "-- Regenerate: python3 scripts/gen_mysql_migrations.py\n"
    "-- ===========================================================================\n\n"
)


def convert(sql: str, upgrade: bool) -> str:
    # Migration 000003 is immutable and remains TEXT. Migration 000004 carries
    # an explicit canonical type marker and widens only that upgrade to
    # LONGTEXT on MySQL 8.
    response_type = "LONGTEXT" if upgrade else "TEXT"
    sql = re.sub(
        r"ALTER TABLE request_idempotency\s+ALTER COLUMN response_body TYPE TEXT;",
        f"ALTER TABLE request_idempotency MODIFY response_body {response_type} NOT NULL;",
        sql,
    )
    sql = sql.replace("INTERVAL '30 seconds'", "INTERVAL 30 SECOND")
    sql = re.sub(
        r"ALTER TABLE request_idempotency\s+ALTER COLUMN lease_until SET NOT NULL;",
        "ALTER TABLE request_idempotency MODIFY lease_until DATETIME(3) NOT NULL;",
        sql,
    )
    sql = re.sub(
        r"ALTER TABLE request_idempotency\s+ALTER COLUMN lease_token SET NOT NULL;",
        "ALTER TABLE request_idempotency MODIFY lease_token CHAR(36) NOT NULL;",
        sql,
    )
    sql = sql.replace(
        "ALTER TABLE injection_lot ALTER COLUMN activated_at DROP NOT NULL;",
        "ALTER TABLE injection_lot MODIFY activated_at DATETIME(3) NULL;",
    )
    sql = sql.replace(
        "ALTER TABLE injection_lot ALTER COLUMN activated_at SET NOT NULL;",
        "ALTER TABLE injection_lot MODIFY activated_at DATETIME(3) NOT NULL;",
    )
    sql = sql.replace(
        "DROP INDEX IF EXISTS ix_request_idempotency_lease;",
        "DROP INDEX ix_request_idempotency_lease ON request_idempotency;",
    )
    sql = sql.replace(
        "ALTER TABLE request_idempotency\n    DROP COLUMN IF EXISTS lease_until;",
        "ALTER TABLE request_idempotency DROP COLUMN lease_until;",
    )
    sql = sql.replace(
        "ALTER TABLE request_idempotency\n    DROP COLUMN IF EXISTS lease_token;",
        "ALTER TABLE request_idempotency DROP COLUMN lease_token;",
    )
    for index_name, table_name in INDEX_TABLES.items():
        sql = sql.replace(
            f"DROP INDEX IF EXISTS {index_name};",
            f"DROP INDEX {index_name} ON {table_name};",
        )
    # 2. typed timestamp literals
    sql = re.sub(r"TIMESTAMP\s+('(?:[^']*)')", r"\1", sql)
    # 1. TIMESTAMP column type -> DATETIME(3)
    sql = re.sub(r"\bTIMESTAMP\b(?!\s*\()", "DATETIME(3)", sql)
    # 3. constraint drop syntax
    sql = re.sub(
        r"ALTER TABLE (\w+) DROP CONSTRAINT IF EXISTS (\w+);",
        r"ALTER TABLE \1 DROP FOREIGN KEY \2;",
        sql,
    )
    # 4. table options
    sql = re.sub(r"\n\);", "\n)" + TABLE_OPTS + ";", sql)
    return sql


def main() -> None:
    DST.mkdir(parents=True, exist_ok=True)
    written = []
    for src in sorted(SRC.glob("*.sql")):
        out = HEADER.format(name=src.name) + convert(src.read_text(encoding="utf-8"), src.name.endswith(".up.sql"))
        (DST / src.name).write_text(out, encoding="utf-8", newline="\n")
        written.append(src.name)
    for name in written:
        print(f"generated backend/db/migrations/mysql/{name}")


if __name__ == "__main__":
    main()

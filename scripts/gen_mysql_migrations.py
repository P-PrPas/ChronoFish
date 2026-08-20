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

HEADER = (
    "-- ===========================================================================\n"
    "-- GENERATED FILE — do not edit by hand.\n"
    "-- Source: backend/db/migrations/postgres/{name}\n"
    "-- Regenerate: python3 scripts/gen_mysql_migrations.py\n"
    "-- ===========================================================================\n\n"
)


def convert(sql: str) -> str:
    # XLSX idempotent responses are base64 text and can exceed MySQL's 64 KiB
    # TEXT limit. Keep PostgreSQL's TEXT source type while using LONGTEXT on
    # MySQL 8 (the generated file remains reproducible).
    sql = sql.replace("response_body   TEXT NOT NULL", "response_body   LONGTEXT NOT NULL")
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
        out = HEADER.format(name=src.name) + convert(src.read_text(encoding="utf-8"))
        (DST / src.name).write_text(out, encoding="utf-8", newline="\n")
        written.append(src.name)
    for name in written:
        print(f"generated backend/db/migrations/mysql/{name}")


if __name__ == "__main__":
    main()

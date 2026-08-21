-- ===========================================================================
-- GENERATED FILE — do not edit by hand.
-- Source: backend/db/migrations/postgres/000006_fish_running_sequence.up.sql
-- Regenerate: python3 scripts/gen_mysql_migrations.py
-- ===========================================================================

-- Allocate fish running numbers under a database row lock so multiple API
-- instances cannot derive the same number from a stale process cache.
CREATE TABLE fish_running_sequence (
    id              CHAR(36) PRIMARY KEY,
    next_running_no INTEGER NOT NULL CHECK (next_running_no > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO fish_running_sequence (id, next_running_no)
VALUES ('00000000-0000-7000-8000-000000000006', 1);

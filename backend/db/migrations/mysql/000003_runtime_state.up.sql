-- ===========================================================================
-- GENERATED FILE — do not edit by hand.
-- Source: backend/db/migrations/postgres/000003_runtime_state.up.sql
-- Regenerate: python3 scripts/gen_mysql_migrations.py
-- ===========================================================================

CREATE TABLE IF NOT EXISTS chronofish_runtime_state (
    resource VARCHAR(80) NOT NULL,
    record_id CHAR(36) NOT NULL,
    payload TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at DATETIME(3) NOT NULL,
    CONSTRAINT pk_chronofish_runtime_state PRIMARY KEY (resource, record_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS chronofish_runtime_idempotency (
    scope VARCHAR(100) NOT NULL,
    response TEXT NOT NULL,
    created_at DATETIME(3) NOT NULL,
    CONSTRAINT pk_chronofish_runtime_idempotency PRIMARY KEY (scope)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

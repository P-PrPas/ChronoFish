-- ===========================================================================
-- GENERATED FILE — do not edit by hand.
-- Source: backend/db/migrations/postgres/000004_idempotency_lease.up.sql
-- Regenerate: python3 scripts/gen_mysql_migrations.py
-- ===========================================================================

ALTER TABLE request_idempotency
    ADD COLUMN lease_until DATETIME(3) NULL;

ALTER TABLE request_idempotency
    ADD COLUMN lease_token CHAR(36) NULL;

UPDATE request_idempotency
SET lease_until = COALESCE(completed_at, created_at + INTERVAL 30 SECOND)
WHERE lease_until IS NULL;

UPDATE request_idempotency
SET lease_token = idempotency_key
WHERE lease_token IS NULL;

ALTER TABLE request_idempotency MODIFY lease_until DATETIME(3) NOT NULL;

ALTER TABLE request_idempotency MODIFY lease_token CHAR(36) NOT NULL;

CREATE INDEX ix_request_idempotency_lease
    ON request_idempotency (status_code, lease_until);

-- This no-op PostgreSQL type declaration is the canonical marker for the
-- MySQL generator to widen the response body to LONGTEXT in this upgrade.
ALTER TABLE request_idempotency MODIFY response_body LONGTEXT NOT NULL;

-- ===========================================================================
-- GENERATED FILE — do not edit by hand.
-- Source: backend/db/migrations/postgres/000004_idempotency_lease.down.sql
-- Regenerate: python3 scripts/gen_mysql_migrations.py
-- ===========================================================================

DROP INDEX ix_request_idempotency_lease ON request_idempotency;

ALTER TABLE request_idempotency DROP COLUMN lease_until;

ALTER TABLE request_idempotency DROP COLUMN lease_token;

ALTER TABLE request_idempotency MODIFY response_body TEXT NOT NULL;

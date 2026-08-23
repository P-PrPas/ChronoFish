ALTER TABLE request_idempotency
    ADD COLUMN lease_until TIMESTAMP NULL;

ALTER TABLE request_idempotency
    ADD COLUMN lease_token CHAR(36) NULL;

UPDATE request_idempotency
SET lease_until = COALESCE(completed_at, created_at + INTERVAL '30 seconds')
WHERE lease_until IS NULL;

UPDATE request_idempotency
SET lease_token = idempotency_key
WHERE lease_token IS NULL;

ALTER TABLE request_idempotency
    ALTER COLUMN lease_until SET NOT NULL;

ALTER TABLE request_idempotency
    ALTER COLUMN lease_token SET NOT NULL;

CREATE INDEX ix_request_idempotency_lease
    ON request_idempotency (status_code, lease_until);

-- This no-op PostgreSQL type declaration is the canonical marker for the
-- MySQL generator to widen the response body to LONGTEXT in this upgrade.
ALTER TABLE request_idempotency
    ALTER COLUMN response_body TYPE TEXT;

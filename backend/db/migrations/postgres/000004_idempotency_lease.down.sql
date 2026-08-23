DROP INDEX IF EXISTS ix_request_idempotency_lease;

ALTER TABLE request_idempotency
    DROP COLUMN IF EXISTS lease_until;

ALTER TABLE request_idempotency
    DROP COLUMN IF EXISTS lease_token;

ALTER TABLE request_idempotency
    ALTER COLUMN response_body TYPE TEXT;

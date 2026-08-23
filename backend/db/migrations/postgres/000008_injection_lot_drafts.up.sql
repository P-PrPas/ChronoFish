-- Batch duplication creates reusable lot settings before a new activation time exists.
ALTER TABLE injection_lot ALTER COLUMN activated_at DROP NOT NULL;

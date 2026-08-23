-- Remove draft rows before rolling back this migration.
ALTER TABLE injection_lot ALTER COLUMN activated_at SET NOT NULL;

-- ===========================================================================
-- GENERATED FILE — do not edit by hand.
-- Source: backend/db/migrations/postgres/000008_injection_lot_drafts.down.sql
-- Regenerate: python3 scripts/gen_mysql_migrations.py
-- ===========================================================================

-- Remove draft rows before rolling back this migration.
ALTER TABLE injection_lot MODIFY activated_at DATETIME(3) NOT NULL;

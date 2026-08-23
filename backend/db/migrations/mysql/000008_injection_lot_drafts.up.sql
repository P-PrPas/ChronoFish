-- ===========================================================================
-- GENERATED FILE — do not edit by hand.
-- Source: backend/db/migrations/postgres/000008_injection_lot_drafts.up.sql
-- Regenerate: python3 scripts/gen_mysql_migrations.py
-- ===========================================================================

-- Batch duplication creates reusable lot settings before a new activation time exists.
ALTER TABLE injection_lot MODIFY activated_at DATETIME(3) NULL;

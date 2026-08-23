-- ===========================================================================
-- GENERATED FILE — do not edit by hand.
-- Source: backend/db/migrations/postgres/000009_embryo_well_uniqueness.down.sql
-- Regenerate: python3 scripts/gen_mysql_migrations.py
-- ===========================================================================

DROP INDEX uq_embryo_live_well ON embryo;
ALTER TABLE embryo DROP COLUMN well_live_marker;

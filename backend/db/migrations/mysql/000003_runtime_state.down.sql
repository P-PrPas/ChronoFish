-- ===========================================================================
-- GENERATED FILE — do not edit by hand.
-- Source: backend/db/migrations/postgres/000003_runtime_state.down.sql
-- Regenerate: python3 scripts/gen_mysql_migrations.py
-- ===========================================================================

DROP TABLE IF EXISTS chronofish_runtime_idempotency;
DROP TABLE IF EXISTS chronofish_runtime_state;

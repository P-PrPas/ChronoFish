-- ===========================================================================
-- GENERATED FILE — do not edit by hand.
-- Source: backend/db/migrations/postgres/000007_query_path_indexes.down.sql
-- Regenerate: python3 scripts/gen_mysql_migrations.py
-- ===========================================================================

DROP INDEX ix_stage_timing_profile_stage ON stage_timing;
DROP INDEX ix_embryo_lot_active_exit ON embryo;
DROP INDEX ix_fish_observation_fish_date ON fish_observation;
DROP INDEX ix_observation_embryo_stage ON embryo_observation;
DROP INDEX ix_audit_occurred_id ON audit_log;

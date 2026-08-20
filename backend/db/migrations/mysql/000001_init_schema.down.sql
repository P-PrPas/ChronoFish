-- ===========================================================================
-- GENERATED FILE — do not edit by hand.
-- Source: backend/db/migrations/postgres/000001_init_schema.down.sql
-- Regenerate: python3 scripts/gen_mysql_migrations.py
-- ===========================================================================

ALTER TABLE embryo DROP FOREIGN KEY fk_embryo_first_abnormal;

DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS specimen;
DROP TABLE IF EXISTS fish_observation;
DROP TABLE IF EXISTS clone_fish;
DROP TABLE IF EXISTS control_arm_count;
DROP TABLE IF EXISTS embryo_observation;
DROP TABLE IF EXISTS embryo;
DROP TABLE IF EXISTS injection_lot;
DROP TABLE IF EXISTS experiment_batch;
DROP TABLE IF EXISTS stage_timing;
DROP TABLE IF EXISTS stage_timing_profile;
DROP TABLE IF EXISTS stage_definition;
DROP TABLE IF EXISTS protocol;
DROP TABLE IF EXISTS fish_box;
DROP TABLE IF EXISTS treatment_group;
DROP TABLE IF EXISTS csof_lot;
DROP TABLE IF EXISTS recipient_egg_lot;
DROP TABLE IF EXISTS donor_cell_line;
DROP TABLE IF EXISTS operator;
DROP TABLE IF EXISTS site;

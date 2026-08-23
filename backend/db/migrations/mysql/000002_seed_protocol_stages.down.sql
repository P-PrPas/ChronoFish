-- ===========================================================================
-- GENERATED FILE — do not edit by hand.
-- Source: backend/db/migrations/postgres/000002_seed_protocol_stages.down.sql
-- Regenerate: python3 scripts/gen_mysql_migrations.py
-- ===========================================================================

DELETE FROM stage_timing        WHERE profile_id  = '01900000-0000-7000-8000-000000000002';
DELETE FROM stage_timing_profile WHERE id         = '01900000-0000-7000-8000-000000000002';
DELETE FROM stage_definition    WHERE protocol_id = '01900000-0000-7000-8000-000000000001';
DELETE FROM protocol            WHERE id          = '01900000-0000-7000-8000-000000000001';
DELETE FROM operator            WHERE id          = '00000000-0000-7000-8000-000000000001';

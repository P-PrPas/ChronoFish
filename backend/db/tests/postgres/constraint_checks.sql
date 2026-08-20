\set ON_ERROR_STOP on
\pset pager off

BEGIN;

CREATE FUNCTION pg_temp.expect_failure(label text, statement text) RETURNS void AS $$
DECLARE
    failed boolean := false;
BEGIN
    BEGIN
        EXECUTE statement;
    EXCEPTION WHEN OTHERS THEN
        failed := true;
    END;

    IF NOT failed THEN
        RAISE EXCEPTION '%: statement unexpectedly succeeded', label;
    END IF;
END;
$$ LANGUAGE plpgsql;

INSERT INTO site (id, code, name, active, created_at, updated_at) VALUES
    ('11111111-0000-7000-8000-000000000001', 'KU', 'Kasetsart University', TRUE, now(), now());
INSERT INTO operator (id, site_id, name, active, created_at, updated_at) VALUES
    ('22222222-0000-7000-8000-000000000001', '11111111-0000-7000-8000-000000000001', 'Jan', TRUE, now(), now());
INSERT INTO csof_lot (id, lot_code, active, created_at, updated_at) VALUES
    ('33333333-0000-7000-8000-000000000001', 'CSOF 2021-3', TRUE, now(), now());

SELECT pg_temp.expect_failure('trimmed lot code must be unique', $sql$
    INSERT INTO csof_lot (id, lot_code, active, created_at, updated_at) VALUES
    ('33333333-0000-7000-8000-000000000002', 'CSOF 2021-3 ', TRUE, now(), now())
$sql$);
SELECT pg_temp.expect_failure('lot code must be case-insensitively unique', $sql$
    INSERT INTO csof_lot (id, lot_code, active, created_at, updated_at) VALUES
    ('33333333-0000-7000-8000-000000000003', 'csof 2021-3', TRUE, now(), now())
$sql$);
SELECT pg_temp.expect_failure('arm type enum must be enforced', $sql$
    INSERT INTO treatment_group (id, code, arm_type, active, created_at, updated_at) VALUES
    ('44444444-0000-7000-8000-000000000099', 'INVALID', 'GENE_EDIT', TRUE, now(), now())
$sql$);

INSERT INTO treatment_group (id, code, arm_type, active, created_at, updated_at) VALUES
    ('44444444-0000-7000-8000-000000000001', 'CONTROL', 'SCNT', TRUE, now(), now());
INSERT INTO donor_cell_line (id, strain, preparation, batch_code, active, created_at, updated_at) VALUES
    ('55555555-0000-7000-8000-000000000001', 'AB', 'DISSOCIATED', 'AB240426_e48h', TRUE, now(), now());
SELECT pg_temp.expect_failure('only one current timing profile is allowed per protocol', $sql$
    INSERT INTO stage_timing_profile (id, protocol_id, version, name, is_current, created_at, updated_at) VALUES
    ('01900000-0000-7000-8000-000000000099', '01900000-0000-7000-8000-000000000001', 2, 'Duplicate current', TRUE, now(), now())
$sql$);
INSERT INTO protocol (id, name, stage1_max_age_days, active, created_at, updated_at) VALUES
    ('01900000-0000-7000-8000-000000000099', 'Other protocol', 5, TRUE, now(), now());
SELECT pg_temp.expect_failure('batch timing profile must belong to its protocol', $sql$
    INSERT INTO experiment_batch (id, batch_code, experiment_date, site_id, operator_id, protocol_id, timing_profile_id, treatment_group_id, created_at, updated_at) VALUES
    ('66666666-0000-7000-8000-000000000099', 'Mismatched profile', '2026-04-24', '11111111-0000-7000-8000-000000000001', '22222222-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000099', '01900000-0000-7000-8000-000000000002', '44444444-0000-7000-8000-000000000001', now(), now())
$sql$);
INSERT INTO experiment_batch (id, batch_code, experiment_date, site_id, operator_id, protocol_id, timing_profile_id, treatment_group_id, created_at, updated_at) VALUES
    ('66666666-0000-7000-8000-000000000001', '1_Jan_Control', '2026-04-24', '11111111-0000-7000-8000-000000000001', '22222222-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002', '44444444-0000-7000-8000-000000000001', now(), now());
INSERT INTO injection_lot (id, batch_id, lot_no, donor_cell_line_id, activated_at, n_activated, created_at, updated_at) VALUES
    ('77777777-0000-7000-8000-000000000001', '66666666-0000-7000-8000-000000000001', '1', '55555555-0000-7000-8000-000000000001', TIMESTAMP '2026-04-24 03:59:00', 3, now(), now());
INSERT INTO embryo (id, injection_lot_id, seq_in_lot, embryo_code, created_at, updated_at) VALUES
    ('88888888-0000-7000-8000-000000000001', '77777777-0000-7000-8000-000000000001', 1, '1_Jan_Control_1_1', now(), now());

INSERT INTO embryo_observation (id, client_uuid, embryo_id, stage_definition_id, observed_at, hpa_actual, hpa_expected_snapshot, deviation_h, outcome, biological_condition, operator_id, created_at, updated_at) VALUES
    ('99999999-0000-7000-8000-000000000001', 'aaaa1111-0000-7000-8000-000000000001', '88888888-0000-7000-8000-000000000001', '01900001-0000-7000-8000-000000000009', TIMESTAMP '2026-04-24 06:37:00', 2.6333, 2.5000, 0.1333, 'ALIVE', 'NORMAL', '22222222-0000-7000-8000-000000000001', now(), now());
SELECT pg_temp.expect_failure('client UUID must be idempotent', $sql$
    INSERT INTO embryo_observation (id, client_uuid, embryo_id, stage_definition_id, observed_at, hpa_actual, hpa_expected_snapshot, deviation_h, outcome, biological_condition, operator_id, created_at, updated_at) VALUES
    ('99999999-0000-7000-8000-000000000002', 'aaaa1111-0000-7000-8000-000000000001', '88888888-0000-7000-8000-000000000001', '01900001-0000-7000-8000-000000000010', TIMESTAMP '2026-04-24 06:47:00', 2.8, 2.75, 0.05, 'ALIVE', 'NORMAL', '22222222-0000-7000-8000-000000000001', now(), now())
$sql$);
SELECT pg_temp.expect_failure('live embryo-stage pair must be unique', $sql$
    INSERT INTO embryo_observation (id, client_uuid, embryo_id, stage_definition_id, observed_at, hpa_actual, hpa_expected_snapshot, deviation_h, outcome, biological_condition, operator_id, created_at, updated_at) VALUES
    ('99999999-0000-7000-8000-000000000003', 'aaaa1111-0000-7000-8000-000000000002', '88888888-0000-7000-8000-000000000001', '01900001-0000-7000-8000-000000000009', TIMESTAMP '2026-04-24 06:40:00', 2.68, 2.50, 0.18, 'DEAD', 'NORMAL', '22222222-0000-7000-8000-000000000001', now(), now())
$sql$);

UPDATE embryo_observation SET deleted_at = now() WHERE id = '99999999-0000-7000-8000-000000000001';
INSERT INTO embryo_observation (id, client_uuid, embryo_id, stage_definition_id, observed_at, hpa_actual, hpa_expected_snapshot, deviation_h, outcome, biological_condition, operator_id, created_at, updated_at) VALUES
    ('99999999-0000-7000-8000-000000000004', 'aaaa1111-0000-7000-8000-000000000003', '88888888-0000-7000-8000-000000000001', '01900001-0000-7000-8000-000000000009', TIMESTAMP '2026-04-24 06:41:00', 2.68, 2.50, 0.18, 'ALIVE', 'NORMAL', '22222222-0000-7000-8000-000000000001', now(), now());

SELECT pg_temp.expect_failure('alive fish cannot have an exit', $sql$
    INSERT INTO clone_fish (id, fish_code, running_no, dob, donor_cell_line_id, status, biological_condition, sex, exit_date, exit_reason, created_at, updated_at) VALUES
    ('bbbbbbbb-0000-7000-8000-000000000001', 'No.1_Clone1-AB cell-24', 1, '2026-04-24', '55555555-0000-7000-8000-000000000001', 'ALIVE', 'NORMAL', 'UNKNOWN', '2026-05-01', 'FROZEN', now(), now())
$sql$);
SELECT pg_temp.expect_failure('status and exit reason must agree', $sql$
    INSERT INTO clone_fish (id, fish_code, running_no, dob, donor_cell_line_id, status, biological_condition, sex, exit_date, exit_reason, created_at, updated_at) VALUES
    ('bbbbbbbb-0000-7000-8000-000000000004', 'No.4_Clone4-AB cell-24', 4, '2026-04-24', '55555555-0000-7000-8000-000000000001', 'DEAD', 'NORMAL', 'UNKNOWN', '2026-05-01', 'FROZEN', now(), now())
$sql$);
INSERT INTO clone_fish (id, fish_code, running_no, dob, donor_cell_line_id, status, biological_condition, sex, exit_date, exit_reason, created_at, updated_at) VALUES
    ('bbbbbbbb-0000-7000-8000-000000000002', 'No.1_Clone1-AB cell-24', 1, '2026-04-24', '55555555-0000-7000-8000-000000000001', 'FROZEN', 'ABNORMAL', 'UNKNOWN', '2026-05-01', 'FROZEN', now(), now());
SELECT pg_temp.expect_failure('running number must be unique', $sql$
    INSERT INTO clone_fish (id, fish_code, running_no, dob, donor_cell_line_id, status, biological_condition, sex, created_at, updated_at) VALUES
    ('bbbbbbbb-0000-7000-8000-000000000003', 'No.2_Clone2-AB cell-24', 1, '2026-04-24', '55555555-0000-7000-8000-000000000001', 'ALIVE', 'NORMAL', 'UNKNOWN', now(), now())
$sql$);
SELECT pg_temp.expect_failure('expected HPA cannot be negative', $sql$
    INSERT INTO stage_timing (id, profile_id, stage_definition_id, expected_hpa, created_at, updated_at) VALUES
    ('cccccccc-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002', '01900001-0000-7000-8000-000000000001', -1, now(), now())
$sql$);

ROLLBACK;
\echo 'PostgreSQL constraint checks passed.'

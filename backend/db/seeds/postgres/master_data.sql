-- =============================================================================
-- Optional master data seed (SRS section 12 "Initial Setup", steps I3–I4).
--
-- This is NOT a migration.  Migrations define structure; this file loads the
-- lab's starting reference data so nobody has to type it on day one.  Run it
-- once against a fresh database, then let the lab maintain these rows through
-- the UI.
--
-- Values are the distinct values found in the customer's existing spreadsheets,
-- already normalised (trailing spaces stripped, 'Disscard' spelling fixed).
-- No experimental data is imported — that is explicitly out of scope (Q10).
--
-- Safe to re-run: every statement is guarded by a NOT EXISTS check.
-- =============================================================================

INSERT INTO site (id, code, name, active, created_at, updated_at)
SELECT * FROM (VALUES
    ('10000000-0000-7000-8000-000000000001', 'KU',  'Kasetsart University',    TRUE, TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00'),
    ('10000000-0000-7000-8000-000000000002', 'MSU', 'Mahasarakham University', TRUE, TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00')
) AS v(id, code, name, active, created_at, updated_at)
WHERE NOT EXISTS (SELECT 1 FROM site WHERE site.code = v.code);

INSERT INTO operator (id, site_id, name, active, created_at, updated_at)
SELECT * FROM (VALUES
    ('20000000-0000-7000-8000-000000000001', '10000000-0000-7000-8000-000000000001', 'Jan',  TRUE, TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00'),
    ('20000000-0000-7000-8000-000000000002', '10000000-0000-7000-8000-000000000001', 'June', TRUE, TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00'),
    ('20000000-0000-7000-8000-000000000003', '10000000-0000-7000-8000-000000000001', 'Bee',  TRUE, TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00'),
    ('20000000-0000-7000-8000-000000000004', '10000000-0000-7000-8000-000000000001', 'Toon', TRUE, TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00')
) AS v(id, site_id, name, active, created_at, updated_at)
WHERE NOT EXISTS (SELECT 1 FROM operator WHERE operator.name = v.name);

-- Three strains x two preparations.  batch_code is left NULL here; the lab
-- adds dated cell batches (e.g. 'AB240426_e48h') as they prepare them.
INSERT INTO donor_cell_line (id, strain, preparation, batch_code, active, created_at, updated_at)
SELECT * FROM (VALUES
    ('30000000-0000-7000-8000-000000000001', 'AB',    'DISSOCIATED', NULL::varchar, TRUE, TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00'),
    ('30000000-0000-7000-8000-000000000002', 'AB',    'CHUNKS',      NULL::varchar, TRUE, TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00'),
    ('30000000-0000-7000-8000-000000000003', 'TU',    'DISSOCIATED', NULL::varchar, TRUE, TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00'),
    ('30000000-0000-7000-8000-000000000004', 'TU',    'CHUNKS',      NULL::varchar, TRUE, TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00'),
    ('30000000-0000-7000-8000-000000000005', 'NHGRI', 'DISSOCIATED', NULL::varchar, TRUE, TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00'),
    ('30000000-0000-7000-8000-000000000006', 'NHGRI', 'CHUNKS',      NULL::varchar, TRUE, TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00')
) AS v(id, strain, preparation, batch_code, active, created_at, updated_at)
WHERE NOT EXISTS (
    SELECT 1 FROM donor_cell_line d
    WHERE d.strain = v.strain AND d.preparation = v.preparation AND d.batch_code IS NULL
);

INSERT INTO treatment_group (id, code, name, arm_type, active, created_at, updated_at)
SELECT * FROM (VALUES
    ('40000000-0000-7000-8000-000000000001', 'CONTROL',          'SCNT control',              'SCNT',             TRUE, TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00'),
    ('40000000-0000-7000-8000-000000000002', 'RK701',            'SCNT + RK701',              'SCNT',             TRUE, TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00'),
    ('40000000-0000-7000-8000-000000000003', 'NATURAL_BREEDING', 'Natural breeding control',  'NATURAL_BREEDING', TRUE, TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00'),
    ('40000000-0000-7000-8000-000000000004', 'IVF',              'IVF control',               'IVF',              TRUE, TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 00:00:00')
) AS v(id, code, name, arm_type, active, created_at, updated_at)
WHERE NOT EXISTS (SELECT 1 FROM treatment_group WHERE treatment_group.code = v.code);

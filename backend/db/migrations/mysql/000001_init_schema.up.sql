-- ===========================================================================
-- GENERATED FILE — do not edit by hand.
-- Source: backend/db/migrations/postgres/000001_init_schema.up.sql
-- Regenerate: python3 scripts/gen_mysql_migrations.py
-- ===========================================================================

-- =============================================================================
-- SCNT Tracking System — Initial schema
-- Target: PostgreSQL 16 (MySQL 8 equivalent in ../mysql/)
-- Ref: SRS v1.0 section 5
--
-- Portability rules enforced here (SRS CON-04, DC-01):
--   * ids are CHAR(36) holding UUID v7 text — no native uuid type
--   * timestamps always hold UTC, in the engine's plain date-time type
--     (PostgreSQL DATETIME(3) / MySQL DATETIME(3)) — never a zone-aware type
--   * enums are VARCHAR + CHECK — never native ENUM
--   * no materialized views, no stored procedures, no business-logic triggers
--   * soft-delete uniqueness uses a generated marker column instead of a
--     partial index, because MySQL has no partial indexes (see note below)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Reference / master data
-- -----------------------------------------------------------------------------

CREATE TABLE site (
    id          CHAR(36)     NOT NULL,
    code        VARCHAR(20)  NOT NULL,
    code_norm   VARCHAR(20)  GENERATED ALWAYS AS (LOWER(TRIM(code))) STORED,
    name        VARCHAR(200) NOT NULL,
    active      BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at  DATETIME(3)    NOT NULL,
    updated_at  DATETIME(3)    NOT NULL,
    deleted_at  DATETIME(3)        NULL,
    CONSTRAINT pk_site PRIMARY KEY (id),
    CONSTRAINT uq_site_code UNIQUE (code_norm)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE operator (
    id          CHAR(36)     NOT NULL,
    site_id     CHAR(36)         NULL,
    name        VARCHAR(100) NOT NULL,
    name_norm   VARCHAR(100) GENERATED ALWAYS AS (LOWER(TRIM(name))) STORED,
    active      BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at  DATETIME(3)    NOT NULL,
    updated_at  DATETIME(3)    NOT NULL,
    deleted_at  DATETIME(3)        NULL,
    CONSTRAINT pk_operator PRIMARY KEY (id),
    CONSTRAINT uq_operator_name UNIQUE (name_norm),
    CONSTRAINT fk_operator_site FOREIGN KEY (site_id) REFERENCES site (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE donor_cell_line (
    id            CHAR(36)     NOT NULL,
    strain        VARCHAR(50)  NOT NULL,
    preparation   VARCHAR(50)  NOT NULL,
    batch_code    VARCHAR(100)     NULL,
    -- three separate normalised columns rather than one concatenated key:
    -- string concatenation differs between engines, COALESCE does not, and
    -- COALESCE keeps batch_code NULLs from defeating the unique constraint
    strain_norm      VARCHAR(50)  GENERATED ALWAYS AS (LOWER(TRIM(strain))) STORED,
    preparation_norm VARCHAR(50)  GENERATED ALWAYS AS (LOWER(TRIM(preparation))) STORED,
    batch_code_norm  VARCHAR(100) GENERATED ALWAYS AS (LOWER(TRIM(COALESCE(batch_code, '')))) STORED,
    active        BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at    DATETIME(3)    NOT NULL,
    updated_at    DATETIME(3)    NOT NULL,
    deleted_at    DATETIME(3)        NULL,
    CONSTRAINT pk_donor_cell_line PRIMARY KEY (id),
    CONSTRAINT uq_donor_cell_line UNIQUE (strain_norm, preparation_norm, batch_code_norm),
    CONSTRAINT ck_donor_preparation CHECK (preparation IN ('DISSOCIATED', 'CHUNKS'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE recipient_egg_lot (
    id          CHAR(36)     NOT NULL,
    breed       VARCHAR(100) NOT NULL,
    lot_date    DATE             NULL,
    label       VARCHAR(200) NOT NULL,
    label_norm  VARCHAR(200) GENERATED ALWAYS AS (LOWER(TRIM(label))) STORED,
    active      BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at  DATETIME(3)    NOT NULL,
    updated_at  DATETIME(3)    NOT NULL,
    deleted_at  DATETIME(3)        NULL,
    CONSTRAINT pk_recipient_egg_lot PRIMARY KEY (id),
    CONSTRAINT uq_recipient_egg_lot_label UNIQUE (label_norm)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE csof_lot (
    id             CHAR(36)     NOT NULL,
    lot_code       VARCHAR(100) NOT NULL,
    lot_code_norm  VARCHAR(100) GENERATED ALWAYS AS (LOWER(TRIM(lot_code))) STORED,
    active         BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at     DATETIME(3)    NOT NULL,
    updated_at     DATETIME(3)    NOT NULL,
    deleted_at     DATETIME(3)        NULL,
    CONSTRAINT pk_csof_lot PRIMARY KEY (id),
    CONSTRAINT uq_csof_lot_code UNIQUE (lot_code_norm)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE treatment_group (
    id          CHAR(36)     NOT NULL,
    code        VARCHAR(50)  NOT NULL,
    code_norm   VARCHAR(50)  GENERATED ALWAYS AS (LOWER(TRIM(code))) STORED,
    name        VARCHAR(200)     NULL,
    arm_type    VARCHAR(20)  NOT NULL,
    active      BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at  DATETIME(3)    NOT NULL,
    updated_at  DATETIME(3)    NOT NULL,
    deleted_at  DATETIME(3)        NULL,
    CONSTRAINT pk_treatment_group PRIMARY KEY (id),
    CONSTRAINT uq_treatment_group_code UNIQUE (code_norm),
    CONSTRAINT ck_treatment_arm_type CHECK (arm_type IN ('SCNT', 'NATURAL_BREEDING', 'IVF'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE fish_box (
    id            CHAR(36)    NOT NULL,
    box_code      VARCHAR(50) NOT NULL,
    box_code_norm VARCHAR(50) GENERATED ALWAYS AS (LOWER(TRIM(box_code))) STORED,
    site_id       CHAR(36)        NULL,
    active        BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at    DATETIME(3)   NOT NULL,
    updated_at    DATETIME(3)   NOT NULL,
    deleted_at    DATETIME(3)       NULL,
    CONSTRAINT pk_fish_box PRIMARY KEY (id),
    CONSTRAINT uq_fish_box UNIQUE (site_id, box_code_norm),
    CONSTRAINT fk_fish_box_site FOREIGN KEY (site_id) REFERENCES site (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Protocol and reference timing (SRS 5.4, BR-03, BR-21)
-- -----------------------------------------------------------------------------

CREATE TABLE protocol (
    id                   CHAR(36)     NOT NULL,
    name                 VARCHAR(200) NOT NULL,
    stage1_max_age_days  INTEGER      NOT NULL DEFAULT 5,
    active               BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at           DATETIME(3)    NOT NULL,
    updated_at           DATETIME(3)    NOT NULL,
    deleted_at           DATETIME(3)        NULL,
    CONSTRAINT pk_protocol PRIMARY KEY (id),
    CONSTRAINT ck_protocol_stage1_days CHECK (stage1_max_age_days > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE stage_definition (
    id           CHAR(36)     NOT NULL,
    protocol_id  CHAR(36)     NOT NULL,
    stage_order  INTEGER      NOT NULL,
    code         VARCHAR(50)  NOT NULL,
    label        VARCHAR(100) NOT NULL,
    short_label  VARCHAR(20)  NOT NULL,
    phase        VARCHAR(20)  NOT NULL,
    stage_scope  VARCHAR(10)  NOT NULL,
    created_at   DATETIME(3)    NOT NULL,
    updated_at   DATETIME(3)    NOT NULL,
    deleted_at   DATETIME(3)        NULL,
    CONSTRAINT pk_stage_definition PRIMARY KEY (id),
    CONSTRAINT uq_stage_definition_order UNIQUE (protocol_id, stage_order),
    CONSTRAINT uq_stage_definition_code  UNIQUE (protocol_id, code),
    CONSTRAINT fk_stage_definition_protocol FOREIGN KEY (protocol_id) REFERENCES protocol (id),
    CONSTRAINT ck_stage_phase CHECK (phase IN ('CLEAVAGE', 'BLASTULA', 'GASTRULA', 'LARVAL')),
    CONSTRAINT ck_stage_scope CHECK (stage_scope IN ('STAGE_1', 'STAGE_2')),
    CONSTRAINT ck_stage_order CHECK (stage_order > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE stage_timing_profile (
    id                      CHAR(36)      NOT NULL,
    protocol_id             CHAR(36)      NOT NULL,
    version                 INTEGER       NOT NULL,
    name                    VARCHAR(200)  NOT NULL,
    reference_temp_c        DECIMAL(4,1)      NULL DEFAULT 28.5,
    auto_temp_adjust        BOOLEAN       NOT NULL DEFAULT FALSE,
    source_note             VARCHAR(500)      NULL,
    is_current              BOOLEAN       NOT NULL DEFAULT FALSE,
    created_by_operator_id  CHAR(36)          NULL,
    created_at              DATETIME(3)     NOT NULL,
    updated_at              DATETIME(3)     NOT NULL,
    deleted_at              DATETIME(3)         NULL,
    current_marker          CHAR(36)      GENERATED ALWAYS AS (
                                CASE WHEN is_current = TRUE AND deleted_at IS NULL THEN '0' ELSE id END
                            ) STORED,
    CONSTRAINT pk_stage_timing_profile PRIMARY KEY (id),
    CONSTRAINT uq_stage_timing_profile_version UNIQUE (protocol_id, version),
    CONSTRAINT uq_stage_timing_profile_protocol UNIQUE (id, protocol_id),
    CONSTRAINT uq_stage_timing_profile_current UNIQUE (protocol_id, current_marker),
    CONSTRAINT fk_stage_timing_profile_protocol FOREIGN KEY (protocol_id) REFERENCES protocol (id),
    CONSTRAINT fk_stage_timing_profile_operator FOREIGN KEY (created_by_operator_id) REFERENCES operator (id),
    CONSTRAINT ck_timing_profile_version CHECK (version > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE stage_timing (
    id                   CHAR(36)      NOT NULL,
    profile_id           CHAR(36)      NOT NULL,
    stage_definition_id  CHAR(36)      NOT NULL,
    expected_hpa         DECIMAL(10,4) NOT NULL,
    created_at           DATETIME(3)     NOT NULL,
    updated_at           DATETIME(3)     NOT NULL,
    deleted_at           DATETIME(3)         NULL,
    CONSTRAINT pk_stage_timing PRIMARY KEY (id),
    CONSTRAINT uq_stage_timing UNIQUE (profile_id, stage_definition_id),
    CONSTRAINT fk_stage_timing_profile FOREIGN KEY (profile_id) REFERENCES stage_timing_profile (id),
    CONSTRAINT fk_stage_timing_stage FOREIGN KEY (stage_definition_id) REFERENCES stage_definition (id),
    CONSTRAINT ck_stage_timing_hpa CHECK (expected_hpa >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Experiment structure (SRS 5.5)
-- -----------------------------------------------------------------------------

CREATE TABLE experiment_batch (
    id                     CHAR(36)      NOT NULL,
    batch_code             VARCHAR(100)  NOT NULL,
    batch_code_norm        VARCHAR(100)  GENERATED ALWAYS AS (LOWER(TRIM(batch_code))) STORED,
    experiment_date        DATE          NOT NULL,
    day_no                 INTEGER           NULL,
    site_id                CHAR(36)      NOT NULL,
    operator_id            CHAR(36)      NOT NULL,
    protocol_id            CHAR(36)      NOT NULL,
    timing_profile_id      CHAR(36)      NOT NULL,   -- pinned at creation (FR-303, BR-21)
    treatment_group_id     CHAR(36)      NOT NULL,
    recipient_egg_lot_id   CHAR(36)          NULL,
    csof_lot_id            CHAR(36)          NULL,
    clutch_code            VARCHAR(50)       NULL,
    replicate_no           INTEGER           NULL,
    incubation_temp_c      DECIMAL(4,1)      NULL,   -- recorded, unused in v1 (ASM-01)
    notes                  TEXT              NULL,
    created_at             DATETIME(3)     NOT NULL,
    updated_at             DATETIME(3)     NOT NULL,
    deleted_at             DATETIME(3)         NULL,
    CONSTRAINT pk_experiment_batch PRIMARY KEY (id),
    CONSTRAINT uq_experiment_batch_code UNIQUE (batch_code_norm),
    CONSTRAINT fk_batch_site       FOREIGN KEY (site_id)              REFERENCES site (id),
    CONSTRAINT fk_batch_operator   FOREIGN KEY (operator_id)          REFERENCES operator (id),
    CONSTRAINT fk_batch_protocol   FOREIGN KEY (protocol_id)          REFERENCES protocol (id),
    CONSTRAINT fk_batch_timing     FOREIGN KEY (timing_profile_id, protocol_id) REFERENCES stage_timing_profile (id, protocol_id),
    CONSTRAINT fk_batch_treatment  FOREIGN KEY (treatment_group_id)   REFERENCES treatment_group (id),
    CONSTRAINT fk_batch_egg_lot    FOREIGN KEY (recipient_egg_lot_id) REFERENCES recipient_egg_lot (id),
    CONSTRAINT fk_batch_csof_lot   FOREIGN KEY (csof_lot_id)          REFERENCES csof_lot (id),
    CONSTRAINT ck_batch_temp CHECK (incubation_temp_c IS NULL OR (incubation_temp_c >= 0 AND incubation_temp_c <= 50))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE injection_lot (
    id                   CHAR(36)     NOT NULL,
    batch_id             CHAR(36)     NOT NULL,
    lot_no               VARCHAR(20)  NOT NULL,   -- text: real data has both '1' and 'June_2'
    lot_no_norm          VARCHAR(20)  GENERATED ALWAYS AS (LOWER(TRIM(lot_no))) STORED,
    donor_cell_line_id   CHAR(36)     NOT NULL,
    enu_power_pct        INTEGER          NULL,
    enu_pulse_us         INTEGER          NULL,
    enu_led              INTEGER          NULL,
    enu_start_at         DATETIME(3)        NULL,
    enu_finish_at        DATETIME(3)        NULL,
    activated_at         DATETIME(3)    NOT NULL,   -- T0 for the whole system (BR-01)
    n_eggs               INTEGER          NULL,
    n_activated          INTEGER      NOT NULL,
    notes                TEXT             NULL,
    created_at           DATETIME(3)    NOT NULL,
    updated_at           DATETIME(3)    NOT NULL,
    deleted_at           DATETIME(3)        NULL,
    CONSTRAINT pk_injection_lot PRIMARY KEY (id),
    CONSTRAINT uq_injection_lot UNIQUE (batch_id, lot_no_norm),
    CONSTRAINT fk_lot_batch FOREIGN KEY (batch_id)           REFERENCES experiment_batch (id),
    CONSTRAINT fk_lot_donor FOREIGN KEY (donor_cell_line_id) REFERENCES donor_cell_line (id),
    CONSTRAINT ck_lot_n_activated CHECK (n_activated >= 0),
    CONSTRAINT ck_lot_n_eggs      CHECK (n_eggs IS NULL OR n_eggs >= 0),
    CONSTRAINT ck_lot_power       CHECK (enu_power_pct IS NULL OR (enu_power_pct BETWEEN 0 AND 100))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE embryo (
    id                CHAR(36)     NOT NULL,
    injection_lot_id  CHAR(36)     NOT NULL,
    seq_in_lot        INTEGER      NOT NULL,
    embryo_code       VARCHAR(150) NOT NULL,
    embryo_code_norm  VARCHAR(150) GENERATED ALWAYS AS (LOWER(TRIM(embryo_code))) STORED,
    well_position     VARCHAR(5)       NULL,
    exit_stage_id     CHAR(36)         NULL,
    exit_at           DATETIME(3)        NULL,
    exit_reason       VARCHAR(20)      NULL,
    first_abnormal_observation_id CHAR(36) NULL,   -- FK added at end of file (circular)
    created_at        DATETIME(3)    NOT NULL,
    updated_at        DATETIME(3)    NOT NULL,
    deleted_at        DATETIME(3)        NULL,
    CONSTRAINT pk_embryo PRIMARY KEY (id),
    CONSTRAINT uq_embryo_code UNIQUE (embryo_code_norm),
    CONSTRAINT uq_embryo_seq  UNIQUE (injection_lot_id, seq_in_lot),
    CONSTRAINT fk_embryo_lot        FOREIGN KEY (injection_lot_id) REFERENCES injection_lot (id),
    CONSTRAINT fk_embryo_exit_stage FOREIGN KEY (exit_stage_id)    REFERENCES stage_definition (id),
    CONSTRAINT ck_embryo_exit_reason CHECK (exit_reason IS NULL OR exit_reason IN ('DEAD', 'DEGENERATED', 'PROMOTED', 'LOST')),
    CONSTRAINT ck_embryo_seq CHECK (seq_in_lot > 0),
    -- exit fields travel together
    CONSTRAINT ck_embryo_exit_consistent CHECK (
        (exit_reason IS NULL AND exit_at IS NULL) OR (exit_reason IS NOT NULL AND exit_at IS NOT NULL)
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE embryo_observation (
    id                     CHAR(36)      NOT NULL,
    client_uuid            CHAR(36)      NOT NULL,   -- idempotency key (BR-18)
    embryo_id              CHAR(36)      NOT NULL,
    stage_definition_id    CHAR(36)      NOT NULL,
    observed_at            DATETIME(3)     NOT NULL,
    hpa_actual             DECIMAL(10,4) NOT NULL,   -- BR-02
    hpa_expected_snapshot  DECIMAL(10,4) NOT NULL,   -- BR-03, frozen at write
    deviation_h            DECIMAL(10,4) NOT NULL,   -- BR-04
    outcome                VARCHAR(20)   NOT NULL,
    biological_condition   VARCHAR(20)   NOT NULL,
    operator_id            CHAR(36)      NOT NULL,
    device_id              VARCHAR(64)       NULL,
    is_backdated           BOOLEAN       NOT NULL DEFAULT FALSE,
    override_reason        VARCHAR(500)      NULL,
    notes                  TEXT              NULL,
    created_at             DATETIME(3)     NOT NULL,
    updated_at             DATETIME(3)     NOT NULL,
    deleted_at             DATETIME(3)         NULL,
    -- '0' while live, id once soft-deleted: gives "unique among live rows"
    -- on both PostgreSQL and MySQL without needing a partial index (SRS 5.8)
    live_marker            CHAR(36)      GENERATED ALWAYS AS (
                               CASE WHEN deleted_at IS NULL THEN '0' ELSE id END
                           ) STORED,
    CONSTRAINT pk_embryo_observation PRIMARY KEY (id),
    CONSTRAINT uq_embryo_obs_client UNIQUE (client_uuid),
    CONSTRAINT uq_embryo_obs_live   UNIQUE (embryo_id, stage_definition_id, live_marker),
    CONSTRAINT fk_embryo_obs_embryo   FOREIGN KEY (embryo_id)           REFERENCES embryo (id),
    CONSTRAINT fk_embryo_obs_stage    FOREIGN KEY (stage_definition_id) REFERENCES stage_definition (id),
    CONSTRAINT fk_embryo_obs_operator FOREIGN KEY (operator_id)         REFERENCES operator (id),
    CONSTRAINT ck_embryo_obs_outcome   CHECK (outcome   IN ('ALIVE', 'DEAD', 'DEGENERATED', 'NOT_OBSERVED')),
    CONSTRAINT ck_embryo_obs_condition CHECK (biological_condition IN ('NORMAL', 'ABNORMAL', 'UNDETERMINED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE control_arm_count (
    id                   CHAR(36)    NOT NULL,
    batch_id             CHAR(36)    NOT NULL,
    arm_type             VARCHAR(20) NOT NULL,
    stage_definition_id  CHAR(36)    NOT NULL,
    n_normal             INTEGER     NOT NULL DEFAULT 0,
    n_abnormal           INTEGER     NOT NULL DEFAULT 0,
    created_at           DATETIME(3)   NOT NULL,
    updated_at           DATETIME(3)   NOT NULL,
    deleted_at           DATETIME(3)       NULL,
    CONSTRAINT pk_control_arm_count PRIMARY KEY (id),
    CONSTRAINT uq_control_arm_count UNIQUE (batch_id, arm_type, stage_definition_id),
    CONSTRAINT fk_cac_batch FOREIGN KEY (batch_id)            REFERENCES experiment_batch (id),
    CONSTRAINT fk_cac_stage FOREIGN KEY (stage_definition_id) REFERENCES stage_definition (id),
    CONSTRAINT ck_cac_arm_type CHECK (arm_type IN ('NATURAL_BREEDING', 'IVF')),
    CONSTRAINT ck_cac_counts   CHECK (n_normal >= 0 AND n_abnormal >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Clone fish (Stage 2) — SRS 5.6
-- -----------------------------------------------------------------------------

CREATE TABLE clone_fish (
    id                       CHAR(36)     NOT NULL,
    embryo_id                CHAR(36)         NULL,
    fish_code                VARCHAR(150) NOT NULL,
    fish_code_norm           VARCHAR(150) GENERATED ALWAYS AS (LOWER(TRIM(fish_code))) STORED,
    running_no               INTEGER      NOT NULL,
    dob                      DATE         NOT NULL,   -- = date(activated_at) (BR-10)
    donor_cell_line_id       CHAR(36)     NOT NULL,
    site_id                  CHAR(36)         NULL,
    fish_box_id              CHAR(36)         NULL,
    status                   VARCHAR(20)  NOT NULL DEFAULT 'ALIVE',
    biological_condition     VARCHAR(20)  NOT NULL DEFAULT 'NORMAL',
    first_abnormal_on        DATE             NULL,
    first_abnormal_age_days  INTEGER          NULL,
    first_abnormal_stage_id  CHAR(36)         NULL,
    sex                      VARCHAR(10)  NOT NULL DEFAULT 'UNKNOWN',
    fin_clipped              BOOLEAN      NOT NULL DEFAULT FALSE,
    exit_date                DATE             NULL,
    exit_reason              VARCHAR(20)      NULL,
    remarks                  TEXT             NULL,
    created_at               DATETIME(3)    NOT NULL,
    updated_at               DATETIME(3)    NOT NULL,
    deleted_at               DATETIME(3)        NULL,
    CONSTRAINT pk_clone_fish PRIMARY KEY (id),
    CONSTRAINT uq_clone_fish_code   UNIQUE (fish_code_norm),
    CONSTRAINT uq_clone_fish_running UNIQUE (running_no),
    CONSTRAINT uq_clone_fish_embryo UNIQUE (embryo_id),
    CONSTRAINT fk_fish_embryo FOREIGN KEY (embryo_id)               REFERENCES embryo (id),
    CONSTRAINT fk_fish_donor  FOREIGN KEY (donor_cell_line_id)      REFERENCES donor_cell_line (id),
    CONSTRAINT fk_fish_site   FOREIGN KEY (site_id)                 REFERENCES site (id),
    CONSTRAINT fk_fish_box    FOREIGN KEY (fish_box_id)             REFERENCES fish_box (id),
    CONSTRAINT fk_fish_abn_stage FOREIGN KEY (first_abnormal_stage_id) REFERENCES stage_definition (id),
    CONSTRAINT ck_fish_status    CHECK (status    IN ('ALIVE', 'DEAD', 'FROZEN', 'DISCARDED')),
    CONSTRAINT ck_fish_condition CHECK (biological_condition IN ('NORMAL', 'ABNORMAL', 'UNDETERMINED')),
    CONSTRAINT ck_fish_sex       CHECK (sex       IN ('M', 'F', 'UNKNOWN')),
    CONSTRAINT ck_fish_exit_reason CHECK (exit_reason IS NULL OR exit_reason IN ('DEAD', 'FROZEN', 'DISCARDED', 'LOST')),
    CONSTRAINT ck_fish_running   CHECK (running_no > 0),
    -- a fish that has left must have both a date and a reason; one alive must have neither
    CONSTRAINT ck_fish_exit_consistent CHECK (
        (status = 'ALIVE'     AND exit_date IS NULL     AND exit_reason IS NULL) OR
        (status = 'DEAD'      AND exit_date IS NOT NULL AND exit_reason = 'DEAD') OR
        (status = 'FROZEN'    AND exit_date IS NOT NULL AND exit_reason = 'FROZEN') OR
        (status = 'DISCARDED' AND exit_date IS NOT NULL AND exit_reason IN ('DISCARDED', 'LOST'))
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE fish_observation (
    id             CHAR(36)    NOT NULL,
    client_uuid    CHAR(36)    NOT NULL,
    clone_fish_id  CHAR(36)    NOT NULL,
    observed_on    DATE        NOT NULL,   -- calendar date in Asia/Bangkok
    age_days       INTEGER     NOT NULL,   -- BR-11
    outcome        VARCHAR(20) NOT NULL,
    biological_condition VARCHAR(20) NOT NULL,
    operator_id    CHAR(36)    NOT NULL,
    device_id      VARCHAR(64)     NULL,
    is_backdated   BOOLEAN     NOT NULL DEFAULT FALSE,
    notes          TEXT            NULL,
    created_at     DATETIME(3)   NOT NULL,
    updated_at     DATETIME(3)   NOT NULL,
    deleted_at     DATETIME(3)       NULL,
    live_marker    CHAR(36)    GENERATED ALWAYS AS (
                       CASE WHEN deleted_at IS NULL THEN '0' ELSE id END
                   ) STORED,
    CONSTRAINT pk_fish_observation PRIMARY KEY (id),
    CONSTRAINT uq_fish_obs_client UNIQUE (client_uuid),
    CONSTRAINT uq_fish_obs_live   UNIQUE (clone_fish_id, observed_on, live_marker),
    CONSTRAINT fk_fish_obs_fish     FOREIGN KEY (clone_fish_id) REFERENCES clone_fish (id),
    CONSTRAINT fk_fish_obs_operator FOREIGN KEY (operator_id)   REFERENCES operator (id),
    CONSTRAINT ck_fish_obs_outcome   CHECK (outcome   IN ('ALIVE', 'DEAD', 'FROZEN', 'DISCARDED', 'NOT_OBSERVED')),
    CONSTRAINT ck_fish_obs_condition CHECK (biological_condition IN ('NORMAL', 'ABNORMAL', 'UNDETERMINED')),
    CONSTRAINT ck_fish_obs_age       CHECK (age_days >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE specimen (
    id               CHAR(36)    NOT NULL,
    clone_fish_id    CHAR(36)    NOT NULL,
    specimen_code    VARCHAR(50) NOT NULL,
    specimen_code_norm VARCHAR(50) GENERATED ALWAYS AS (LOWER(TRIM(specimen_code))) STORED,
    specimen_kind    VARCHAR(5)  NOT NULL,
    specimen_type    VARCHAR(30) NOT NULL,
    collected_on     DATE            NULL,
    frozen_on        DATE            NULL,
    storage          VARCHAR(10)     NULL,
    notes            TEXT            NULL,
    created_at       DATETIME(3)   NOT NULL,
    updated_at       DATETIME(3)   NOT NULL,
    deleted_at       DATETIME(3)       NULL,
    CONSTRAINT pk_specimen PRIMARY KEY (id),
    CONSTRAINT uq_specimen_code UNIQUE (specimen_code_norm),
    CONSTRAINT fk_specimen_fish FOREIGN KEY (clone_fish_id) REFERENCES clone_fish (id),
    CONSTRAINT ck_specimen_kind CHECK (specimen_kind IN ('CL', 'RT', 'DC')),
    CONSTRAINT ck_specimen_type CHECK (specimen_type IN ('WHOLE_EMBRYO', 'CAUDAL_FIN_CLIP')),
    CONSTRAINT ck_specimen_storage CHECK (storage IS NULL OR storage IN ('-20', '-80'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Audit (SRS 5.7, FR-1102)
-- -----------------------------------------------------------------------------

CREATE TABLE audit_log (
    id           CHAR(36)    NOT NULL,
    table_name   VARCHAR(64) NOT NULL,
    record_id    CHAR(36)    NOT NULL,
    action       VARCHAR(10) NOT NULL,
    old_values   TEXT            NULL,   -- JSON as text, portable across engines
    new_values   TEXT            NULL,
    operator_id  CHAR(36)        NULL,
    device_id    VARCHAR(64)     NULL,
    occurred_at  DATETIME(3)   NOT NULL,
    CONSTRAINT pk_audit_log PRIMARY KEY (id),
    CONSTRAINT fk_audit_operator FOREIGN KEY (operator_id) REFERENCES operator (id),
    CONSTRAINT ck_audit_action CHECK (action IN ('INSERT', 'UPDATE', 'DELETE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Deferred FK: embryo -> embryo_observation (circular reference)
-- -----------------------------------------------------------------------------

ALTER TABLE embryo
    ADD CONSTRAINT fk_embryo_first_abnormal
    FOREIGN KEY (first_abnormal_observation_id) REFERENCES embryo_observation (id);

-- -----------------------------------------------------------------------------
-- Indexes (SRS 5.8)
-- -----------------------------------------------------------------------------

CREATE INDEX ix_operator_site               ON operator (site_id);
CREATE INDEX ix_fish_box_site               ON fish_box (site_id);
CREATE INDEX ix_stage_definition_protocol   ON stage_definition (protocol_id, stage_order);
CREATE INDEX ix_stage_timing_profile_cur    ON stage_timing_profile (protocol_id, is_current);
CREATE INDEX ix_stage_timing_profile_fk     ON stage_timing_profile (created_by_operator_id);
CREATE INDEX ix_stage_timing_stage          ON stage_timing (stage_definition_id);

CREATE INDEX ix_batch_filter                ON experiment_batch (experiment_date, site_id, treatment_group_id);
CREATE INDEX ix_batch_operator              ON experiment_batch (operator_id);
CREATE INDEX ix_batch_protocol              ON experiment_batch (protocol_id);
CREATE INDEX ix_batch_timing_profile        ON experiment_batch (timing_profile_id);
CREATE INDEX ix_batch_egg_lot               ON experiment_batch (recipient_egg_lot_id);
CREATE INDEX ix_batch_csof_lot              ON experiment_batch (csof_lot_id);

CREATE INDEX ix_lot_batch_activated         ON injection_lot (batch_id, activated_at);
CREATE INDEX ix_lot_donor                   ON injection_lot (donor_cell_line_id);

CREATE INDEX ix_embryo_lot_exit             ON embryo (injection_lot_id, exit_reason);
CREATE INDEX ix_embryo_exit                 ON embryo (exit_reason, exit_at);
CREATE INDEX ix_embryo_exit_stage           ON embryo (exit_stage_id);
CREATE INDEX ix_embryo_first_abnormal       ON embryo (first_abnormal_observation_id);

CREATE INDEX ix_embryo_obs_stage_outcome    ON embryo_observation (stage_definition_id, outcome);
CREATE INDEX ix_embryo_obs_observed_at      ON embryo_observation (observed_at);
CREATE INDEX ix_embryo_obs_operator         ON embryo_observation (operator_id);

CREATE INDEX ix_cac_stage                   ON control_arm_count (stage_definition_id);

CREATE INDEX ix_fish_status_box             ON clone_fish (status, fish_box_id);
CREATE INDEX ix_fish_dob                    ON clone_fish (dob);
CREATE INDEX ix_fish_donor                  ON clone_fish (donor_cell_line_id);
CREATE INDEX ix_fish_site                   ON clone_fish (site_id);
CREATE INDEX ix_fish_abn_stage              ON clone_fish (first_abnormal_stage_id);

CREATE INDEX ix_fish_obs_date_outcome       ON fish_observation (observed_on, outcome);
CREATE INDEX ix_fish_obs_operator           ON fish_observation (operator_id);

CREATE INDEX ix_specimen_fish               ON specimen (clone_fish_id);

CREATE INDEX ix_audit_lookup                ON audit_log (table_name, record_id, occurred_at);

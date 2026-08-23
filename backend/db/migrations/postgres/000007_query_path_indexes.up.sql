-- Additive query-path indexes for keyset audit history and canonical worklists.
-- This migration does not alter existing tables or applied migrations.
CREATE INDEX ix_audit_occurred_id ON audit_log (occurred_at, id);
CREATE INDEX ix_observation_embryo_stage ON embryo_observation (embryo_id, stage_definition_id, deleted_at);
CREATE INDEX ix_fish_observation_fish_date ON fish_observation (clone_fish_id, observed_on, deleted_at);
CREATE INDEX ix_embryo_lot_exit_path ON embryo (injection_lot_id, deleted_at, exit_reason);
CREATE INDEX ix_stage_timing_profile_stage ON stage_timing (profile_id, stage_definition_id, deleted_at);

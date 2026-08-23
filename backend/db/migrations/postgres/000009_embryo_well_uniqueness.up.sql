-- A live well can hold at most one embryo in an injection lot. Soft-deleted
-- embryos use their own id as a marker so the well can be reused (BR-20).
ALTER TABLE embryo ADD COLUMN well_live_marker CHAR(36) GENERATED ALWAYS AS (
    CASE WHEN deleted_at IS NULL AND well_position IS NOT NULL THEN '0' ELSE id END
) STORED;

CREATE UNIQUE INDEX uq_embryo_live_well
    ON embryo (injection_lot_id, well_position, well_live_marker);

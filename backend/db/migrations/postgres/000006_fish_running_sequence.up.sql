-- Allocate fish running numbers under a database row lock so multiple API
-- instances cannot derive the same number from a stale process cache.
CREATE TABLE fish_running_sequence (
    id              CHAR(36) PRIMARY KEY,
    next_running_no INTEGER NOT NULL CHECK (next_running_no > 0)
);

INSERT INTO fish_running_sequence (id, next_running_no)
VALUES ('00000000-0000-7000-8000-000000000006', 1);

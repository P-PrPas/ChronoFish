CREATE TABLE IF NOT EXISTS chronofish_runtime_state (
    resource VARCHAR(80) NOT NULL,
    record_id CHAR(36) NOT NULL,
    payload TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMP NOT NULL,
    CONSTRAINT pk_chronofish_runtime_state PRIMARY KEY (resource, record_id)
);

CREATE TABLE IF NOT EXISTS chronofish_runtime_idempotency (
    scope VARCHAR(100) NOT NULL,
    response TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL,
    CONSTRAINT pk_chronofish_runtime_idempotency PRIMARY KEY (scope)
);

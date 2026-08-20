CREATE TABLE request_idempotency (
    scope           VARCHAR(180) NOT NULL,
    idempotency_key CHAR(36) NOT NULL,
    request_hash    CHAR(64) NOT NULL,
    status_code     INTEGER NOT NULL,
    content_type    VARCHAR(200) NOT NULL,
    response_body   TEXT NOT NULL,
    operator_id     CHAR(36) NOT NULL,
    device_id       VARCHAR(64) NOT NULL,
    created_at      TIMESTAMP NOT NULL,
    completed_at    TIMESTAMP NULL,
    CONSTRAINT pk_request_idempotency PRIMARY KEY (scope, idempotency_key),
    CONSTRAINT ck_request_idempotency_status CHECK (status_code >= 100 AND status_code <= 599),
    CONSTRAINT fk_request_idempotency_operator FOREIGN KEY (operator_id) REFERENCES operator (id)
);

CREATE INDEX ix_request_idempotency_created
    ON request_idempotency (created_at);

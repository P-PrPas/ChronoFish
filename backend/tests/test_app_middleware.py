from __future__ import annotations

import logging
from pathlib import Path

from fastapi import Request
from fastapi.testclient import TestClient

from chronofish.app import create_app
from chronofish.config import Config
from chronofish.runtime.errors import APIError
from chronofish.store import MemoryStore


def app_config(**overrides) -> Config:
    values = {
        "port": 8080,
        "app_env": "test",
        "db_driver": "memory",
        "database_url": "",
        "allowed_origins": (),
        "ip_allowlist": (),
        "migrations_dir": Path("."),
        "db_pool_size": 10,
        "db_max_overflow": 5,
    }
    values.update(overrides)
    return Config(**values)


def test_security_headers_are_present_on_success_and_error():
    with TestClient(create_app(app_config(), MemoryStore())) as client:
        success = client.get("/api/v1/health")
        error = client.get("/missing")

    for response in (success, error):
        assert response.headers["X-Content-Type-Options"] == "nosniff"
        assert response.headers["X-Frame-Options"] == "DENY"
        assert response.headers["Referrer-Policy"] == "no-referrer"
        assert response.headers["Permissions-Policy"] == "camera=(), geolocation=(), microphone=()"


def test_non_production_omits_hsts():
    with TestClient(create_app(app_config(), MemoryStore())) as client:
        assert "Strict-Transport-Security" not in client.get("/api/v1/health").headers


def test_json_responses_declare_utf8_charset(client, write_headers):
    response = client.post("/api/v1/sites", headers=write_headers, json={"code": "TH", "name": "ห้องแล็บ"})
    assert response.headers["Content-Type"] == "application/json; charset=utf-8"
    assert "ห้องแล็บ" in response.text


def test_rate_limit_blocks_after_120_requests_per_minute(client):
    for _ in range(120):
        assert client.get("/api/v1/health").status_code == 200

    response = client.get("/api/v1/health")
    assert response.status_code == 429
    assert response.headers["Retry-After"] == "60"
    assert response.json()["error"]["code"] == "rate_limited"


def test_invalid_content_length_header_is_rejected(client, write_headers):
    response = client.post(
        "/api/v1/sites",
        headers={**write_headers, "Content-Type": "application/json", "Content-Length": "abc"},
        content='{"code":"A","name":"A"}',
    )
    assert response.status_code == 400
    assert response.json()["error"]["message"] == "Content-Length is invalid"


def test_timing_csv_endpoint_rejects_json_content_type(client, write_headers):
    response = client.post(
        "/api/v1/timing-profiles/csv?protocolId=01900000-0000-7000-8000-000000000001",
        headers=write_headers,
        json={"entries": []},
    )
    assert response.status_code == 400
    assert response.json()["error"]["message"] == "Content-Type must be text/csv"


def test_get_with_body_is_content_type_checked(client):
    response = client.request(
        "GET", "/api/v1/health", headers={"Content-Type": "text/plain", "Content-Length": "1"}, content="x"
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_request"


def test_unhandled_exception_returns_redacted_500():
    app = create_app(app_config(), MemoryStore())

    @app.get("/boom")
    def boom():
        raise RuntimeError("secret detail")

    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/boom")

    assert response.status_code == 500
    assert response.json() == {"error": {"code": "internal_error", "message": "an unexpected error occurred"}}
    assert "secret detail" not in response.text


def test_api_error_raised_inside_a_route_is_serialized_once():
    app = create_app(app_config(), MemoryStore())

    @app.get("/conflict")
    def conflict():
        raise APIError(409, "conflict", "already exists", {"field": "code"})

    with TestClient(app) as client:
        response = client.get("/conflict")

    assert response.status_code == 409
    assert response.json() == {"error": {"code": "conflict", "message": "already exists", "details": {"field": "code"}}}


def test_cors_headers_present_only_when_origins_configured():
    with TestClient(create_app(app_config(allowed_origins=("https://x.example",)), MemoryStore())) as configured:
        allowed = configured.options(
            "/api/v1/sites",
            headers={
                "Origin": "https://x.example",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "X-Operator-Id,X-Device-Id,X-Idempotency-Key",
            },
        )
    with TestClient(create_app(app_config(), MemoryStore())) as absent:
        disabled = absent.options(
            "/api/v1/sites", headers={"Origin": "https://x.example", "Access-Control-Request-Method": "POST"}
        )

    assert allowed.headers["access-control-allow-origin"] == "https://x.example"
    assert "X-Idempotency-Key" in allowed.headers["access-control-allow-headers"]
    assert "access-control-allow-origin" not in disabled.headers


def test_openapi_and_docs_routes_are_disabled(client):
    assert [client.get(path).status_code for path in ("/docs", "/redoc", "/openapi.json")] == [404, 404, 404]


def test_request_log_records_metadata_only(caplog):
    app = create_app(app_config(), MemoryStore())

    @app.post("/echo")
    async def echo(request: Request):
        await request.body()
        return {"ok": True}

    caplog.set_level(logging.INFO, logger="chronofish.http")
    with TestClient(app) as client:
        assert client.post("/echo", json={"specimen": "secret-sample"}).status_code == 200

    assert "secret-sample" not in caplog.text

from __future__ import annotations

import ipaddress
from pathlib import Path
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request

from chronofish.app import create_app
from chronofish.config import Config
from chronofish.domain.rules import deviation_label, promotion_eligible_at, stage_code, stage_number
from chronofish.runtime.values import uuid7
from chronofish.store import MemoryStore


def test_health(client):
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.headers["Content-Type"] == "application/json; charset=utf-8"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["Permissions-Policy"] == "camera=(), geolocation=(), microphone=()"
    assert response.json()["status"] == "ok"


def test_production_sets_strict_transport_security():
    config = Config(8080, "production", "memory", "", (), (), Path("."), 10, 5)

    with TestClient(create_app(config, MemoryStore())) as production_client:
        response = production_client.get("/api/v1/health")

    assert response.headers["Strict-Transport-Security"] == "max-age=31536000; includeSubDomains"


def test_network_allowlist_denies_unknown_client():
    config = Config(8080, "test", "memory", "", (), (ipaddress.ip_network("10.0.0.0/8"),), Path("."), 10, 5)

    with TestClient(create_app(config, MemoryStore())) as restricted_client:
        response = restricted_client.get("/api/v1/health")

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "network_denied"
    assert response.headers["X-Content-Type-Options"] == "nosniff"


def test_uuid7_shape():
    values = {uuid7() for _ in range(100)}
    assert len(values) == 100
    assert all(UUID(value).version == 7 for value in values)


def test_domain_rules():
    from datetime import UTC, datetime, timedelta

    assert stage_number(stage_code(36)) == 36
    assert deviation_label(1.5) == "ช้ากว่าสากล 1 ชม. 30 นาที"
    activated = datetime(2026, 1, 1, tzinfo=UTC)
    assert not promotion_eligible_at(False, True, activated, activated + timedelta(days=5), 5)
    assert promotion_eligible_at(False, True, activated, activated + timedelta(days=5, seconds=1), 5)


@pytest.mark.parametrize(
    ("deviation", "language", "expected"),
    [
        (0.0, "th", "ตรงกับสากล"),
        (1 / 60, "th", "ช้ากว่าสากล 1 นาที"),
        (0.5, "en", "30 minutes slower than reference"),
        (1.5, "en", "1 hr 30 min slower than reference"),
        (-0.25, "en", "15 minutes faster than reference"),
    ],
)
def test_deviation_labels_follow_br23_in_both_languages(deviation, language, expected):
    assert deviation_label(deviation, language) == expected


def test_master_create_normalizes_rejects_duplicate_and_replays(client, write_headers):
    first = client.post("/api/v1/sites", headers=write_headers, json={"code": " Lab-A ", "name": " Main site "})
    assert first.status_code == 201
    assert first.json()["code"] == "Lab-A"
    duplicate = client.post("/api/v1/sites", headers=write_headers, json={"code": " Lab-A ", "name": " Main site "})
    assert duplicate.status_code == 201
    assert duplicate.content == first.content
    conflict_headers = {**write_headers, "X-Idempotency-Key": "01900000-0000-7000-8000-000000000100"}
    conflict = client.post("/api/v1/sites", headers=conflict_headers, json={"code": "lab-a", "name": "Other"})
    assert conflict.status_code == 409


def test_idempotency_replay_preserves_no_content_status(store, write_headers):
    scope = {
        "type": "http",
        "method": "DELETE",
        "path": "/api/v1/review-target",
        "query_string": b"",
        "headers": [(name.lower().encode(), value.encode()) for name, value in write_headers.items()],
    }

    def operation(_state):
        return 204, b""

    first = store.execute_mutation(Request(scope), {}, operation)
    replay = store.execute_mutation(Request(scope), {}, operation)

    assert first.status_code == replay.status_code == 204
    assert replay.body == b""


def test_inactive_master_is_hidden_by_default_but_resolvable_for_history(client, write_headers):
    created = client.post("/api/v1/sites", headers=write_headers, json={"code": "OLD", "name": "Old lab"}).json()
    update_headers = {**write_headers, "X-Idempotency-Key": "01900000-0000-7000-8000-000000000102"}
    assert (
        client.patch(f"/api/v1/sites/{created['id']}", headers=update_headers, json={"active": False}).status_code
        == 200
    )

    assert client.get("/api/v1/sites").json()["items"] == []
    historical = client.get("/api/v1/sites?includeInactive=true").json()["items"]
    assert [(item["id"], item["name"], item["active"]) for item in historical] == [(created["id"], "Old lab", False)]


def test_idempotency_key_rejects_different_payload(client, write_headers):
    write_headers = {**write_headers, "X-Idempotency-Key": "01900000-0000-7000-8000-000000000101"}
    assert client.post("/api/v1/sites", headers=write_headers, json={"code": "A", "name": "A"}).status_code == 201
    response = client.post("/api/v1/sites", headers=write_headers, json={"code": "B", "name": "B"})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "idempotency_conflict"


def test_writes_require_json_and_use_the_common_error_envelope(client, write_headers):
    response = client.post(
        "/api/v1/sites",
        headers={**write_headers, "Content-Type": "text/plain"},
        content='{"code":"A","name":"A"}',
    )
    assert response.status_code == 400
    assert response.headers["Content-Type"] == "application/json; charset=utf-8"
    assert response.json() == {
        "error": {
            "code": "invalid_request",
            "message": "Content-Type must be application/json",
        }
    }


def test_timing_csv_upload_accepts_its_contract_content_type(client, write_headers):
    response = client.post(
        "/api/v1/timing-profiles/csv?protocolId=01900000-0000-7000-8000-000000000001",
        headers={**write_headers, "Content-Type": "text/csv"},
        content="stage_order,stage_code,label,expected_hpa\n1,stage_01_1C,1-cell,2.0\n",
    )
    assert response.status_code == 201


def test_timing_csv_export_can_be_imported_without_changing_entries(client, write_headers):
    path = "/api/v1/timing-profiles/csv?protocolId=01900000-0000-7000-8000-000000000001"
    exported = client.get(path)

    assert exported.status_code == 200
    imported = client.post(
        path,
        headers={**write_headers, "Content-Type": "text/csv"},
        content=exported.content,
    )

    assert imported.status_code == 201, imported.text
    assert len(imported.json()["entries"]) == 36
    assert client.get(path).content == exported.content


def test_malformed_json_uses_the_common_error_envelope(client, write_headers):
    response = client.post(
        "/api/v1/sites",
        headers={**write_headers, "Content-Type": "application/json"},
        content="{",
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_request"


def test_oversized_declared_body_is_rejected(client, write_headers):
    response = client.post(
        "/api/v1/sites",
        headers={**write_headers, "Content-Type": "application/json", "Content-Length": str(10 * 1024 * 1024 + 1)},
        content='{"code":"A","name":"A"}',
    )

    assert response.status_code == 413
    assert response.json()["error"]["code"] == "request_too_large"
    assert response.headers["X-Content-Type-Options"] == "nosniff"


def test_write_context_headers_are_required(client):
    response = client.post("/api/v1/sites", json={"code": "A", "name": "A"})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_context"


def test_timing_profile_partial_override_keeps_36_stages(client, write_headers):
    response = client.post(
        "/api/v1/timing-profiles",
        headers=write_headers,
        json={
            "protocolId": "01900000-0000-7000-8000-000000000001",
            "name": "Custom",
            "entries": [{"stageOrder": 2, "stageCode": "stage_02_2C", "expectedHpa": 0.8}],
        },
    )
    assert response.status_code == 201, response.text
    assert len(response.json()["entries"]) == 36
    assert response.json()["entries"][1]["expectedHpa"] == 0.8


def test_protocol_stages_are_canonical_definitions_in_order(client):
    response = client.get("/api/v1/protocols/01900000-0000-7000-8000-000000000001/stages")

    assert response.status_code == 200
    items = response.json()["items"]
    assert len(items) == 36
    assert items[0] == {
        "id": "01900001-0000-7000-8000-000000000001",
        "stageOrder": 1,
        "code": "stage_01_1C",
        "label": "Activated (1-cell)",
        "shortLabel": "1C",
        "phase": "CLEAVAGE",
        "stageScope": "STAGE_1",
    }
    assert [(items[index]["label"], items[index]["shortLabel"], items[index]["phase"]) for index in (10, 15, 21)] == [
        ("1k-cell", "1K", "BLASTULA"),
        ("30% epiboly", "30EPI", "GASTRULA"),
        ("Day 1", "1D", "LARVAL"),
    ]
    assert (items[26]["label"], items[26]["stageScope"]) == ("Day 6", "STAGE_2")


def test_timing_profile_rejects_duplicate_stage_overrides_without_changing_current(client, write_headers):
    response = client.post(
        "/api/v1/timing-profiles",
        headers=write_headers,
        json={
            "protocolId": "01900000-0000-7000-8000-000000000001",
            "name": "Duplicate override",
            "entries": [
                {"stageCode": "stage_02_2C", "expectedHpa": 0.8},
                {"stageCode": "stage_02_2C", "expectedHpa": 0.9},
            ],
        },
    )

    assert response.status_code == 422
    current = client.get("/api/v1/timing-profiles/current?protocolId=01900000-0000-7000-8000-000000000001").json()
    assert current["version"] == 1
    assert current["entries"][1]["expectedHpa"] == 0.75


def test_timing_csv_reports_every_invalid_row_before_writing(client, write_headers):
    response = client.post(
        "/api/v1/timing-profiles/csv?protocolId=01900000-0000-7000-8000-000000000001",
        headers={**write_headers, "Content-Type": "text/csv"},
        content=(
            "stage_order,stage_code,label,expected_hpa\n"
            "2,stage_02_2C,2-cell,0.8\n"
            "2,stage_02_2C,2-cell,0.9\n"
            "4,stage_03_4C,4-cell,1.0\n"
            "5,stage_05_16C,16-cell,-1\n"
        ),
    )

    assert response.status_code == 422
    assert [error["row"] for error in response.json()["error"]["details"]["rows"]] == [3, 4, 5]
    current = client.get("/api/v1/timing-profiles/current?protocolId=01900000-0000-7000-8000-000000000001").json()
    assert current["version"] == 1


def test_timing_csv_reports_a_malformed_quoted_header(client, write_headers):
    response = client.post(
        "/api/v1/timing-profiles/csv?protocolId=01900000-0000-7000-8000-000000000001",
        headers={**write_headers, "Content-Type": "text/csv"},
        content='"stage_order,stage_code,label,expected_hpa\n',
    )

    assert response.status_code == 422
    assert response.json()["error"]["details"]["rows"][0]["row"] == 1

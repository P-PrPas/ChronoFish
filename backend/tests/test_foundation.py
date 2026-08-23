from __future__ import annotations

from uuid import UUID

from chronofish.core import uuid7
from chronofish.domain.rules import deviation_label, promotion_eligible_at, stage_code, stage_number


def test_health(client):
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


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


def test_master_create_normalizes_rejects_duplicate_and_replays(client, write_headers):
    first = client.post("/api/v1/sites", headers=write_headers, json={"code": " Lab-A ", "name": " Main site "})
    assert first.status_code == 201
    assert first.json()["code"] == "Lab-A"
    assert (
        client.post("/api/v1/sites", headers=write_headers, json={"code": " Lab-A ", "name": " Main site "}).content
        == first.content
    )
    conflict_headers = {**write_headers, "X-Idempotency-Key": "01900000-0000-7000-8000-000000000100"}
    conflict = client.post("/api/v1/sites", headers=conflict_headers, json={"code": "lab-a", "name": "Other"})
    assert conflict.status_code == 409


def test_idempotency_key_rejects_different_payload(client, write_headers):
    write_headers = {**write_headers, "X-Idempotency-Key": "01900000-0000-7000-8000-000000000101"}
    assert client.post("/api/v1/sites", headers=write_headers, json={"code": "A", "name": "A"}).status_code == 201
    response = client.post("/api/v1/sites", headers=write_headers, json={"code": "B", "name": "B"})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "idempotency_conflict"


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

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

import pytest
from starlette.requests import Request

from chronofish.domain.state import State
from chronofish.runtime.errors import APIError, error_response
from chronofish.runtime.mutations import audit, encode_result, request_fingerprint, validate_write_context
from chronofish.runtime.values import iso_now, normalize, parse_datetime, uuid7


def request_with_headers(
    path: str = "/api/v1/sites", method: str = "POST", headers: dict[str, str] | None = None
) -> Request:
    return Request(
        {
            "type": "http",
            "method": method,
            "path": path,
            "query_string": b"",
            "headers": [(key.lower().encode(), value.encode()) for key, value in (headers or {}).items()],
        }
    )


def test_uuid7_values_are_time_ordered_and_unique():
    values = [uuid7() for _ in range(1_000)]
    timestamps = [UUID(value).int >> 80 for value in values]

    assert len(set(values)) == len(values)
    assert timestamps == sorted(timestamps)


def test_iso_now_is_utc_with_z_suffix():
    value = iso_now()
    assert value.endswith("Z")
    assert parse_datetime(value).tzinfo == UTC


def test_parse_datetime_converts_offsets_to_utc():
    assert parse_datetime("2026-01-01T07:00:00+07:00") == datetime(2026, 1, 1, tzinfo=UTC)


def test_parse_datetime_accepts_z_suffix():
    assert parse_datetime("2026-01-01T00:00:00Z").tzinfo == UTC


def test_parse_datetime_rejects_naive_timestamp():
    with pytest.raises(APIError, match="timestamp ต้องระบุ timezone"):
        parse_datetime("2026-01-01T00:00:00")


@pytest.mark.parametrize("value", ("tomorrow", "", None))
def test_parse_datetime_rejects_garbage(value):
    with pytest.raises(APIError, match="timestamp ต้องเป็น ISO 8601 พร้อม timezone"):
        parse_datetime(value)


def test_normalize_trims_strings_recursively():
    assert normalize({"value": " a ", "nested": [" b ", {"c": " c "}], "plain": 1, "bool": True, "none": None}) == {
        "value": "a",
        "nested": ["b", {"c": "c"}],
        "plain": 1,
        "bool": True,
        "none": None,
    }


def test_error_response_shape_and_optional_details():
    plain = error_response(APIError(422, "validation_error", "x"))
    detailed = error_response(APIError(422, "validation_error", "x", {"field": "name"}))

    assert plain.body == b'{"error":{"code":"validation_error","message":"x"}}'
    assert detailed.body == b'{"error":{"code":"validation_error","message":"x","details":{"field":"name"}}}'


def test_operator_header_must_be_uuid(client, write_headers):
    response = client.post(
        "/api/v1/sites", headers={**write_headers, "X-Operator-Id": "bob"}, json={"code": "A", "name": "A"}
    )
    assert response.status_code == 400
    assert response.json()["error"]["message"] == "X-Operator-Id ต้องเป็น UUID"


@pytest.mark.parametrize("device", ("", "x" * 65, "line\nbreak"))
def test_device_id_length_and_control_characters(device, write_headers):
    headers = {**write_headers, "X-Device-Id": device}
    with pytest.raises(APIError, match="X-Device-Id ต้องมีความยาว 1-64 ตัวอักษร"):
        validate_write_context(request_with_headers(headers=headers), State.seeded())


def test_unknown_or_inactive_operator_is_rejected(client, write_headers):
    unknown = client.post(
        "/api/v1/sites",
        headers={**write_headers, "X-Operator-Id": "01900000-0000-7000-8000-000000000777"},
        json={"code": "UNKNOWN", "name": "Unknown"},
    )
    assert unknown.status_code == 400
    assert (
        client.patch(
            "/api/v1/operators/00000000-0000-7000-8000-000000000001", headers=write_headers, json={"active": False}
        ).status_code
        == 200
    )
    inactive = client.post("/api/v1/sites", headers=write_headers, json={"code": "INACTIVE", "name": "Inactive"})
    assert inactive.status_code == 400
    assert inactive.json()["error"]["message"] == "operator ไม่ถูกต้องหรือถูกปิดใช้งาน"


def test_operator_creation_is_exempt_from_operator_lookup(client, write_headers):
    response = client.post(
        "/api/v1/operators",
        headers={**write_headers, "X-Operator-Id": "01900000-0000-7000-8000-000000000777"},
        json={"name": "Bootstrap"},
    )
    assert response.status_code == 201


def test_idempotency_key_must_be_uuid(client, write_headers):
    response = client.post(
        "/api/v1/sites", headers={**write_headers, "X-Idempotency-Key": "123"}, json={"code": "A", "name": "A"}
    )
    assert response.status_code == 400
    assert response.json()["error"]["message"] == "ทุกการบันทึกต้องมี X-Idempotency-Key ที่เป็น UUID"


def test_idempotency_scope_includes_method_path_and_query(client, write_headers):
    key = "01900000-0000-7000-8000-000000000998"
    site = client.post(
        "/api/v1/sites?source=test",
        headers={**write_headers, "X-Idempotency-Key": key},
        json={"code": "A", "name": "A"},
    )
    operator = client.post(
        "/api/v1/operators", headers={**write_headers, "X-Idempotency-Key": key}, json={"name": "Other"}
    )
    assert (site.status_code, operator.status_code) == (201, 201)


def test_request_fingerprint_ignores_key_order_and_whitespace():
    request = request_with_headers()
    first = request_fingerprint(request, {"a": " value ", "nested": {"b": " text "}})
    second = request_fingerprint(request, {"nested": {"b": "text"}, "a": "value"})
    assert first == second


def test_audit_entry_captures_operator_device_and_deep_copies(write_headers):
    state = State.seeded()
    old, new = {"value": [1]}, {"value": [2]}
    audit(state, request_with_headers(headers=write_headers), "UPDATE", "site", "site-1", old, new)
    old["value"].append(3)
    new["value"].append(4)

    entry = state.audits[0]
    assert entry["operatorId"] == write_headers["X-Operator-Id"]
    assert entry["deviceId"] == write_headers["X-Device-Id"]
    assert entry["oldValues"] == {"value": [1]}
    assert entry["newValues"] == {"value": [2]}
    assert parse_datetime(entry["occurredAt"])


def test_encode_result_supports_bytes_and_custom_media_type():
    assert encode_result((200, b"a,b", "text/csv")) == (200, "text/csv", b"a,b")

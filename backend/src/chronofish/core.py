from __future__ import annotations

import copy
import hashlib
import json
import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from fastapi import Request
from fastapi.responses import JSONResponse, Response

from .domain.rules import default_expected_hpa, stage_code, stage_label

JSON = dict[str, Any]
DEMO_OPERATOR_ID = "00000000-0000-7000-8000-000000000001"
PROTOCOL_ID = "01900000-0000-7000-8000-000000000001"
TIMING_PROFILE_ID = "01900000-0000-7000-8000-000000000002"
RESOURCES = (
    "sites",
    "operators",
    "donor-cell-lines",
    "recipient-egg-lots",
    "csof-lots",
    "treatment-groups",
    "fish-boxes",
    "protocols",
    "timing-profiles",
    "batches",
    "injection-lots",
    "embryos",
    "fish",
    "specimens",
    "control-arm-counts",
)


class APIError(Exception):
    def __init__(self, status: int, code: str, message: str, details: Any = None):
        super().__init__(message)
        self.status, self.code, self.message, self.details = status, code, message, details


def error_response(error: APIError) -> JSONResponse:
    body: JSON = {"error": {"code": error.code, "message": error.message}}
    if error.details is not None:
        body["error"]["details"] = error.details
    return JSONResponse(body, status_code=error.status)


def utc_now() -> datetime:
    return datetime.now(UTC)


def iso_now() -> str:
    return utc_now().isoformat().replace("+00:00", "Z")


def parse_datetime(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError) as error:
        raise APIError(422, "validation_error", "timestamp ต้องเป็น ISO 8601 พร้อม timezone") from error
    if parsed.tzinfo is None:
        raise APIError(422, "validation_error", "timestamp ต้องระบุ timezone")
    return parsed.astimezone(UTC)


def uuid7() -> str:
    value = bytearray(int(time.time_ns() // 1_000_000).to_bytes(6, "big") + secrets.token_bytes(10))
    value[6] = (value[6] & 0x0F) | 0x70
    value[8] = (value[8] & 0x3F) | 0x80
    return str(UUID(bytes=bytes(value)))


def normalize(value: Any) -> Any:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        return [normalize(item) for item in value]
    if isinstance(value, dict):
        return {key: normalize(item) for key, item in value.items()}
    return value


@dataclass(slots=True)
class StoredResponse:
    request_hash: str
    status: int
    content_type: str
    body: bytes


@dataclass(slots=True)
class State:
    entities: dict[str, dict[str, JSON]] = field(default_factory=lambda: {resource: {} for resource in RESOURCES})
    observations: dict[str, JSON] = field(default_factory=dict)
    fish_observations: dict[str, JSON] = field(default_factory=dict)
    audits: list[JSON] = field(default_factory=list)
    idempotency: dict[str, StoredResponse] = field(default_factory=dict)
    next_fish_no: int = 1

    @classmethod
    def seeded(cls) -> State:
        state = cls()
        now = "2026-01-01T00:00:00Z"
        state.entities["operators"][DEMO_OPERATOR_ID] = {
            "id": DEMO_OPERATOR_ID,
            "name": "Demo operator",
            "active": True,
            "createdAt": now,
            "updatedAt": now,
        }
        state.entities["protocols"][PROTOCOL_ID] = {
            "id": PROTOCOL_ID,
            "name": "SCNT standard",
            "stage1MaxAgeDays": 5,
            "active": True,
            "createdAt": now,
            "updatedAt": now,
        }
        entries = []
        for order in range(1, 37):
            code = stage_code(order)
            label = stage_label(order)
            entries.append(
                {
                    "id": f"01900001-0000-7000-8000-{order:012d}",
                    "protocolId": PROTOCOL_ID,
                    "stageOrder": order,
                    "code": code,
                    "label": label,
                    "stageCode": code,
                    "stageLabel": label,
                    "shortLabel": label,
                    "phase": "LARVAL",
                    "stageScope": "STAGE_1" if order <= 26 else "STAGE_2",
                    "expectedHpa": default_expected_hpa(code),
                }
            )
        state.entities["timing-profiles"][TIMING_PROFILE_ID] = {
            "id": TIMING_PROFILE_ID,
            "protocolId": PROTOCOL_ID,
            "version": 1,
            "name": "ZFIN 28.5C (default)",
            "isCurrent": True,
            "entries": entries,
            "createdAt": now,
            "updatedAt": now,
        }
        return state


class MemoryStore:
    """Development/test store. Production uses SQLStore; the global lock ceiling is intentional."""

    def __init__(self) -> None:
        self.state = State.seeded()
        self.lock = threading.RLock()

    def snapshot(self) -> State:
        with self.lock:
            return copy.deepcopy(self.state)

    def replace(self, state: State) -> None:
        with self.lock:
            self.state = state


def validate_write_context(request: Request, state: State) -> tuple[str, str, str]:
    operator_id = request.headers.get("X-Operator-Id", "").strip()
    device_id = request.headers.get("X-Device-Id", "").strip()
    key = request.headers.get("X-Idempotency-Key", "").strip()
    try:
        UUID(operator_id)
    except ValueError as error:
        raise APIError(400, "invalid_context", "X-Operator-Id ต้องเป็น UUID") from error
    if not device_id or len(device_id) > 64 or "\n" in device_id or "\r" in device_id:
        raise APIError(400, "invalid_context", "X-Device-Id ต้องมีความยาว 1-64 ตัวอักษร")
    operator = state.entities["operators"].get(operator_id)
    if request.url.path != "/api/v1/operators" and (not operator or operator.get("active") is False):
        raise APIError(400, "invalid_context", "operator ไม่ถูกต้องหรือถูกปิดใช้งาน")
    try:
        UUID(key)
    except ValueError as error:
        raise APIError(400, "invalid_context", "ทุกการบันทึกต้องมี X-Idempotency-Key ที่เป็น UUID") from error
    return operator_id, device_id, key


def audit(
    state: State, request: Request, action: str, table: str, record_id: str, old: JSON | None, new: JSON | None
) -> None:
    state.audits.append(
        {
            "id": uuid7(),
            "tableName": table,
            "recordId": record_id,
            "action": action,
            "oldValues": copy.deepcopy(old),
            "newValues": copy.deepcopy(new),
            "operatorId": request.headers.get("X-Operator-Id"),
            "deviceId": request.headers.get("X-Device-Id"),
            "occurredAt": iso_now(),
        }
    )


Mutation = Callable[[State], tuple[int, Any] | tuple[int, Any, str]]


def mutate(store: MemoryStore, request: Request, body: Any, operation: Mutation) -> Response:
    with store.lock:
        state = store.state
        _operator, _device, key = validate_write_context(request, state)
        canonical = json.dumps(normalize(body), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        request_hash = hashlib.sha256(
            f"{request.method}\0{request.url.path}?{request.url.query}\0{canonical}".encode()
        ).hexdigest()
        scope = f"{request.method}:{request.url.path}?{request.url.query}:{key}"
        previous = state.idempotency.get(scope)
        if previous:
            if previous.request_hash != request_hash:
                raise APIError(409, "idempotency_conflict", "X-Idempotency-Key ถูกใช้กับ request อื่นแล้ว")
            return Response(previous.body, previous.status, media_type=previous.content_type)
        working = copy.deepcopy(state)
        result = operation(working)
        status, payload, *content_type = result
        media_type = content_type[0] if content_type else "application/json"
        if isinstance(payload, bytes):
            encoded = payload
        else:
            encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str).encode()
        working.idempotency[scope] = StoredResponse(request_hash, status, media_type, encoded)
        store.state = working
        return Response(encoded, status, media_type=media_type)

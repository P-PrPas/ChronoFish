from __future__ import annotations

import copy
import hashlib
import json
from typing import Any
from uuid import UUID

from fastapi import Request

from ..domain.state import JSON, State
from .errors import APIError
from .values import iso_now, normalize, uuid7


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


def request_fingerprint(request: Request, body: Any) -> tuple[str, str]:
    canonical = json.dumps(normalize(body), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    request_hash = hashlib.sha256(
        f"{request.method}\0{request.url.path}?{request.url.query}\0{canonical}".encode()
    ).hexdigest()
    return f"{request.method}:{request.url.path}?{request.url.query}", request_hash


def encode_result(result: tuple[int, Any] | tuple[int, Any, str]) -> tuple[int, str, bytes]:
    status, payload, *content_type = result
    media_type = content_type[0] if content_type else "application/json"
    encoded = (
        payload
        if isinstance(payload, bytes)
        else json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str).encode()
    )
    return status, media_type, encoded

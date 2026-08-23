from __future__ import annotations

import secrets
import time
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from .errors import APIError


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

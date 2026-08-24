from __future__ import annotations

import base64
import binascii
import json
from datetime import UTC, datetime
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Request

from ...runtime.errors import APIError
from ...store import Store

BANGKOK = ZoneInfo("Asia/Bangkok")
MAX_FILTER_LENGTH = 128


def _filter(value: str | None, name: str) -> str | None:
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    if len(value) > MAX_FILTER_LENGTH or any(ord(character) < 32 for character in value):
        raise APIError(400, "invalid_query", f"{name} is invalid")
    return value


def _uuid_filter(value: str | None, name: str) -> str | None:
    value = _filter(value, name)
    if value is None:
        return None
    try:
        return str(UUID(value))
    except ValueError as error:
        raise APIError(400, "invalid_query", f"{name} must be a UUID") from error


def _time(value: str | None) -> datetime | None:
    if not value:
        return None
    if not isinstance(value, str):
        raise APIError(400, "invalid_query", "timestamp must be an ISO 8601 string")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise APIError(400, "invalid_query", "from/to must be ISO 8601 timestamps") from error
    return (parsed.replace(tzinfo=BANGKOK) if parsed.tzinfo is None else parsed).astimezone(UTC)


def _cursor(value: str | None) -> tuple[datetime, str] | None:
    if not value:
        return None
    if len(value) > 512:
        raise APIError(400, "invalid_query", "cursor is invalid")
    try:
        padding = "=" * (-len(value) % 4)
        decoded = json.loads(base64.urlsafe_b64decode(value + padding))
        if not isinstance(decoded, dict) or not isinstance(decoded.get("id"), str):
            raise ValueError("cursor payload is invalid")
        occurred_at = _time(decoded.get("occurredAt"))
        if occurred_at is None:
            raise ValueError("cursor timestamp is invalid")
        return occurred_at, decoded["id"]
    except (binascii.Error, ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
        raise APIError(400, "invalid_query", "cursor is invalid") from error


def _encode(item: dict[str, Any]) -> str:
    payload = json.dumps({"occurredAt": item["occurredAt"], "id": item["id"]}, separators=(",", ":"))
    return base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")


def build_audit_router(store: Store) -> APIRouter:
    router = APIRouter(prefix="/api/v1")

    @router.get("/audit-log")
    def list_audit_log(request: Request) -> dict[str, Any]:
        query = request.query_params
        try:
            limit = min(max(int(query.get("limit", "100")), 1), 500)
        except ValueError as error:
            raise APIError(400, "invalid_query", "limit must be an integer") from error
        table = _filter(query.get("table"), "table")
        record_id = _uuid_filter(query.get("recordId"), "recordId")
        operator_id = _uuid_filter(query.get("operatorId"), "operatorId")
        from_time, to_time, cursor = _time(query.get("from")), _time(query.get("to")), _cursor(query.get("cursor"))
        if from_time and to_time and from_time > to_time:
            raise APIError(400, "invalid_query", "from must not be after to")
        if query_audits := getattr(store, "query_audits", None):
            page, more = query_audits(
                table=table,
                record_id=record_id,
                operator_id=operator_id,
                from_time=from_time,
                to_time=to_time,
                cursor=cursor,
                limit=limit,
            )
            return {"items": page, "nextCursor": _encode(page[-1]) if more and page else None}
        items = []
        for item in store.snapshot().audits:
            occurred = _time(str(item.get("occurredAt", "")))
            if table and item.get("tableName") != table:
                continue
            if record_id and item.get("recordId") != record_id:
                continue
            if operator_id and item.get("operatorId") != operator_id:
                continue
            if not occurred or from_time and occurred < from_time or to_time and occurred > to_time:
                continue
            if cursor and (occurred, str(item["id"])) >= cursor:
                continue
            items.append(item)
        items.sort(key=lambda item: (_time(str(item["occurredAt"])), str(item["id"])), reverse=True)
        page = items[:limit]
        return {"items": page, "nextCursor": _encode(page[-1]) if len(items) > limit else None}

    return router

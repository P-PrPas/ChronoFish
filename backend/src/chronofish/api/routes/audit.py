from __future__ import annotations

import base64
import json
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Request

from ...runtime.errors import APIError
from ...store import Store

BANGKOK = ZoneInfo("Asia/Bangkok")


def _time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise APIError(400, "invalid_query", "from/to must be ISO 8601 timestamps") from error
    return (parsed.replace(tzinfo=BANGKOK) if parsed.tzinfo is None else parsed).astimezone(UTC)


def _cursor(value: str | None) -> tuple[datetime, str] | None:
    if not value:
        return None
    try:
        padding = "=" * (-len(value) % 4)
        decoded = json.loads(base64.urlsafe_b64decode(value + padding))
        return _time(decoded["occurredAt"]), str(decoded["id"])  # type: ignore[return-value]
    except (ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
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
        from_time, to_time, cursor = _time(query.get("from")), _time(query.get("to")), _cursor(query.get("cursor"))
        if from_time and to_time and from_time > to_time:
            raise APIError(400, "invalid_query", "from must not be after to")
        if query_audits := getattr(store, "query_audits", None):
            page, more = query_audits(
                table=query.get("table"),
                record_id=query.get("recordId"),
                operator_id=query.get("operatorId"),
                from_time=from_time,
                to_time=to_time,
                cursor=cursor,
                limit=limit,
            )
            return {"items": page, "nextCursor": _encode(page[-1]) if more and page else None}
        items = []
        for item in store.snapshot().audits:
            occurred = _time(str(item.get("occurredAt", "")))
            if query.get("table") and item.get("tableName") != query["table"]:
                continue
            if query.get("recordId") and item.get("recordId") != query["recordId"]:
                continue
            if query.get("operatorId") and item.get("operatorId") != query["operatorId"]:
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

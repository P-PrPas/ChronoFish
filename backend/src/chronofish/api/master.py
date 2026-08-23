from __future__ import annotations

import copy
from typing import Any

from fastapi import APIRouter, Query, Request

from ..core import APIError, MemoryStore, State, audit, iso_now, mutate, normalize, uuid7

MASTER = {
    "sites": {"required": ("code", "name"), "unique": ("code",)},
    "operators": {"required": ("name",), "unique": ("name",), "references": {"siteId": "sites"}},
    "donor-cell-lines": {"required": ("strain", "preparation"), "unique": ("strain", "preparation", "batchCode")},
    "recipient-egg-lots": {"required": ("breed", "label"), "unique": ("label",)},
    "csof-lots": {"required": ("lotCode",), "unique": ("lotCode",)},
    "treatment-groups": {"required": ("code", "armType"), "unique": ("code",)},
    "fish-boxes": {"required": ("boxCode",), "unique": ("boxCode",), "references": {"siteId": "sites"}},
}


def _validate(state: State, resource: str, item: dict[str, Any], current_id: str = "") -> None:
    spec = MASTER[resource]
    missing = next((field for field in spec["required"] if not str(item.get(field, "")).strip()), None)
    if missing:
        raise APIError(422, "validation_error", f"ต้องระบุ {missing}")
    if resource == "donor-cell-lines" and item.get("preparation") not in {"DISSOCIATED", "CHUNKS"}:
        raise APIError(422, "validation_error", "preparation ต้องเป็น DISSOCIATED หรือ CHUNKS")
    if resource == "treatment-groups" and item.get("armType") not in {"SCNT", "NATURAL_BREEDING", "IVF"}:
        raise APIError(422, "validation_error", "armType ไม่ถูกต้อง")
    for field, referenced in spec.get("references", {}).items():
        if value := item.get(field):
            target = state.entities[referenced].get(str(value))
            if not target or target.get("active") is False:
                raise APIError(422, "validation_error", f"{field} references an inactive or missing {referenced}")
    unique = spec["unique"]
    for item_id, existing in state.entities[resource].items():
        if item_id == current_id or existing.get("active") is False:
            continue
        if all(
            str(existing.get(field, "")).strip().casefold() == str(item.get(field, "")).strip().casefold()
            for field in unique
        ):
            raise APIError(409, "conflict", "ข้อมูลซ้ำกับรายการที่มีอยู่แล้ว")


def build_master_router(store: MemoryStore) -> APIRouter:
    router = APIRouter(prefix="/api/v1")
    for resource in MASTER:

        def handlers(current_resource: str):
            async def list_endpoint(
                includeInactive: bool = Query(False),
                cursor: str | None = None,
                limit: int = Query(100, ge=1, le=500),
            ) -> dict[str, Any]:
                state = store.snapshot()
                items = [
                    copy.deepcopy(item)
                    for item in state.entities[current_resource].values()
                    if includeInactive or item.get("active") is not False
                ]
                items.sort(
                    key=lambda item: (
                        str(item.get("code", item.get("name", item.get("id", "")))).casefold(),
                        item["id"],
                    )
                )
                try:
                    offset = max(int(cursor or 0), 0)
                except ValueError as error:
                    raise APIError(400, "invalid_query", "cursor is invalid") from error
                end = min(offset + limit, len(items))
                return {"items": items[offset:end], "nextCursor": str(end) if end < len(items) else None}

            async def create_endpoint(request: Request, body: dict[str, Any]):
                body = normalize(body)

                def operation(state: State):
                    _validate(state, current_resource, body)
                    now, item_id = iso_now(), str(body.get("id") or uuid7())
                    item = {**body, "id": item_id, "active": True, "createdAt": now, "updatedAt": now}
                    state.entities[current_resource][item_id] = item
                    audit(state, request, "INSERT", current_resource, item_id, None, item)
                    return 201, item

                return mutate(store, request, body, operation)

            async def update_endpoint(id: str, request: Request, body: dict[str, Any]):
                item_id = id
                body = normalize(body)

                def operation(state: State):
                    current = state.entities[current_resource].get(item_id)
                    if not current:
                        raise APIError(404, "not_found", "ไม่พบรายการที่ร้องขอ")
                    old = copy.deepcopy(current)
                    updated = {
                        **current,
                        **{key: value for key, value in body.items() if key != "id"},
                        "updatedAt": iso_now(),
                    }
                    if body.get("active") is False:
                        updated["deletedAt"] = iso_now()
                    _validate(state, current_resource, updated, item_id)
                    state.entities[current_resource][item_id] = updated
                    audit(state, request, "UPDATE", current_resource, item_id, old, updated)
                    return 200, updated

                return mutate(store, request, body, operation)

            return list_endpoint, create_endpoint, update_endpoint

        list_items, create_item, update_item = handlers(resource)

        router.add_api_route(f"/{resource}", list_items, methods=["GET"], name=f"list-{resource}")
        router.add_api_route(f"/{resource}", create_item, methods=["POST"], name=f"create-{resource}")
        router.add_api_route(f"/{resource}/{{id}}", update_item, methods=["PATCH"], name=f"update-{resource}")
    return router

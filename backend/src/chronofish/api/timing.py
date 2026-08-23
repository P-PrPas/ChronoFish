from __future__ import annotations

import copy
import csv
import io
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Query, Request
from fastapi.responses import Response

from ..core import APIError, MemoryStore, State, audit, iso_now, mutate, normalize, uuid7
from ..domain.rules import stage_label, stage_number


def build_timing_router(store: MemoryStore) -> APIRouter:
    router = APIRouter(prefix="/api/v1")

    @router.get("/protocols")
    def protocols() -> dict[str, Any]:
        return {"items": list(store.snapshot().entities["protocols"].values()), "nextCursor": None}

    @router.get("/protocols/{id}/stages")
    def stages(id: str) -> dict[str, Any]:
        protocol_id = id
        state = store.snapshot()
        if protocol_id not in state.entities["protocols"]:
            raise APIError(404, "not_found", "ไม่พบ protocol")
        profile = next(
            (
                item
                for item in state.entities["timing-profiles"].values()
                if item.get("protocolId") == protocol_id and item.get("isCurrent")
            ),
            None,
        )
        if not profile:
            raise APIError(404, "not_found", "no current timing profile")
        return {"items": profile["entries"]}

    @router.get("/timing-profiles/current")
    def current(protocolId: str = Query(...)) -> dict[str, Any]:
        try:
            UUID(protocolId)
        except ValueError as error:
            raise APIError(400, "invalid_query", "protocolId must be UUID") from error
        state = store.snapshot()
        profile = next(
            (
                copy.deepcopy(item)
                for item in state.entities["timing-profiles"].values()
                if item.get("protocolId") == protocolId and item.get("isCurrent")
            ),
            None,
        )
        if not profile:
            raise APIError(404, "not_found", "ยังไม่มี timing profile")
        return profile

    @router.get("/timing-profiles")
    def profiles(protocolId: str = Query(...)) -> dict[str, Any]:
        items = [
            copy.deepcopy(item)
            for item in store.snapshot().entities["timing-profiles"].values()
            if item.get("protocolId") == protocolId
        ]
        items.sort(key=lambda item: item.get("version", 0), reverse=True)
        return {"items": items, "nextCursor": None}

    def create_profile(request: Request, body: dict[str, Any]):
        body = normalize(body)

        def operation(state: State):
            protocol_id = str(body.get("protocolId", ""))
            incoming = body.get("entries")
            if (
                protocol_id not in state.entities["protocols"]
                or not body.get("name")
                or not isinstance(incoming, list)
                or not incoming
            ):
                raise APIError(422, "validation_error", "protocolId, name และ entries ไม่ถูกต้อง")
            previous = next(
                (
                    item
                    for item in state.entities["timing-profiles"].values()
                    if item.get("protocolId") == protocol_id and item.get("isCurrent")
                ),
                None,
            )
            if not previous:
                raise APIError(422, "validation_error", "protocol has no current timing profile")
            merged = {int(item["stageOrder"]): copy.deepcopy(item) for item in previous["entries"]}
            for entry in incoming:
                code = str(entry.get("stageCode") or entry.get("code") or "")
                order = stage_number(code)
                if order not in range(1, 37) or (entry.get("stageOrder") and int(entry["stageOrder"]) != order):
                    raise APIError(422, "validation_error", "stageOrder and stageCode must match")
                try:
                    expected = float(entry["expectedHpa"])
                except (KeyError, TypeError, ValueError) as error:
                    raise APIError(422, "validation_error", "expectedHpa ต้องเป็นตัวเลข") from error
                if expected < 0:
                    raise APIError(422, "validation_error", "expectedHpa ต้องไม่น้อยกว่า 0")
                label = str(entry.get("stageLabel") or entry.get("label") or stage_label(order))
                merged[order] = {
                    **merged.get(order, {}),
                    **entry,
                    "id": entry.get("id") or uuid7(),
                    "stageOrder": order,
                    "stageCode": code,
                    "code": code,
                    "stageLabel": label,
                    "label": label,
                    "expectedHpa": expected,
                }
            if set(merged) != set(range(1, 37)):
                raise APIError(422, "validation_error", "timing profile must contain all 36 stages")
            versions = [
                int(item.get("version", 0))
                for item in state.entities["timing-profiles"].values()
                if item.get("protocolId") == protocol_id
            ]
            for old in state.entities["timing-profiles"].values():
                if old.get("protocolId") == protocol_id and old.get("isCurrent"):
                    before = copy.deepcopy(old)
                    old["isCurrent"] = False
                    audit(state, request, "UPDATE", "stage_timing_profile", old["id"], before, old)
            now, profile_id = iso_now(), uuid7()
            profile = {
                **body,
                "id": profile_id,
                "version": max(versions, default=0) + 1,
                "isCurrent": True,
                "entries": [merged[index] for index in range(1, 37)],
                "createdAt": now,
                "updatedAt": now,
                "createdByOperatorId": request.headers.get("X-Operator-Id"),
            }
            state.entities["timing-profiles"][profile_id] = profile
            audit(state, request, "INSERT", "stage_timing_profile", profile_id, None, profile)
            return 201, profile

        return mutate(store, request, body, operation)

    router.add_api_route("/timing-profiles", create_profile, methods=["POST"])

    @router.get("/timing-profiles/csv")
    def export_csv(protocolId: str = Query(...)) -> Response:
        state = store.snapshot()
        profile = next(
            (
                item
                for item in state.entities["timing-profiles"].values()
                if item.get("protocolId") == protocolId and item.get("isCurrent")
            ),
            None,
        )
        if not profile:
            raise APIError(404, "not_found", "ไม่พบ timing profile ของ protocol")
        output = io.StringIO(newline="")
        writer = csv.writer(output)
        writer.writerow(("stage_order", "stage_code", "label", "expected_hpa"))
        writer.writerows(
            (item["stageOrder"], item["stageCode"], item["stageLabel"], item["expectedHpa"])
            for item in profile["entries"]
        )
        return Response(
            output.getvalue(),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": "attachment; filename=timing-profile.csv"},
        )

    @router.post("/timing-profiles/csv")
    async def import_csv(request: Request, protocolId: str = Query(...)):
        text = (await request.body()).decode("utf-8-sig")
        try:
            rows = list(csv.DictReader(io.StringIO(text)))
            entries = [
                {
                    "stageOrder": int(row["stage_order"]),
                    "stageCode": row["stage_code"].strip(),
                    "stageLabel": row["label"].strip(),
                    "expectedHpa": float(row["expected_hpa"]),
                }
                for row in rows
            ]
        except (KeyError, TypeError, ValueError, csv.Error) as error:
            raise APIError(422, "validation_error", "CSV header หรือข้อมูลไม่ถูกต้อง") from error
        return create_profile(
            request, {"protocolId": protocolId, "name": "Imported timing profile", "entries": entries}
        )

    return router

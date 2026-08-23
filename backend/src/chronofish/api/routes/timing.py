from __future__ import annotations

import copy
import csv
import io
import math
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Query, Request
from fastapi.responses import Response

from ...domain.rules import stage_code, stage_label, stage_number
from ...domain.state import State
from ...runtime.errors import APIError
from ...runtime.mutations import audit
from ...runtime.values import iso_now, normalize, uuid7
from ...store import Store

CSV_COLUMNS = ("stage_order", "stage_code", "label", "expected_hpa")


def _parse_timing_csv(text: str) -> list[dict[str, Any]]:
    reader = csv.DictReader(io.StringIO(text), strict=True)
    try:
        fieldnames = tuple(reader.fieldnames or ())
    except csv.Error as error:
        raise APIError(
            422,
            "validation_error",
            "CSV header ไม่ถูกต้อง",
            {"rows": [{"row": 1, "field": "header", "message": str(error)}]},
        ) from error
    if fieldnames != CSV_COLUMNS:
        raise APIError(
            422,
            "validation_error",
            "CSV header ไม่ถูกต้อง",
            {"rows": [{"row": 1, "field": "header", "message": f"expected {','.join(CSV_COLUMNS)}"}]},
        )
    entries: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    seen: set[str] = set()
    try:
        for row_number, row in enumerate(reader, start=2):
            row_errors: list[dict[str, Any]] = []
            try:
                order = int(row.get("stage_order", ""))
            except (TypeError, ValueError):
                order = 0
                row_errors.append({"row": row_number, "field": "stage_order", "message": "must be an integer"})
            code = str(row.get("stage_code") or "").strip()
            if order not in range(1, 37) or code != stage_code(order):
                row_errors.append({"row": row_number, "field": "stage_code", "message": "does not match stage_order"})
            elif code in seen:
                row_errors.append({"row": row_number, "field": "stage_code", "message": "duplicate stage"})
            else:
                seen.add(code)
            try:
                expected = float(row.get("expected_hpa", ""))
                if not math.isfinite(expected) or expected < 0:
                    raise ValueError
            except (TypeError, ValueError):
                expected = 0
                row_errors.append(
                    {
                        "row": row_number,
                        "field": "expected_hpa",
                        "message": "must be a number greater than or equal to 0",
                    }
                )
            if None in row:
                row_errors.append({"row": row_number, "field": "row", "message": "has too many columns"})
            if row_errors:
                errors.extend(row_errors)
            else:
                entries.append(
                    {
                        "stageOrder": order,
                        "stageCode": code,
                        "stageLabel": stage_label(order),
                        "expectedHpa": expected,
                    }
                )
    except csv.Error as error:
        errors.append({"row": reader.line_num, "field": "row", "message": str(error)})
    if not entries and not errors:
        errors.append({"row": 2, "field": "row", "message": "CSV must contain at least one data row"})
    if errors:
        raise APIError(422, "validation_error", "CSV มีข้อมูลที่ต้องแก้ไข", {"rows": errors})
    return entries


def build_timing_router(store: Store) -> APIRouter:
    router = APIRouter(prefix="/api/v1")

    @router.get("/protocols")
    def protocols() -> dict[str, Any]:
        items = list(store.snapshot().entities["protocols"].values())
        items.sort(key=lambda item: (str(item.get("name", "")).casefold(), str(item.get("id", ""))))
        return {"items": items, "nextCursor": None}

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
        items = [
            {key: entry[key] for key in ("id", "stageOrder", "code", "label", "shortLabel", "phase", "stageScope")}
            for entry in profile["entries"]
        ]
        items.sort(key=lambda item: int(item["stageOrder"]))
        return {"items": items}

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
            name = body.get("name")
            if (
                protocol_id not in state.entities["protocols"]
                or not isinstance(name, str)
                or not name
                or len(name) > 200
                or not isinstance(incoming, list)
                or not incoming
            ):
                raise APIError(422, "validation_error", "protocolId, name และ entries ไม่ถูกต้อง")
            source_note = body.get("sourceNote")
            if source_note is not None and (not isinstance(source_note, str) or len(source_note) > 500):
                raise APIError(422, "validation_error", "sourceNote ต้องยาวไม่เกิน 500 ตัวอักษร")
            reference_temp = body.get("referenceTempC")
            if reference_temp is not None and (
                isinstance(reference_temp, bool)
                or not isinstance(reference_temp, (int, float))
                or not math.isfinite(reference_temp)
            ):
                raise APIError(422, "validation_error", "referenceTempC ต้องเป็นตัวเลข")
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
            seen: set[str] = set()
            for index, entry in enumerate(incoming):
                if not isinstance(entry, dict):
                    raise APIError(422, "validation_error", f"entries[{index}] ต้องเป็น object")
                code = str(entry.get("stageCode") or entry.get("code") or "")
                order = stage_number(code)
                try:
                    supplied_order = int(entry["stageOrder"]) if entry.get("stageOrder") is not None else order
                except (TypeError, ValueError) as error:
                    raise APIError(422, "validation_error", "stageOrder ต้องเป็นจำนวนเต็ม") from error
                if order not in range(1, 37) or code != stage_code(order) or supplied_order != order:
                    raise APIError(422, "validation_error", "stageOrder and stageCode must match")
                if code in seen:
                    raise APIError(422, "validation_error", f"stageCode ซ้ำที่ entries[{index}]")
                seen.add(code)
                try:
                    raw_expected = entry["expectedHpa"]
                    if isinstance(raw_expected, bool):
                        raise TypeError
                    expected = float(raw_expected)
                except (KeyError, TypeError, ValueError) as error:
                    raise APIError(422, "validation_error", "expectedHpa ต้องเป็นตัวเลข") from error
                if not math.isfinite(expected) or expected < 0:
                    raise APIError(422, "validation_error", "expectedHpa ต้องไม่น้อยกว่า 0")
                label = stage_label(order)
                merged[order] = {
                    **merged.get(order, {}),
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

        return store.execute_mutation(request, body, operation)

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
        try:
            text = (await request.body()).decode("utf-8-sig")
        except UnicodeDecodeError as error:
            raise APIError(422, "validation_error", "CSV ต้องเข้ารหัสเป็น UTF-8") from error
        entries = _parse_timing_csv(text)
        return create_profile(
            request, {"protocolId": protocolId, "name": "Imported timing profile", "entries": entries}
        )

    return router

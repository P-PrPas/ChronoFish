from __future__ import annotations

import copy
import math
import re
from datetime import date
from typing import Any

from fastapi import APIRouter, Query, Request

from ...domain.rules import enu_window, stage_label, stage_number
from ...domain.state import State
from ...runtime.errors import APIError
from ...runtime.mutations import audit
from ...runtime.values import iso_now, normalize, parse_datetime, uuid7
from ...store import Store

BATCH_INPUT_FIELDS = {
    "batchCode",
    "experimentDate",
    "dayNo",
    "siteId",
    "operatorId",
    "protocolId",
    "treatmentGroupId",
    "recipientEggLotId",
    "csofLotId",
    "clutchCode",
    "replicateNo",
    "incubationTempC",
    "notes",
}


def _active(state: State, resource: str, item_id: str, label: str | None = None) -> dict[str, Any]:
    item = state.entities[resource].get(item_id)
    if not item or item.get("active") is False or item.get("deletedAt") is not None:
        raise APIError(422, "validation_error", f"ไม่พบ {label or resource} ที่ active")
    return item


def _batch_code_part(value: Any) -> str:
    return re.sub(r"\s+", "-", str(value or "").strip())


def _next_day_no(state: State, body: dict[str, Any]) -> int:
    values = [
        int(item.get("dayNo", 0))
        for item in state.entities["batches"].values()
        if item.get("active") is not False
        and item.get("deletedAt") is None
        and all(item.get(field) == body.get(field) for field in ("operatorId", "protocolId", "treatmentGroupId"))
    ]
    return max(values, default=0) + 1


def _validate_batch(state: State, body: dict[str, Any], current_id: str = "") -> None:
    for field in ("experimentDate", "siteId", "operatorId", "protocolId", "treatmentGroupId"):
        if not body.get(field):
            raise APIError(422, "validation_error", f"ต้องระบุ {field}")
    try:
        date.fromisoformat(str(body["experimentDate"]))
    except ValueError as error:
        raise APIError(422, "validation_error", "experimentDate ต้องเป็น YYYY-MM-DD") from error
    current = state.entities["batches"].get(current_id, {})
    for resource, field in {
        "sites": "siteId",
        "operators": "operatorId",
        "protocols": "protocolId",
        "treatment-groups": "treatmentGroupId",
        "recipient-egg-lots": "recipientEggLotId",
        "csof-lots": "csofLotId",
    }.items():
        if body.get(field) and body.get(field) != current.get(field):
            _active(state, resource, str(body[field]), field)
    for field in ("dayNo", "replicateNo"):
        value = body.get(field)
        if value is not None and (isinstance(value, bool) or not isinstance(value, int) or value < 1):
            raise APIError(422, "validation_error", f"{field} ต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป")
    temperature = body.get("incubationTempC")
    if temperature is not None and (
        isinstance(temperature, bool)
        or not isinstance(temperature, (int, float))
        or not math.isfinite(temperature)
        or not 0 <= temperature <= 50
    ):
        raise APIError(422, "validation_error", "incubationTempC ต้องอยู่ระหว่าง 0 ถึง 50")
    for field, limit in (("batchCode", 100), ("clutchCode", 50)):
        value = body.get(field)
        if value is not None and (not isinstance(value, str) or not value or len(value) > limit):
            raise APIError(422, "validation_error", f"{field} ไม่ถูกต้อง")
    batch_code = str(body.get("batchCode") or "")
    if batch_code and any(
        item.get("id") != current_id
        and item.get("active") is not False
        and item.get("deletedAt") is None
        and str(item.get("batchCode", "")).casefold() == batch_code.casefold()
        for item in state.entities["batches"].values()
    ):
        raise APIError(409, "conflict", "batchCode ซ้ำกับรายการที่มีอยู่แล้ว")


def _create_batch(state: State, request: Request, body: dict[str, Any], source_id: str = "") -> dict[str, Any]:
    body = {key: value for key, value in body.items() if key in BATCH_INPUT_FIELDS}
    _validate_batch(state, body)
    profile_id = next(
        (
            str(item["id"])
            for item in state.entities["timing-profiles"].values()
            if item.get("protocolId") == body["protocolId"] and item.get("isCurrent")
        ),
        "",
    )
    profile = state.entities["timing-profiles"].get(profile_id)
    if not profile or profile.get("protocolId") != body["protocolId"] or profile.get("deletedAt") is not None:
        raise APIError(422, "validation_error", "ไม่พบ timing profile")
    day_no = int(body.get("dayNo") or 0) or _next_day_no(state, body)
    operator = state.entities["operators"][str(body["operatorId"])]
    treatment = state.entities["treatment-groups"][str(body["treatmentGroupId"])]
    batch_id = uuid7()
    batch_code = str(body.get("batchCode") or "").strip()
    if not batch_code:
        batch_code = f"{day_no}_{_batch_code_part(operator.get('name'))}_{_batch_code_part(treatment.get('code'))}"
    if any(
        item.get("active") is not False
        and item.get("deletedAt") is None
        and str(item.get("batchCode", "")).casefold() == batch_code.casefold()
        for item in state.entities["batches"].values()
    ):
        if source_id:
            batch_code = f"{batch_code}_{batch_id[:8]}"
        else:
            raise APIError(409, "conflict", "batchCode ซ้ำกับรายการที่มีอยู่แล้ว")
    now = iso_now()
    batch = {
        **body,
        "id": batch_id,
        "batchCode": batch_code,
        "dayNo": day_no,
        "timingProfileId": profile_id,
        "active": True,
        "createdAt": now,
        "updatedAt": now,
    }
    state.entities["batches"][batch_id] = batch
    audit(state, request, "INSERT", "experiment_batch", batch_id, None, batch)
    return batch


def _lot_inputs(state: State, body: dict[str, Any]) -> tuple[int, list[str], str | None]:
    for field in ("lotNo", "donorCellLineId", "activatedAt"):
        if not body.get(field):
            raise APIError(422, "validation_error", "ต้องระบุ lotNo, donorCellLineId และ activatedAt")
    if "nActivated" not in body:
        raise APIError(422, "validation_error", "ต้องระบุ nActivated")
    if not isinstance(body["lotNo"], str) or len(body["lotNo"]) > 20:
        raise APIError(422, "validation_error", "lotNo ต้องเป็นข้อความยาวไม่เกิน 20 ตัวอักษร")
    activated = parse_datetime(str(body["activatedAt"]))
    start = parse_datetime(str(body["enuStartAt"])) if body.get("enuStartAt") else None
    finish = parse_datetime(str(body["enuFinishAt"])) if body.get("enuFinishAt") else None
    try:
        warning = enu_window(activated, start, finish)
    except ValueError as error:
        raise APIError(422, "validation_error", str(error)) from error
    _active(state, "donor-cell-lines", str(body["donorCellLineId"]), "donorCellLineId")
    for field in ("enuPowerPct", "enuPulseUs", "enuLed", "nEggs", "nActivated"):
        if body.get(field) is not None and (isinstance(body[field], bool) or not isinstance(body[field], int)):
            raise APIError(422, "validation_error", "ค่าจำนวนต้องเป็นจำนวนเต็ม")
    count = body["nActivated"]
    if count not in range(0, 97):
        raise APIError(422, "validation_error", "nActivated ต้องอยู่ระหว่าง 0 ถึง 96")
    if (
        any(int(body.get(field) or 0) < 0 for field in ("enuPulseUs", "enuLed", "nEggs"))
        or not 0 <= int(body.get("enuPowerPct") or 0) <= 100
    ):
        raise APIError(422, "validation_error", "ค่าจำนวนอยู่นอกช่วงที่กำหนด")
    raw_positions = body.get("wellPositions")
    if raw_positions is not None and not isinstance(raw_positions, list):
        raise APIError(422, "validation_error", "wellPositions ต้องเป็นรายการ")
    positions = raw_positions if isinstance(raw_positions, list) else []
    if (
        len(positions) > count
        or any(not isinstance(value, str) for value in positions)
        or len(set(positions)) != len(positions)
        or any(re.fullmatch(r"[A-H](?:1[0-2]|[1-9])", value) is None for value in positions)
    ):
        raise APIError(422, "validation_error", "wellPositions ต้องไม่ซ้ำและอยู่ในช่วง A1 ถึง H12")
    body.pop("wellPositions", None)
    return count, positions, warning


def _create_embryos(
    state: State,
    request: Request,
    batch: dict[str, Any],
    lot: dict[str, Any],
    count: int,
    positions: list[str],
) -> list[dict[str, Any]]:
    embryos = []
    now = iso_now()
    for sequence in range(1, count + 1):
        embryo_id = uuid7()
        embryo = {
            "id": embryo_id,
            "injectionLotId": lot["id"],
            "seqInLot": sequence,
            "embryoCode": f"{batch['batchCode']}_{lot['lotNo']}_{sequence}",
            "wellPosition": positions[sequence - 1] if sequence <= len(positions) else None,
            "active": True,
            "createdAt": now,
            "updatedAt": now,
        }
        state.entities["embryos"][embryo_id] = embryo
        embryos.append(embryo)
        audit(state, request, "INSERT", "embryo", embryo_id, None, embryo)
    return embryos


def _control_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result = [
        {**copy.deepcopy(item), "stageLabel": stage_label(stage_number(str(item.get("stageCode") or "")))}
        for item in items
    ]
    result.sort(key=lambda item: (stage_number(str(item["stageCode"])), str(item["armType"])))
    return result


def build_experiments_router(store: Store) -> APIRouter:
    router = APIRouter(prefix="/api/v1")

    @router.get("/batches")
    def list_batches(
        dateFrom: str | None = None,
        dateTo: str | None = None,
        siteId: str | None = None,
        operatorId: str | None = None,
        treatmentGroupId: str | None = None,
        cursor: str | None = None,
        limit: int = Query(100, ge=1, le=500),
    ) -> dict[str, Any]:
        items = []
        for item in store.snapshot().entities["batches"].values():
            if item.get("active") is False or item.get("deletedAt") is not None:
                continue
            if dateFrom and str(item.get("experimentDate", "")) < dateFrom:
                continue
            if dateTo and str(item.get("experimentDate", "")) > dateTo:
                continue
            if siteId and item.get("siteId") != siteId:
                continue
            if operatorId and item.get("operatorId") != operatorId:
                continue
            if treatmentGroupId and item.get("treatmentGroupId") != treatmentGroupId:
                continue
            items.append(copy.deepcopy(item))
        items.sort(key=lambda item: (str(item.get("experimentDate", "")), str(item.get("batchCode", ""))), reverse=True)
        try:
            offset = max(int(cursor or 0), 0)
        except ValueError as error:
            raise APIError(400, "invalid_query", "cursor is invalid") from error
        end = min(offset + limit, len(items))
        return {"items": items[offset:end], "nextCursor": str(end) if end < len(items) else None}

    @router.post("/batches")
    async def create_batch(request: Request, body: dict[str, Any]):
        body = normalize(body)

        def operation(state: State):
            return 201, _create_batch(state, request, body)

        return store.execute_mutation(request, body, operation)

    @router.get("/batches/{id}")
    def get_batch(id: str) -> dict[str, Any]:
        batch_id = id
        state = store.snapshot()
        batch = state.entities["batches"].get(batch_id)
        if not batch or batch.get("active") is False or batch.get("deletedAt") is not None:
            raise APIError(404, "not_found", "ไม่พบ batch")
        result = copy.deepcopy(batch)
        lots = []
        for lot in state.entities["injection-lots"].values():
            if lot.get("batchId") != batch_id or lot.get("active") is False or lot.get("deletedAt") is not None:
                continue
            detail = copy.deepcopy(lot)
            detail["embryos"] = sorted(
                (
                    copy.deepcopy(item)
                    for item in state.entities["embryos"].values()
                    if item.get("injectionLotId") == lot["id"]
                    and item.get("active") is not False
                    and item.get("deletedAt") is None
                ),
                key=lambda item: int(item.get("seqInLot", 0)),
            )
            lots.append(detail)
        result["injectionLots"] = sorted(lots, key=lambda item: str(item.get("lotNo", "")))
        return result

    @router.patch("/batches/{id}")
    async def update_batch(id: str, request: Request, body: dict[str, Any]):
        batch_id = id
        body = normalize(body)

        def operation(state: State):
            current = state.entities["batches"].get(batch_id)
            if not current:
                raise APIError(404, "not_found", "ไม่พบ batch")
            old = copy.deepcopy(current)
            if body.get("protocolId") not in (None, current.get("protocolId")):
                raise APIError(409, "invalid_state", "protocolId ของ batch ที่สร้างแล้วเปลี่ยนไม่ได้")
            mutable = BATCH_INPUT_FIELDS - {"protocolId"}
            updated = {
                **current,
                **{key: value for key, value in body.items() if key in mutable},
                "updatedAt": iso_now(),
            }
            _validate_batch(state, updated, batch_id)
            state.entities["batches"][batch_id] = updated
            audit(state, request, "UPDATE", "experiment_batch", batch_id, old, updated)
            return 200, updated

        return store.execute_mutation(request, body, operation)

    @router.post("/batches/{id}/duplicate")
    async def duplicate_batch(id: str, request: Request, body: dict[str, Any]):
        batch_id = id
        body = normalize(body)

        def operation(state: State):
            source = state.entities["batches"].get(batch_id)
            if not source or source.get("active") is False or source.get("deletedAt") is not None:
                raise APIError(404, "not_found", "ไม่พบ batch")
            duplicate = copy.deepcopy(source)
            for field in ("id", "batchCode", "createdAt", "updatedAt", "rowVersion"):
                duplicate.pop(field, None)
            duplicate.update({"experimentDate": body.get("experimentDate"), "dayNo": body.get("dayNo")})
            created = _create_batch(state, request, duplicate, batch_id)
            if body.get("copyInjectionLots"):
                for old_lot in list(state.entities["injection-lots"].values()):
                    if old_lot.get("batchId") != batch_id or old_lot.get("deletedAt") is not None:
                        continue
                    lot = copy.deepcopy(old_lot)
                    lot.update(
                        {
                            "id": uuid7(),
                            "batchId": created["id"],
                            "enuStartAt": None,
                            "enuFinishAt": None,
                            "activatedAt": None,
                            "nActivated": 0,
                            "createdAt": iso_now(),
                            "updatedAt": iso_now(),
                        }
                    )
                    state.entities["injection-lots"][lot["id"]] = lot
                    audit(state, request, "INSERT", "injection_lot", lot["id"], None, lot)
            return 201, created

        return store.execute_mutation(request, body, operation)

    @router.post("/batches/{id}/injection-lots")
    async def create_lot(id: str, request: Request, body: dict[str, Any]):
        batch_id = id
        body = normalize(body)

        def operation(state: State):
            batch = state.entities["batches"].get(batch_id)
            if not batch or batch.get("active") is False or batch.get("deletedAt") is not None:
                raise APIError(404, "not_found", "ไม่พบ batch")
            count, positions, warning = _lot_inputs(state, body)
            if any(
                item.get("batchId") == batch_id
                and str(item.get("lotNo", "")).strip().casefold() == str(body["lotNo"]).casefold()
                and item.get("deletedAt") is None
                for item in state.entities["injection-lots"].values()
            ):
                raise APIError(409, "conflict", "lotNo ซ้ำใน batch")
            lot_id, now = uuid7(), iso_now()
            lot = {**body, "id": lot_id, "batchId": batch_id, "active": True, "createdAt": now, "updatedAt": now}
            state.entities["injection-lots"][lot_id] = lot
            embryos = _create_embryos(state, request, batch, lot, count, positions)
            audit(state, request, "INSERT", "injection_lot", lot_id, None, lot)
            result = {**lot, "embryos": embryos}
            if warning:
                result["warnings"] = [warning]
            return 201, result

        return store.execute_mutation(request, body, operation)

    @router.patch("/injection-lots/{id}")
    async def activate_lot_template(id: str, request: Request, body: dict[str, Any]):
        lot_id = id
        body = normalize(body)

        def operation(state: State):
            current = state.entities["injection-lots"].get(lot_id)
            if not current or current.get("active") is False or current.get("deletedAt") is not None:
                raise APIError(404, "not_found", "ไม่พบ injection lot")
            if current.get("activatedAt"):
                raise APIError(409, "invalid_state", "activatedAt ของ injection lot ที่เริ่มติดตามแล้วแก้ไขไม่ได้")
            if not body.get("activatedAt") or "nActivated" not in body:
                raise APIError(422, "validation_error", "ต้องระบุ activatedAt และ nActivated")
            allowed = {
                "donorCellLineId",
                "enuPowerPct",
                "enuPulseUs",
                "enuLed",
                "enuStartAt",
                "enuFinishAt",
                "activatedAt",
                "nEggs",
                "nActivated",
                "wellPositions",
                "notes",
            }
            updated = {**current, **{key: value for key, value in body.items() if key in allowed}}
            count, positions, warning = _lot_inputs(state, updated)
            batch = state.entities["batches"].get(str(updated.get("batchId")))
            if not batch or batch.get("deletedAt") is not None:
                raise APIError(409, "invalid_state", "injection lot ไม่มี batch ที่ถูกต้อง")
            old, now = copy.deepcopy(current), iso_now()
            updated.update({"nActivated": count, "updatedAt": now})
            state.entities["injection-lots"][lot_id] = updated
            embryos = _create_embryos(state, request, batch, updated, count, positions)
            audit(state, request, "UPDATE", "injection_lot", lot_id, old, updated)
            result = {**updated, "embryos": embryos}
            if warning:
                result["warnings"] = [warning]
            return 200, result

        return store.execute_mutation(request, body, operation)

    @router.get("/injection-lots/{id}/embryos")
    def list_embryos(id: str, aliveOnly: bool = False) -> dict[str, Any]:
        lot_id = id
        state = store.snapshot()
        lot = state.entities["injection-lots"].get(lot_id)
        if not lot or lot.get("active") is False or lot.get("deletedAt") is not None:
            raise APIError(404, "not_found", "ไม่พบ injection lot")
        items = [
            copy.deepcopy(item)
            for item in state.entities["embryos"].values()
            if item.get("injectionLotId") == lot_id
            and item.get("active") is not False
            and item.get("deletedAt") is None
            and (not aliveOnly or not item.get("exitReason"))
        ]
        return {"items": sorted(items, key=lambda item: int(item.get("seqInLot", 0)))}

    @router.post("/injection-lots/{id}/embryos")
    async def add_embryos(id: str, request: Request, body: dict[str, Any]):
        lot_id = id
        body = normalize(body)

        def operation(state: State):
            lot = state.entities["injection-lots"].get(lot_id)
            if not lot or lot.get("active") is False or lot.get("deletedAt") is not None:
                raise APIError(404, "not_found", "ไม่พบ injection lot")
            if not lot.get("activatedAt"):
                raise APIError(409, "invalid_state", "ต้อง activate injection lot template ก่อนเพิ่ม embryo")
            count = body.get("count")
            if isinstance(count, bool) or not isinstance(count, int):
                raise APIError(422, "validation_error", "count ต้องเป็นจำนวนเต็ม")
            existing = [item for item in state.entities["embryos"].values() if item.get("injectionLotId") == lot_id]
            max_sequence = max((int(item.get("seqInLot", 0)) for item in existing), default=0)
            if count < 1 or max_sequence + count > 96:
                raise APIError(422, "validation_error", "จำนวน embryo รวมต้องอยู่ระหว่าง 1 ถึง 96")
            batch = state.entities["batches"].get(str(lot.get("batchId")))
            if not batch:
                raise APIError(409, "invalid_state", "injection lot ไม่มี batch ที่ถูกต้อง")
            created = []
            for sequence in range(max_sequence + 1, max_sequence + count + 1):
                item_id, now = uuid7(), iso_now()
                embryo = {
                    "id": item_id,
                    "injectionLotId": lot_id,
                    "seqInLot": sequence,
                    "embryoCode": f"{batch['batchCode']}_{lot['lotNo']}_{sequence}",
                    "active": True,
                    "createdAt": now,
                    "updatedAt": now,
                }
                state.entities["embryos"][item_id] = embryo
                created.append(embryo)
                audit(state, request, "INSERT", "embryo", item_id, None, embryo)
            return 201, {"items": created}

        return store.execute_mutation(request, body, operation)

    @router.patch("/embryos/{id}")
    async def update_embryo(id: str, request: Request, body: dict[str, Any]):
        embryo_id = id
        body = normalize(body)

        def operation(state: State):
            embryo = state.entities["embryos"].get(embryo_id)
            if not embryo or embryo.get("active") is False or embryo.get("deletedAt") is not None:
                raise APIError(404, "not_found", "ไม่พบ embryo")
            old = copy.deepcopy(embryo)
            well = body.get("wellPosition") if "wellPosition" in body else embryo.get("wellPosition")
            if well is not None and (not isinstance(well, str) or re.fullmatch(r"[A-H](?:1[0-2]|[1-9])", well) is None):
                raise APIError(422, "validation_error", "wellPosition ต้องอยู่ในช่วง A1 ถึง H12")
            if well is not None and any(
                item.get("id") != embryo_id
                and item.get("injectionLotId") == embryo.get("injectionLotId")
                and item.get("wellPosition") == well
                and item.get("active") is not False
                and item.get("deletedAt") is None
                for item in state.entities["embryos"].values()
            ):
                raise APIError(409, "conflict", "wellPosition ซ้ำใน injection lot")
            updated = {**embryo, "wellPosition": well, "updatedAt": iso_now()}
            state.entities["embryos"][embryo_id] = updated
            audit(state, request, "UPDATE", "embryo", embryo_id, old, updated)
            return 200, updated

        return store.execute_mutation(request, body, operation)

    @router.delete("/embryos/{id}")
    async def delete_embryo(id: str, request: Request):
        embryo_id = id

        def operation(state: State):
            embryo = state.entities["embryos"].get(embryo_id)
            if not embryo:
                raise APIError(404, "not_found", "ไม่พบ embryo")
            old = copy.deepcopy(embryo)
            embryo.update({"active": False, "deletedAt": iso_now(), "updatedAt": iso_now()})
            audit(state, request, "UPDATE", "embryo", embryo_id, old, embryo)
            return 204, b""

        return store.execute_mutation(request, {}, operation)

    @router.get("/batches/{id}/control-arm-counts")
    def get_control_counts(id: str) -> dict[str, Any]:
        batch_id = id
        state = store.snapshot()
        items = [
            copy.deepcopy(item)
            for item in state.entities["control-arm-counts"].values()
            if item.get("batchId") == batch_id and item.get("active") is not False and item.get("deletedAt") is None
        ]
        return {"items": _control_items(items)}

    @router.put("/batches/{id}/control-arm-counts")
    async def replace_control_counts(id: str, request: Request, body: dict[str, Any]):
        batch_id = id
        body = normalize(body)

        def operation(state: State):
            batch = state.entities["batches"].get(batch_id)
            if not batch or batch.get("active") is False or batch.get("deletedAt") is not None:
                raise APIError(404, "not_found", "batch not found")
            items = body.get("items")
            if not isinstance(items, list):
                raise APIError(422, "validation_error", "items is required")
            keys = set()
            validated = []
            for item in items:
                if not isinstance(item, dict):
                    raise APIError(422, "validation_error", "each control count must be an object")
                arm, stage = item.get("armType"), str(item.get("stageCode") or "")
                if arm not in {"NATURAL_BREEDING", "IVF"} or stage_number(stage) not in range(1, 37):
                    raise APIError(422, "validation_error", "armType or stageCode is invalid")
                if any(
                    isinstance(item.get(field), bool) or not isinstance(item.get(field), int) or item[field] < 0
                    for field in ("nNormal", "nAbnormal")
                ):
                    raise APIError(422, "validation_error", "counts must be non-negative integers")
                if (arm, stage) in keys:
                    raise APIError(422, "validation_error", "duplicate armType and stageCode")
                keys.add((arm, stage))
                validated.append(
                    {
                        "armType": arm,
                        "stageCode": stage,
                        "nNormal": item["nNormal"],
                        "nAbnormal": item["nAbnormal"],
                    }
                )
            result = []
            for item in validated:
                key = (item["armType"], item["stageCode"])
                existing = next(
                    (
                        candidate
                        for candidate in state.entities["control-arm-counts"].values()
                        if candidate.get("batchId") == batch_id
                        and (candidate.get("armType"), candidate.get("stageCode")) == key
                    ),
                    None,
                )
                if existing:
                    old = copy.deepcopy(existing)
                    existing.update({**item, "active": True, "deletedAt": None, "updatedAt": iso_now()})
                    audit(state, request, "UPDATE", "control_arm_count", existing["id"], old, existing)
                    result.append(copy.deepcopy(existing))
                else:
                    item_id, now = uuid7(), iso_now()
                    created = {
                        **item,
                        "id": item_id,
                        "batchId": batch_id,
                        "active": True,
                        "createdAt": now,
                        "updatedAt": now,
                    }
                    state.entities["control-arm-counts"][item_id] = created
                    audit(state, request, "INSERT", "control_arm_count", item_id, None, created)
                    result.append(created)
            for existing in state.entities["control-arm-counts"].values():
                if existing.get("batchId") != batch_id or existing.get("deletedAt") is not None:
                    continue
                if (existing.get("armType"), existing.get("stageCode")) not in keys:
                    old = copy.deepcopy(existing)
                    existing.update({"active": False, "deletedAt": iso_now(), "updatedAt": iso_now()})
                    audit(state, request, "UPDATE", "control_arm_count", existing["id"], old, existing)
            return 200, {"items": _control_items(result)}

        return store.execute_mutation(request, body, operation)

    return router

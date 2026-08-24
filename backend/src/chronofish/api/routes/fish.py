from __future__ import annotations

import copy
from datetime import date, datetime
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Query, Request

from ...domain.rules import (
    age_days_on,
    condition_valid,
    fish_outcome_valid,
    promotion_eligible_at,
    stage_label,
    stage_number,
)
from ...domain.state import State
from ...runtime.errors import APIError
from ...runtime.mutations import audit
from ...runtime.values import iso_now, normalize, parse_datetime, utc_now, uuid7
from ...services.fish import (
    SEX_VALUES,
    apply_fish_update,
    enrich_fish,
    find_fish_for_embryo,
    fish_box_is_assignable,
    fish_was_alive_on,
    latest_embryo_observation,
    promotion_threshold,
    recompute_fish,
    suggest_fish_code,
)
from ...store import Store

BANGKOK = ZoneInfo("Asia/Bangkok")
SPECIMEN_KINDS = {"CL", "RT", "DC"}
SPECIMEN_TYPES = {"WHOLE_EMBRYO", "CAUDAL_FIN_CLIP"}
SPECIMEN_STORAGES = {"-20", "-80"}
FISH_OBSERVATION_PATCH_FIELDS = {"observedOn", "outcome", "condition", "notes", "overrideReason", "correctionReason"}
FISH_OBSERVATION_CREATE_FIELDS = {
    "clientUuid",
    "cloneFishId",
    "observedOn",
    "outcome",
    "condition",
    "notes",
    "overrideReason",
}


def _specimen_date(value: Any, field: str) -> date | None:
    if value in (None, ""):
        return None
    try:
        return date.fromisoformat(str(value))
    except ValueError as error:
        raise APIError(422, "validation_error", f"{field} ต้องเป็น YYYY-MM-DD") from error


def build_fish_router(store: Store) -> APIRouter:
    router = APIRouter(prefix="/api/v1")

    @router.get("/promotions/pending")
    def pending_promotions(siteId: str | None = None) -> dict[str, Any]:
        state, now = store.snapshot(), utc_now()
        candidates = []
        next_no = state.next_fish_no
        for embryo in state.entities["embryos"].values():
            embryo_id = str(embryo.get("id"))
            if (
                embryo.get("active") is False
                or embryo.get("deletedAt") is not None
                or embryo.get("exitReason")
                or find_fish_for_embryo(state, embryo_id)
            ):
                continue
            latest = latest_embryo_observation(state, embryo_id)
            lot = state.entities["injection-lots"].get(str(embryo.get("injectionLotId")))
            batch = state.entities["batches"].get(str((lot or {}).get("batchId")))
            if not latest or latest.get("outcome") != "ALIVE" or not lot or not batch:
                continue
            if siteId and batch.get("siteId") != siteId:
                continue
            activated = parse_datetime(str(lot["activatedAt"]))
            if not promotion_eligible_at(False, True, activated, now, promotion_threshold(state, batch)):
                continue
            donor = state.entities["donor-cell-lines"].get(str(lot.get("donorCellLineId")), {})
            strain = str(donor.get("strain") or "")
            candidates.append(
                {
                    "embryoId": embryo_id,
                    "embryoCode": embryo.get("embryoCode"),
                    "batchCode": batch.get("batchCode"),
                    "siteId": batch.get("siteId"),
                    "donorCellLineId": lot.get("donorCellLineId"),
                    "dob": activated.astimezone(BANGKOK).date().isoformat(),
                    "ageDays": (now.astimezone(BANGKOK).date() - activated.astimezone(BANGKOK).date()).days,
                    "strain": strain,
                    "condition": latest.get("condition", "NORMAL"),
                    "firstAbnormalOn": embryo.get("firstAbnormalOn"),
                    "firstAbnormalAgeDays": embryo.get("firstAbnormalAgeDays"),
                    "firstAbnormalStageCode": embryo.get("firstAbnormalStageCode"),
                    "firstAbnormalStageLabel": stage_label(stage_number(str(embryo.get("firstAbnormalStageCode", ""))))
                    if embryo.get("firstAbnormalStageCode")
                    else None,
                    "suggestedFishCode": suggest_fish_code(embryo, strain, activated, next_no + len(candidates)),
                    "suggestedRunningNo": next_no + len(candidates),
                }
            )
        return {"items": candidates}

    @router.post("/promotions")
    async def create_promotions(request: Request, body: dict[str, Any]):
        body = normalize(body)

        def operation(state: State):
            raw = body.get("promotions")
            if not isinstance(raw, list) or not raw:
                raise APIError(422, "validation_error", "ต้องระบุ promotions อย่างน้อยหนึ่งรายการ")
            results = []
            for item in raw:
                if not isinstance(item, dict):
                    continue
                client_id = str(item.get("clientUuid") or "")
                try:
                    UUID(client_id)
                except ValueError:
                    results.append(
                        {"clientUuid": client_id, "status": "rejected", "error": {"message": "clientUuid ต้องเป็น UUID"}}
                    )
                    continue
                embryo = state.entities["embryos"].get(str(item.get("embryoId")))
                existing = find_fish_for_embryo(state, str(item.get("embryoId")))
                if existing:
                    results.append({"clientUuid": client_id, "status": "duplicate", "id": existing["id"]})
                    continue
                latest = latest_embryo_observation(state, str(item.get("embryoId")))
                lot = state.entities["injection-lots"].get(str((embryo or {}).get("injectionLotId")))
                batch = state.entities["batches"].get(str((lot or {}).get("batchId")))
                activated = parse_datetime(str(lot["activatedAt"])) if lot and lot.get("activatedAt") else None
                eligible = (
                    embryo
                    and embryo.get("active") is not False
                    and embryo.get("deletedAt") is None
                    and not embryo.get("exitReason")
                    and latest
                    and latest.get("outcome") == "ALIVE"
                    and lot
                    and batch
                    and activated
                    and promotion_eligible_at(False, True, activated, utc_now(), promotion_threshold(state, batch))
                )
                if not eligible:
                    results.append(
                        {
                            "clientUuid": client_id,
                            "status": "rejected",
                            "error": {"message": "embryo ยังไม่เข้าเกณฑ์เลื่อนขั้น"},
                        }
                    )
                    continue
                if item.get("fishBoxId") and not fish_box_is_assignable(
                    state, str(item["fishBoxId"]), str(batch.get("siteId") or "")
                ):
                    results.append(
                        {
                            "clientUuid": client_id,
                            "status": "rejected",
                            "error": {"message": "ไม่พบ fishBoxId ที่ active ใน site นี้"},
                        }
                    )
                    continue
                donor = state.entities["donor-cell-lines"].get(str(lot.get("donorCellLineId")), {})
                running_no = state.next_fish_no
                fish_code = str(
                    item.get("fishCode")
                    or suggest_fish_code(embryo, str(donor.get("strain") or ""), activated, running_no)
                )
                if any(
                    str(fish.get("fishCode", "")).casefold() == fish_code.casefold()
                    for fish in state.entities["fish"].values()
                ):
                    results.append(
                        {"clientUuid": client_id, "status": "rejected", "error": {"message": "fishCode ซ้ำกับรายการเดิม"}}
                    )
                    continue
                fish_id = uuid7()
                fish = {
                    "id": fish_id,
                    "embryoId": embryo["id"],
                    "embryoCode": embryo.get("embryoCode"),
                    "fishCode": fish_code,
                    "runningNo": running_no,
                    "dob": activated.astimezone(BANGKOK).date().isoformat(),
                    "donorCellLineId": lot.get("donorCellLineId"),
                    "siteId": batch.get("siteId"),
                    "fishBoxId": item.get("fishBoxId"),
                    "status": "ALIVE",
                    "condition": "ABNORMAL"
                    if embryo.get("firstAbnormalStageCode")
                    else latest.get("condition", "NORMAL"),
                    "sex": "UNKNOWN",
                    "finClipped": False,
                    "active": True,
                    "remarks": item.get("remarks"),
                    "createdAt": iso_now(),
                    "updatedAt": iso_now(),
                }
                for field in (
                    "firstAbnormalOn",
                    "firstAbnormalAgeDays",
                    "firstAbnormalStageCode",
                    "firstAbnormalStageId",
                ):
                    if embryo.get(field) is not None:
                        fish[field] = embryo[field]
                if embryo.get("firstAbnormalOn"):
                    fish["firstAbnormalSource"] = "embryo"
                state.next_fish_no += 1
                state.entities["fish"][fish_id] = fish
                old_embryo = copy.deepcopy(embryo)
                embryo.update({"exitReason": "PROMOTED", "exitAt": iso_now(), "updatedAt": iso_now()})
                audit(state, request, "INSERT", "clone_fish", fish_id, None, fish)
                audit(state, request, "UPDATE", "embryo", embryo["id"], old_embryo, embryo)
                results.append({"clientUuid": client_id, "id": fish_id, "status": "created", "fish": fish})
            return 201, {"items": results}

        return store.execute_mutation(request, body, operation)

    @router.get("/fish")
    def list_fish(
        status: str | None = None,
        siteId: str | None = None,
        boxId: str | None = None,
        treatmentGroupId: str | None = None,
        strain: str | None = None,
        condition: str | None = None,
        dobFrom: str | None = None,
        dobTo: str | None = None,
        cursor: str | None = None,
        limit: int = Query(100, ge=1, le=500),
    ) -> dict[str, Any]:
        state = store.snapshot()
        items = []
        for fish in state.entities["fish"].values():
            if fish.get("active") is False or fish.get("deletedAt") is not None:
                continue
            item = enrich_fish(state, fish)
            if status and item.get("status") != status or siteId and item.get("siteId") != siteId:
                continue
            if boxId and item.get("fishBoxId") != boxId or condition and item.get("condition") != condition:
                continue
            if treatmentGroupId and item.get("treatmentGroupId") != treatmentGroupId:
                continue
            if strain and strain.casefold() not in str(item.get("strain", "")).casefold():
                continue
            if dobFrom and str(item.get("dob", "")) < dobFrom or dobTo and str(item.get("dob", "")) > dobTo:
                continue
            items.append(item)
        items.sort(key=lambda item: int(item.get("runningNo", 0)))
        try:
            offset = max(int(cursor or 0), 0)
        except ValueError as error:
            raise APIError(400, "invalid_query", "cursor is invalid") from error
        end = min(offset + limit, len(items))
        return {"items": items[offset:end], "nextCursor": str(end) if end < len(items) else None}

    @router.post("/fish")
    async def create_fish(request: Request, body: dict[str, Any]):
        body = normalize(body)

        def operation(state: State):
            for field in ("fishCode", "dob", "donorCellLineId"):
                if not body.get(field):
                    raise APIError(422, "validation_error", f"ต้องระบุ {field}")
            try:
                dob = date.fromisoformat(str(body["dob"]))
            except ValueError as error:
                raise APIError(422, "validation_error", "dob ต้องเป็น YYYY-MM-DD") from error
            today = datetime.now(BANGKOK).date()
            if dob > today:
                raise APIError(422, "validation_error", "dob ห้ามอยู่ในอนาคต")
            if dob < today and not body.get("overrideReason"):
                raise APIError(422, "validation_error", "ต้องระบุ overrideReason เมื่อเพิ่มปลาย้อนหลัง")
            donor = state.entities["donor-cell-lines"].get(str(body["donorCellLineId"]))
            if not donor or donor.get("active") is False:
                raise APIError(422, "validation_error", "ไม่พบ donorCellLineId ที่ active")
            for field, resource in (("siteId", "sites"), ("fishBoxId", "fish-boxes")):
                if body.get(field):
                    target = state.entities[resource].get(str(body[field]))
                    if not target or target.get("active") is False:
                        raise APIError(422, "validation_error", f"ไม่พบ {field} ที่ active")
            if any(
                str(item.get("fishCode", "")).casefold() == str(body["fishCode"]).casefold()
                for item in state.entities["fish"].values()
            ):
                raise APIError(409, "conflict", "fishCode ซ้ำ")
            if body.get("condition") and not condition_valid(str(body["condition"])):
                raise APIError(422, "validation_error", "condition ไม่ถูกต้อง")
            if body.get("sex") and body["sex"] not in SEX_VALUES:
                raise APIError(422, "validation_error", "sex ไม่ถูกต้อง")
            fish_id, now = uuid7(), iso_now()
            fish = {
                "id": fish_id,
                "embryoId": None,
                "fishCode": str(body["fishCode"]),
                "dob": dob.isoformat(),
                "donorCellLineId": body["donorCellLineId"],
                "siteId": body.get("siteId"),
                "fishBoxId": body.get("fishBoxId"),
                "remarks": body.get("remarks"),
                "runningNo": state.next_fish_no,
                "status": "ALIVE",
                "condition": body.get("condition") or "NORMAL",
                "sex": body.get("sex") or "UNKNOWN",
                "finClipped": False,
                "active": True,
                "createdAt": now,
                "updatedAt": now,
            }
            state.next_fish_no += 1
            state.entities["fish"][fish_id] = fish
            audit(
                state,
                request,
                "INSERT",
                "clone_fish",
                fish_id,
                None,
                {**fish, "overrideReason": body.get("overrideReason")},
            )
            return 201, enrich_fish(state, fish)

        return store.execute_mutation(request, body, operation)

    @router.get("/fish/{id}")
    def get_fish(id: str) -> dict[str, Any]:
        fish_id = id
        state = store.snapshot()
        fish = state.entities["fish"].get(fish_id)
        if not fish or fish.get("active") is False or fish.get("deletedAt") is not None:
            raise APIError(404, "not_found", "ไม่พบปลา")
        result = enrich_fish(state, fish)
        result["observations"] = sorted(
            (
                copy.deepcopy(item)
                for item in state.fish_observations.values()
                if item.get("cloneFishId") == fish_id and item.get("deletedAt") is None
            ),
            key=lambda item: str(item.get("observedOn", "")),
        )
        result["specimens"] = [
            copy.deepcopy(item)
            for item in state.entities["specimens"].values()
            if item.get("cloneFishId") == fish_id and item.get("active") is not False and item.get("deletedAt") is None
        ]
        result["embryoTimeline"] = sorted(
            (
                copy.deepcopy(item)
                for item in state.observations.values()
                if item.get("embryoId") == fish.get("embryoId") and item.get("deletedAt") is None
            ),
            key=lambda item: str(item.get("observedAt", "")),
        )
        return result

    @router.patch("/fish/{id}")
    async def update_fish(id: str, request: Request, body: dict[str, Any]):
        fish_id = id
        body = normalize(body)

        def operation(state: State):
            old, fish = apply_fish_update(state, fish_id, body)
            audit(state, request, "UPDATE", "clone_fish", fish_id, old, fish)
            return 200, enrich_fish(state, fish)

        return store.execute_mutation(request, body, operation)

    @router.get("/fish/{id}/specimens")
    def specimens(id: str) -> dict[str, Any]:
        fish_id = id
        state = store.snapshot()
        return {
            "items": [
                copy.deepcopy(item)
                for item in state.entities["specimens"].values()
                if item.get("cloneFishId") == fish_id
                and item.get("active") is not False
                and item.get("deletedAt") is None
            ]
        }

    @router.post("/fish/{id}/specimens")
    async def create_specimen(id: str, request: Request, body: dict[str, Any]):
        fish_id = id
        body = normalize(body)

        def operation(state: State):
            fish = state.entities["fish"].get(fish_id)
            if not fish:
                raise APIError(404, "not_found", "ไม่พบปลา")
            for field in ("specimenCode", "specimenKind", "specimenType"):
                if not body.get(field):
                    raise APIError(422, "validation_error", f"ต้องระบุ {field}")
            if body["specimenKind"] not in SPECIMEN_KINDS or body["specimenType"] not in SPECIMEN_TYPES:
                raise APIError(422, "validation_error", "specimenKind หรือ specimenType ไม่ถูกต้อง")
            collected_on = _specimen_date(body.get("collectedOn"), "collectedOn")
            frozen_on = _specimen_date(body.get("frozenOn"), "frozenOn")
            if collected_on and collected_on > datetime.now(BANGKOK).date():
                raise APIError(422, "validation_error", "collectedOn ห้ามอยู่ในอนาคต")
            if frozen_on and frozen_on > datetime.now(BANGKOK).date():
                raise APIError(422, "validation_error", "frozenOn ห้ามอยู่ในอนาคต")
            if frozen_on and collected_on and frozen_on < collected_on:
                raise APIError(422, "validation_error", "frozenOn ต้องไม่ก่อน collectedOn")
            if body.get("storage") not in (None, "") and not frozen_on:
                raise APIError(422, "validation_error", "ต้องระบุ frozenOn เมื่อระบุ storage")
            if body.get("storage") not in (None, "") and body["storage"] not in SPECIMEN_STORAGES:
                raise APIError(422, "validation_error", "storage ต้องเป็น -20 หรือ -80")
            code = str(body["specimenCode"]).casefold()
            if any(
                str(item.get("specimenCode", "")).casefold() == code for item in state.entities["specimens"].values()
            ):
                raise APIError(409, "conflict", "specimenCode ซ้ำ")
            item_id = uuid7()
            specimen = {
                "id": item_id,
                "cloneFishId": fish_id,
                "specimenCode": str(body["specimenCode"]),
                "specimenKind": body["specimenKind"],
                "specimenType": body["specimenType"],
                "collectedOn": collected_on.isoformat() if collected_on else None,
                "frozenOn": frozen_on.isoformat() if frozen_on else None,
                "storage": body.get("storage") or None,
                "notes": body.get("notes"),
                "active": True,
                "createdAt": iso_now(),
            }
            state.entities["specimens"][item_id] = specimen
            audit(state, request, "INSERT", "specimen", item_id, None, specimen)
            if body.get("markFinClipped"):
                old = copy.deepcopy(fish)
                fish.update({"finClipped": True, "updatedAt": iso_now()})
                audit(state, request, "UPDATE", "clone_fish", fish_id, old, fish)
            return 201, specimen

        return store.execute_mutation(request, body, operation)

    @router.get("/fish/roll-call")
    def roll_call(
        date_value: str | None = Query(None, alias="date"), siteId: str | None = None, boxId: str | None = None
    ) -> dict[str, Any]:
        state = store.snapshot()
        value = date_value or datetime.now(BANGKOK).date().isoformat()
        try:
            observed_date = date.fromisoformat(value)
        except ValueError as error:
            raise APIError(422, "validation_error", "invalid Bangkok date") from error
        items = []
        for fish in state.entities["fish"].values():
            if fish.get("active") is False or fish.get("deletedAt") is not None:
                continue
            if siteId and fish.get("siteId") != siteId or boxId and fish.get("fishBoxId") != boxId:
                continue
            dob = date.fromisoformat(fish["dob"])
            if observed_date < dob or not fish_was_alive_on(fish, observed_date):
                continue
            embryo = state.entities["embryos"].get(str(fish.get("embryoId")), {})
            lot = state.entities["injection-lots"].get(str(embryo.get("injectionLotId")), {})
            donor = state.entities["donor-cell-lines"].get(str(lot.get("donorCellLineId")), {})
            box = state.entities["fish-boxes"].get(str(fish.get("fishBoxId")), {})
            recorded = next(
                (
                    item
                    for item in state.fish_observations.values()
                    if item.get("cloneFishId") == fish["id"]
                    and item.get("observedOn") == value
                    and item.get("deletedAt") is None
                ),
                None,
            )
            items.append(
                {
                    "fishId": fish["id"],
                    "fishCode": fish["fishCode"],
                    "injectionLotId": lot.get("id"),
                    "ageDays": age_days_on(date.fromisoformat(fish["dob"]), observed_date),
                    "status": "ALIVE",
                    "condition": fish["condition"],
                    "strain": donor.get("strain"),
                    "fishBoxCode": box.get("boxCode"),
                    "alreadyRecorded": recorded is not None,
                    "observationId": recorded.get("id") if recorded else None,
                    "recordedOutcome": recorded.get("outcome") if recorded else None,
                    "firstAbnormalOn": fish.get("firstAbnormalOn"),
                    "firstAbnormalAgeDays": fish.get("firstAbnormalAgeDays"),
                }
            )
        items.sort(key=lambda item: item["fishCode"])
        return {"date": value, "items": items}

    @router.post("/observations/fish")
    async def create_fish_observations(request: Request, body: dict[str, Any]):
        body = normalize(body)

        def operation(state: State):
            raw = body.get("observations")
            if not isinstance(raw, list):
                raise APIError(422, "validation_error", "ต้องระบุ observations")
            results = []
            for item in raw:
                client_id = str(item.get("clientUuid") or "") if isinstance(item, dict) else ""
                try:
                    UUID(client_id)
                except ValueError:
                    results.append(
                        {"clientUuid": client_id, "status": "rejected", "error": {"message": "ข้อมูลบังคับไม่ครบ"}}
                    )
                    continue
                unknown = set(item) - FISH_OBSERVATION_CREATE_FIELDS
                if unknown:
                    results.append(
                        {
                            "clientUuid": client_id,
                            "status": "rejected",
                            "error": {"message": f"field นี้ไม่ได้รับอนุญาต: {sorted(unknown)[0]}"},
                        }
                    )
                    continue
                fish = state.entities["fish"].get(str(item.get("cloneFishId")))
                try:
                    observed = date.fromisoformat(str(item.get("observedOn")))
                except ValueError:
                    observed = None
                if (
                    not fish
                    or not observed
                    or observed < date.fromisoformat(fish["dob"])
                    or observed > datetime.now(BANGKOK).date()
                    or not fish_outcome_valid(str(item.get("outcome")))
                    or not condition_valid(str(item.get("condition")))
                ):
                    results.append(
                        {"clientUuid": client_id, "status": "rejected", "error": {"message": "วันที่หรือ enum ไม่ถูกต้อง"}}
                    )
                    continue
                existing = next(
                    (
                        value
                        for value in state.fish_observations.values()
                        if value.get("deletedAt") is None
                        and (
                            value.get("clientUuid") == client_id
                            or (
                                value.get("cloneFishId") == fish["id"] and value.get("observedOn") == item["observedOn"]
                            )
                        )
                    ),
                    None,
                )
                if existing:
                    results.append(
                        {
                            "clientUuid": client_id,
                            "id": existing["id"],
                            "status": "duplicate",
                            "ageDays": existing["ageDays"],
                            "outcome": existing["outcome"],
                            "condition": existing["condition"],
                        }
                    )
                    continue
                backdated = observed != datetime.now(BANGKOK).date()
                if backdated and not item.get("overrideReason"):
                    results.append(
                        {
                            "clientUuid": client_id,
                            "status": "rejected",
                            "error": {"message": "ต้องระบุ overrideReason สำหรับข้อมูลย้อนหลัง"},
                        }
                    )
                    continue
                if item["outcome"] == "ALIVE" and fish.get("status") != "ALIVE" and not item.get("overrideReason"):
                    results.append(
                        {
                            "clientUuid": client_id,
                            "status": "rejected",
                            "error": {"message": "ต้องระบุ overrideReason เมื่อแก้สถานะปลาที่ปิดแล้ว"},
                        }
                    )
                    continue
                observation_id = uuid7()
                observation = {
                    "id": observation_id,
                    "clientUuid": client_id,
                    "cloneFishId": fish["id"],
                    "observedOn": observed.isoformat(),
                    "outcome": item["outcome"],
                    "condition": item["condition"],
                    "notes": item.get("notes"),
                    "overrideReason": item.get("overrideReason"),
                    "operatorId": request.headers.get("X-Operator-Id"),
                    "deviceId": request.headers.get("X-Device-Id"),
                    "isBackdated": backdated,
                    "ageDays": age_days_on(date.fromisoformat(fish["dob"]), observed),
                    "createdAt": iso_now(),
                }
                state.fish_observations[observation_id] = observation
                old_fish = copy.deepcopy(fish)
                recompute_fish(state, fish["id"])
                audit(state, request, "INSERT", "fish_observation", observation_id, None, observation)
                if old_fish != fish:
                    audit(state, request, "UPDATE", "clone_fish", fish["id"], old_fish, fish)
                results.append(
                    {
                        "clientUuid": client_id,
                        "id": observation_id,
                        "status": "created",
                        "ageDays": observation["ageDays"],
                        "fishClosed": item["outcome"] != "ALIVE",
                    }
                )
            return 200, {"results": results}

        return store.execute_mutation(request, body, operation)

    def change_fish_observation(observation_id: str, request: Request, body: dict[str, Any] | None, reason: str = ""):
        payload = normalize(body or {})

        def operation(state: State):
            observation = state.fish_observations.get(observation_id)
            if not observation or observation.get("deletedAt") is not None:
                raise APIError(404, "not_found", "ไม่พบ observation")
            old = copy.deepcopy(observation)
            if request.method == "DELETE":
                if not reason.strip():
                    raise APIError(422, "validation_error", "reason is required")
                observation.update({"deletedAt": iso_now(), "overrideReason": reason.strip(), "updatedAt": iso_now()})
                status, result, action = 204, b"", "DELETE"
            else:
                unknown = set(payload) - FISH_OBSERVATION_PATCH_FIELDS
                if unknown:
                    raise APIError(422, "validation_error", f"แก้ไข field นี้ไม่ได้: {sorted(unknown)[0]}")
                correction = str(payload.get("overrideReason") or payload.get("correctionReason") or "").strip()
                if not correction:
                    raise APIError(422, "validation_error", "ต้องระบุ correctionReason")
                candidate = {
                    **observation,
                    **{
                        key: value
                        for key, value in payload.items()
                        if key in {"observedOn", "outcome", "condition", "notes"}
                    },
                }
                if not fish_outcome_valid(str(candidate.get("outcome"))) or not condition_valid(
                    str(candidate.get("condition"))
                ):
                    raise APIError(422, "validation_error", "invalid fish outcome or condition")
                fish = state.entities["fish"].get(str(candidate["cloneFishId"]), {})
                observed = date.fromisoformat(str(candidate["observedOn"]))
                if observed < date.fromisoformat(str(fish["dob"])) or observed > datetime.now(BANGKOK).date():
                    raise APIError(422, "validation_error", "invalid observedOn")
                candidate.update(
                    {
                        "overrideReason": correction,
                        "ageDays": age_days_on(date.fromisoformat(fish["dob"]), observed),
                        "isBackdated": observed != datetime.now(BANGKOK).date(),
                        "updatedAt": iso_now(),
                    }
                )
                state.fish_observations[observation_id] = observation = candidate
                status, result, action = 200, observation, "UPDATE"
            fish_id = str(observation["cloneFishId"])
            old_fish = copy.deepcopy(state.entities["fish"].get(fish_id, {}))
            recompute_fish(state, fish_id)
            audit(state, request, action, "fish_observation", observation_id, old, observation)
            if old_fish != state.entities["fish"].get(fish_id):
                audit(state, request, "UPDATE", "clone_fish", fish_id, old_fish, state.entities["fish"][fish_id])
            return status, result

        return store.execute_mutation(request, payload, operation)

    @router.patch("/observations/fish/{id}")
    async def update_fish_observation(id: str, request: Request, body: dict[str, Any]):
        return change_fish_observation(id, request, body)

    @router.delete("/observations/fish/{id}")
    async def delete_fish_observation(id: str, request: Request, reason: str = Query("")):
        return change_fish_observation(id, request, None, reason)

    # FastAPI checks routes in registration order; fixed paths must precede `/fish/{id}`.
    router.routes.sort(key=lambda route: "{" in route.path)
    return router

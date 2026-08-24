from __future__ import annotations

import copy
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from ..domain.rules import age_days_on
from ..domain.state import State
from ..runtime.errors import APIError
from ..runtime.values import iso_now

BANGKOK = ZoneInfo("Asia/Bangkok")
FISH_UPDATE_FIELDS = {"fishCode", "fishBoxId", "sex", "finClipped", "remarks"}
SEX_VALUES = {"UNKNOWN", "M", "F"}


def find_fish_for_embryo(state: State, embryo_id: str) -> dict[str, Any] | None:
    return next(
        (
            fish
            for fish in state.entities["fish"].values()
            if fish.get("embryoId") == embryo_id and fish.get("active") is not False and fish.get("deletedAt") is None
        ),
        None,
    )


def latest_embryo_observation(state: State, embryo_id: str) -> dict[str, Any] | None:
    return max(
        (
            item
            for item in state.observations.values()
            if item.get("embryoId") == embryo_id and item.get("deletedAt") is None
        ),
        key=lambda item: str(item.get("observedAt", "")),
        default=None,
    )


def promotion_threshold(state: State, batch: dict[str, Any]) -> int:
    protocol = state.entities["protocols"].get(str(batch.get("protocolId")), {})
    return max(int(protocol.get("stage1MaxAgeDays", 5)), 1)


def suggest_fish_code(embryo: dict[str, Any], strain: str, activated: datetime, running_no: int) -> str:
    day = activated.astimezone(BANGKOK).strftime("%d")
    return f"No.{running_no}_Clone{int(embryo.get('seqInLot', 0))}-{strain or 'unknown'} cell-{day}"


def enrich_fish(state: State, fish: dict[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(fish)
    try:
        result["ageDays"] = age_days_on(date.fromisoformat(str(fish["dob"])), datetime.now(BANGKOK).date())
    except (KeyError, ValueError):
        result["ageDays"] = 0
    donor = state.entities["donor-cell-lines"].get(str(fish.get("donorCellLineId")), {})
    result["strain"] = donor.get("strain", "")
    box = state.entities["fish-boxes"].get(str(fish.get("fishBoxId")), {})
    result["fishBoxCode"] = box.get("boxCode")
    embryo = state.entities["embryos"].get(str(fish.get("embryoId")), {})
    lot = state.entities["injection-lots"].get(str(embryo.get("injectionLotId")), {})
    batch = state.entities["batches"].get(str(lot.get("batchId")), {})
    result["treatmentGroupId"] = batch.get("treatmentGroupId")
    return result


def fish_was_alive_on(fish: dict[str, Any], observed_on: date) -> bool:
    if fish.get("status") == "ALIVE":
        return True
    try:
        return observed_on < date.fromisoformat(str(fish["exitDate"]))
    except (KeyError, ValueError):
        return False


def fish_box_is_assignable(state: State, fish_box_id: str, site_id: str | None) -> bool:
    box = state.entities["fish-boxes"].get(fish_box_id)
    return bool(
        box
        and box.get("active") is not False
        and box.get("deletedAt") is None
        and (not site_id or not box.get("siteId") or box.get("siteId") == site_id)
    )


def recompute_fish(state: State, fish_id: str) -> None:
    fish = state.entities["fish"].get(fish_id)
    if not fish:
        return
    values = [
        item
        for item in state.fish_observations.values()
        if item.get("cloneFishId") == fish_id and item.get("deletedAt") is None
    ]
    latest = max(values, key=lambda item: str(item.get("observedOn", "")), default=None)
    abnormal = min(
        (item for item in values if item.get("condition") == "ABNORMAL"),
        key=lambda item: str(item.get("observedOn", "")),
        default=None,
    )
    embryo = state.entities["embryos"].get(str(fish.get("embryoId")), {})
    inherited = {
        field: embryo[field]
        for field in ("firstAbnormalOn", "firstAbnormalAgeDays", "firstAbnormalStageCode", "firstAbnormalStageId")
        if embryo.get(field) is not None
    }
    if latest:
        fish["condition"] = latest["condition"]
        if latest["outcome"] in {"ALIVE", "NOT_OBSERVED"}:
            fish["status"] = "ALIVE"
            fish.pop("exitDate", None)
            fish.pop("exitReason", None)
        else:
            fish.update(
                {"status": latest["outcome"], "exitDate": latest["observedOn"], "exitReason": latest["outcome"]}
            )
    else:
        fish["status"] = "ALIVE"
        fish.pop("exitDate", None)
        fish.pop("exitReason", None)
    if abnormal and (not inherited.get("firstAbnormalOn") or abnormal["observedOn"] < inherited["firstAbnormalOn"]):
        fish.update(
            {
                "firstAbnormalOn": abnormal["observedOn"],
                "firstAbnormalAgeDays": age_days_on(
                    date.fromisoformat(fish["dob"]), date.fromisoformat(abnormal["observedOn"])
                ),
                "firstAbnormalSource": "fish",
            }
        )
    elif inherited:
        fish.update(inherited)
        fish["firstAbnormalSource"] = "embryo"
    elif fish.get("firstAbnormalSource") == "fish":
        for field in (
            "firstAbnormalOn",
            "firstAbnormalAgeDays",
            "firstAbnormalSource",
            "firstAbnormalStageCode",
            "firstAbnormalStageId",
        ):
            fish.pop(field, None)
    fish["updatedAt"] = iso_now()


def apply_fish_update(state: State, fish_id: str, body: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    fish = state.entities["fish"].get(fish_id)
    if not fish or fish.get("active") is False or fish.get("deletedAt") is not None:
        raise APIError(404, "not_found", "ไม่พบปลา")
    unknown = set(body) - FISH_UPDATE_FIELDS
    if unknown:
        raise APIError(422, "validation_error", f"แก้ไข field นี้ไม่ได้: {sorted(unknown)[0]}")
    if not body:
        raise APIError(422, "validation_error", "ต้องระบุข้อมูลที่ต้องการแก้ไข")
    if "fishCode" in body and not str(body["fishCode"]).strip():
        raise APIError(422, "validation_error", "fishCode ห้ามว่าง")
    if "sex" in body and body["sex"] not in SEX_VALUES:
        raise APIError(422, "validation_error", "sex ไม่ถูกต้อง")
    if "finClipped" in body and not isinstance(body["finClipped"], bool):
        raise APIError(422, "validation_error", "finClipped ต้องเป็น boolean")
    if "fishBoxId" in body and body["fishBoxId"]:
        box = state.entities["fish-boxes"].get(str(body["fishBoxId"]))
        if not box or box.get("active") is False or box.get("deletedAt") is not None:
            raise APIError(422, "validation_error", "ไม่พบ fishBoxId ที่ active")
    if body.get("fishCode") and any(
        item["id"] != fish_id and str(item.get("fishCode", "")).casefold() == str(body["fishCode"]).casefold()
        for item in state.entities["fish"].values()
    ):
        raise APIError(409, "conflict", "fishCode ซ้ำ")
    old = copy.deepcopy(fish)
    updates = {key: value for key, value in body.items() if key in FISH_UPDATE_FIELDS}
    if "fishBoxId" in updates and updates["fishBoxId"] in (None, ""):
        updates["fishBoxId"] = None
    fish.update(updates)
    fish["updatedAt"] = iso_now()
    return old, fish

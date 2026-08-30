from __future__ import annotations

import copy
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Query, Request

from ...domain.rules import (
    condition_valid,
    default_expected_hpa,
    deviation_label,
    is_backdated,
    promotion_eligible_at,
    round4,
    stage_code,
    stage_label,
    stage_number,
)
from ...domain.state import State
from ...runtime.errors import APIError
from ...runtime.mutations import audit
from ...runtime.values import iso_now, normalize, parse_datetime, utc_now, uuid7
from ...store import Store

BANGKOK = ZoneInfo("Asia/Bangkok")
EMBRYO_OUTCOMES = {"ALIVE", "DEAD", "DEGENERATED", "NOT_OBSERVED"}


def _latest_embryo_observation(state: State, embryo_id: str) -> dict[str, Any] | None:
    values = [
        item
        for item in state.observations.values()
        if item.get("embryoId") == embryo_id and item.get("deletedAt") is None
    ]
    return max(values, key=lambda item: str(item.get("observedAt", "")), default=None)


def _profile_entries_for_lot(state: State, lot: dict[str, Any]) -> list[dict[str, Any]]:
    batch = state.entities["batches"].get(str(lot.get("batchId")), {})
    profile = state.entities["timing-profiles"].get(str(batch.get("timingProfileId")), {})
    return profile.get("entries", []) if isinstance(profile.get("entries"), list) else []


def _expected_hpa(state: State, lot: dict[str, Any], code: str) -> float:
    entry = next((item for item in _profile_entries_for_lot(state, lot) if item.get("stageCode") == code), None)
    return float(entry.get("expectedHpa", 0)) if entry else default_expected_hpa(code)


def _stage_definition_id(state: State, embryo: dict[str, Any], code: str) -> str:
    lot = state.entities["injection-lots"].get(str(embryo.get("injectionLotId")), {})
    entry = next((item for item in _profile_entries_for_lot(state, lot) if item.get("stageCode") == code), None)
    return str((entry or {}).get("stageDefinitionId") or (entry or {}).get("id") or "")


def _interval_metrics(
    state: State, embryo_id: str, order: int, actual: float, expected: float, exclude_id: str = ""
) -> tuple[float, float, float] | None:
    earlier = [
        item
        for item in state.observations.values()
        if item.get("embryoId") == embryo_id
        and item.get("deletedAt") is None
        and item.get("id") != exclude_id
        and 0 < stage_number(str(item.get("stageCode", ""))) < order
    ]
    previous = max(earlier, key=lambda item: stage_number(str(item.get("stageCode", ""))), default=None)
    if not previous:
        return None
    interval_actual = round4(actual - float(previous.get("hpaActual", 0)))
    interval_expected = round4(expected - float(previous.get("hpaExpectedSnapshot", 0)))
    return interval_actual, interval_expected, round4(interval_actual - interval_expected)


def _recompute_embryo(state: State, embryo_id: str) -> None:
    embryo = state.entities["embryos"].get(embryo_id)
    if not embryo:
        return
    values = [
        item
        for item in state.observations.values()
        if item.get("embryoId") == embryo_id and item.get("deletedAt") is None
    ]
    latest = max(values, key=lambda item: str(item.get("observedAt", "")), default=None)
    abnormal = min(
        (item for item in values if item.get("condition") == "ABNORMAL"),
        key=lambda item: (str(item.get("observedAt", "")), stage_number(str(item.get("stageCode", "")))),
        default=None,
    )
    abnormal_fields = (
        "firstAbnormalObservationId",
        "firstAbnormalStageCode",
        "firstAbnormalStageId",
        "firstAbnormalOn",
        "firstAbnormalAgeDays",
    )
    if abnormal:
        observed = parse_datetime(str(abnormal["observedAt"]))
        lot = state.entities["injection-lots"].get(str(embryo.get("injectionLotId")), {})
        activated = parse_datetime(str(lot["activatedAt"]))
        embryo.update(
            {
                "firstAbnormalObservationId": abnormal["id"],
                "firstAbnormalStageCode": abnormal["stageCode"],
                "firstAbnormalStageId": _stage_definition_id(state, embryo, str(abnormal["stageCode"])),
                "firstAbnormalOn": observed.astimezone(BANGKOK).date().isoformat(),
                "firstAbnormalAgeDays": (
                    observed.astimezone(BANGKOK).date() - activated.astimezone(BANGKOK).date()
                ).days,
            }
        )
    else:
        for field in abnormal_fields:
            embryo.pop(field, None)
    if not latest or latest.get("outcome") in {"ALIVE", "NOT_OBSERVED"}:
        for field in ("exitReason", "exitAt", "exitStageCode", "exitStageId"):
            embryo.pop(field, None)
    else:
        embryo.update(
            {
                "exitReason": latest["outcome"],
                "exitAt": latest["observedAt"],
                "exitStageCode": latest["stageCode"],
                "exitStageId": _stage_definition_id(state, embryo, str(latest["stageCode"])),
            }
        )
    embryo["updatedAt"] = iso_now()


def _validate_observation(state: State, item: dict[str, Any]) -> str | None:
    for field in ("clientUuid", "embryoId", "stageCode", "observedAt", "outcome", "condition"):
        if not item.get(field):
            return f"ต้องระบุ {field}"
    try:
        UUID(str(item["clientUuid"]))
    except ValueError:
        return "clientUuid ต้องเป็น UUID"
    embryo = state.entities["embryos"].get(str(item["embryoId"]))
    if not embryo or embryo.get("active") is False or embryo.get("deletedAt") is not None:
        return "ไม่พบ embryo"
    if stage_number(str(item["stageCode"])) not in range(1, 37):
        return "stageCode ไม่ถูกต้อง"
    lot = state.entities["injection-lots"].get(str(embryo.get("injectionLotId")))
    if not lot or lot.get("active") is False or lot.get("deletedAt") is not None:
        return "injection lot is inactive or missing"
    try:
        observed = parse_datetime(str(item["observedAt"]))
        activated = parse_datetime(str(lot["activatedAt"]))
    except APIError as error:
        return error.message
    if observed < activated:
        return "observedAt ต้องไม่ก่อน activatedAt"
    if observed > utc_now() + timedelta(minutes=5):
        return "observedAt ห้ามอยู่ในอนาคตเกิน 5 นาที"
    if item["outcome"] not in EMBRYO_OUTCOMES or not condition_valid(str(item["condition"])):
        return "outcome หรือ condition ไม่ถูกต้อง"
    if item["outcome"] == "ALIVE" and embryo.get("exitReason") and not item.get("overrideReason"):
        exit_order = stage_number(str(embryo.get("exitStageCode") or ""))
        exit_at = parse_datetime(str(embryo["exitAt"]))
        if stage_number(str(item["stageCode"])) >= exit_order or observed >= exit_at:
            return "ต้องระบุ overrideReason เมื่อต้องการบันทึก ALIVE หลังมี exit event"
    return None


def _pending_promotions(state: State, now: datetime) -> int:
    count = 0
    for embryo in state.entities["embryos"].values():
        if embryo.get("active") is False or embryo.get("deletedAt") is not None or embryo.get("exitReason"):
            continue
        latest = _latest_embryo_observation(state, str(embryo["id"]))
        if not latest or latest.get("outcome") != "ALIVE":
            continue
        lot = state.entities["injection-lots"].get(str(embryo.get("injectionLotId")), {})
        batch = state.entities["batches"].get(str(lot.get("batchId")), {})
        protocol = state.entities["protocols"].get(str(batch.get("protocolId")), {})
        if lot.get("activatedAt") and promotion_eligible_at(
            False, True, parse_datetime(str(lot["activatedAt"])), now, int(protocol.get("stage1MaxAgeDays", 5))
        ):
            count += 1
    return count


def build_observations_router(store: Store) -> APIRouter:
    router = APIRouter(prefix="/api/v1")

    @router.get("/due-checkpoints")
    def due_checkpoints(
        siteId: str | None = None,
        operatorId: str | None = None,
        batchId: str | None = None,
        treatmentGroupId: str | None = None,
        donorCellLineId: str | None = None,
        strain: str | None = None,
        dateFrom: str | None = None,
        dateTo: str | None = None,
    ) -> dict[str, Any]:
        state, now = store.snapshot(), utc_now()
        observed_order: dict[str, int] = {}
        for observation in state.observations.values():
            if observation.get("deletedAt") is None:
                embryo_id = str(observation.get("embryoId") or "")
                observed_order[embryo_id] = max(
                    observed_order.get(embryo_id, 0), stage_number(str(observation.get("stageCode") or ""))
                )
        overdue, upcoming = [], []
        for lot in state.entities["injection-lots"].values():
            if lot.get("active") is False or lot.get("deletedAt") is not None or not lot.get("activatedAt"):
                continue
            batch = state.entities["batches"].get(str(lot.get("batchId")))
            if not batch or batch.get("active") is False or batch.get("deletedAt") is not None:
                continue
            donor = state.entities["donor-cell-lines"].get(str(lot.get("donorCellLineId")), {})
            if (
                siteId
                and batch.get("siteId") != siteId
                or operatorId
                and batch.get("operatorId") != operatorId
                or batchId
                and batch.get("id") != batchId
                or treatmentGroupId
                and batch.get("treatmentGroupId") != treatmentGroupId
                or donorCellLineId
                and lot.get("donorCellLineId") != donorCellLineId
                or strain
                and str(donor.get("strain", "")).casefold() != strain.casefold()
                or dateFrom
                and str(batch.get("experimentDate", "")) < dateFrom
                or dateTo
                and str(batch.get("experimentDate", "")) > dateTo
            ):
                continue
            embryos = [
                item
                for item in state.entities["embryos"].values()
                if item.get("injectionLotId") == lot["id"]
                and item.get("active") is not False
                and item.get("deletedAt") is None
            ]
            if not embryos:
                continue
            remaining = sum(not item.get("exitReason") for item in embryos)
            if not remaining:
                continue
            completed_order = min(
                26 if embryo.get("exitReason") else observed_order.get(str(embryo["id"]), 0) for embryo in embryos
            )
            activated = parse_datetime(str(lot["activatedAt"]))
            first_upcoming = False
            for order in range(1, 27):
                code = stage_code(order)
                if order <= completed_order:
                    continue
                due_at = activated + timedelta(hours=_expected_hpa(state, lot, code))
                minutes = int((now - due_at).total_seconds() / 60)
                item = {
                    "injectionLotId": lot["id"],
                    "batchCode": batch["batchCode"],
                    "lotNo": lot["lotNo"],
                    "stageCode": code,
                    "stageLabel": stage_label(order),
                    "stageOrder": order,
                    "dueAt": due_at.isoformat().replace("+00:00", "Z"),
                    "minutesLate": minutes,
                    "urgency": minutes,
                    "embryosRemaining": remaining,
                }
                if minutes >= 0:
                    overdue.append(item)
                elif not first_upcoming:
                    upcoming.append(item)
                    first_upcoming = True
        overdue.sort(key=lambda item: int(item["minutesLate"]), reverse=True)
        upcoming.sort(key=lambda item: str(item["dueAt"]))
        return {"overdue": overdue, "upcoming": upcoming, "pendingPromotionCount": _pending_promotions(state, now)}

    @router.get("/injection-lots/{id}/checkpoints/{stageCode}")
    def checkpoint(id: str, stageCode: str) -> dict[str, Any]:
        lot_id, code = id, stageCode
        state = store.snapshot()
        lot = state.entities["injection-lots"].get(lot_id)
        if not lot or lot.get("active") is False or lot.get("deletedAt") is not None:
            raise APIError(404, "not_found", "ไม่พบ injection lot")
        order = stage_number(code)
        if order not in range(1, 37):
            raise APIError(422, "validation_error", "stageCode ไม่ถูกต้อง")
        batch = state.entities["batches"].get(str(lot.get("batchId")), {})
        all_embryos = [
            embryo
            for embryo in state.entities["embryos"].values()
            if embryo.get("injectionLotId") == lot_id
            and embryo.get("active") is not False
            and embryo.get("deletedAt") is None
        ]
        embryos = []
        for embryo in all_embryos:
            if embryo.get("exitReason"):
                continue
            prior = _latest_embryo_observation(state, str(embryo["id"]))
            embryos.append(
                {
                    "embryoId": embryo["id"],
                    "embryoCode": embryo["embryoCode"],
                    "wellPosition": embryo.get("wellPosition"),
                    "defaultCondition": (prior or {}).get("condition", "NORMAL"),
                    "priorOutcome": (prior or {}).get("outcome"),
                    "priorStageCode": (prior or {}).get("stageCode"),
                    "firstAbnormalStageLabel": stage_label(stage_number(str(embryo.get("firstAbnormalStageCode", ""))))
                    if embryo.get("firstAbnormalStageCode")
                    else None,
                }
            )
        activated = parse_datetime(str(lot["activatedAt"]))
        expected = _expected_hpa(state, lot, code)
        stages = [
            {
                "stageCode": stage_code(item_order),
                "stageLabel": stage_label(item_order),
                "stageOrder": item_order,
                "expectedHpa": _expected_hpa(state, lot, stage_code(item_order)),
            }
            for item_order in range(1, 27)
        ]
        return {
            "injectionLotId": lot_id,
            "batchCode": batch.get("batchCode"),
            "lotNo": lot.get("lotNo"),
            "stage": {"code": code, "label": stage_label(order), "stageOrder": order},
            "activatedAt": lot["activatedAt"],
            "expectedHpa": expected,
            "stages": stages,
            "dueAt": (activated + timedelta(hours=expected)).isoformat().replace("+00:00", "Z"),
            "totalEmbryos": len(all_embryos),
            "embryosRemaining": len(embryos),
            "embryos": embryos,
        }

    @router.post("/observations/embryo")
    async def create_observations(request: Request, body: dict[str, Any]):
        body = normalize(body)

        def operation(state: State):
            raw = body.get("observations")
            if not isinstance(raw, list) or len(raw) not in range(1, 201):
                raise APIError(422, "validation_error", "observations ต้องมี 1 ถึง 200 รายการ")
            results = []
            touched = set()
            for item in raw:
                if not isinstance(item, dict):
                    results.append({"status": "rejected", "error": {"message": "รูปแบบ observation ไม่ถูกต้อง"}})
                    continue
                client_id = str(item.get("clientUuid") or "")
                existing = next(
                    (value for value in state.observations.values() if value.get("clientUuid") == client_id), None
                )
                if not existing:
                    existing = next(
                        (
                            value
                            for value in state.observations.values()
                            if value.get("deletedAt") is None
                            and value.get("embryoId") == item.get("embryoId")
                            and value.get("stageCode") == item.get("stageCode")
                        ),
                        None,
                    )
                if existing:
                    existing_deviation = float(existing["deviationH"])
                    results.append(
                        {
                            "clientUuid": client_id,
                            "id": existing["id"],
                            "status": "duplicate",
                            "hpaActual": existing["hpaActual"],
                            "hpaExpected": existing["hpaExpectedSnapshot"],
                            "deviationH": existing["deviationH"],
                            "deviationLabel": deviation_label(existing_deviation),
                            "deviationLabelEn": deviation_label(existing_deviation, "en"),
                            "deviationPct": round4(existing_deviation / float(existing["hpaExpectedSnapshot"]) * 100)
                            if existing["hpaExpectedSnapshot"]
                            else None,
                            "isBackdated": bool(existing.get("isBackdated")),
                            "exitRecorded": existing.get("outcome") in {"DEAD", "DEGENERATED"},
                        }
                    )
                    continue
                if message := _validate_observation(state, item):
                    results.append({"clientUuid": client_id, "status": "rejected", "error": {"message": message}})
                    continue
                embryo = state.entities["embryos"][str(item["embryoId"])]
                lot = state.entities["injection-lots"][str(embryo["injectionLotId"])]
                observed_at = parse_datetime(str(item["observedAt"]))
                actual = round4((observed_at - parse_datetime(str(lot["activatedAt"]))).total_seconds() / 3600)
                expected = round4(_expected_hpa(state, lot, str(item["stageCode"])))
                deviation = round4(actual - expected)
                observation_id, now = uuid7(), utc_now()
                backdated = is_backdated(observed_at, now)
                observation = {
                    **item,
                    "id": observation_id,
                    "injectionLotId": lot["id"],
                    "hpaActual": actual,
                    "hpaExpectedSnapshot": expected,
                    "deviationH": deviation,
                    "operatorId": request.headers.get("X-Operator-Id"),
                    "deviceId": request.headers.get("X-Device-Id"),
                    "isBackdated": backdated,
                    "createdAt": now.isoformat().replace("+00:00", "Z"),
                }
                interval = _interval_metrics(
                    state, str(embryo["id"]), stage_number(str(item["stageCode"])), actual, expected
                )
                result = {
                    "clientUuid": client_id,
                    "id": observation_id,
                    "status": "created",
                    "hpaActual": actual,
                    "hpaExpected": expected,
                    "deviationH": deviation,
                    "deviationLabel": deviation_label(deviation),
                    "deviationLabelEn": deviation_label(deviation, "en"),
                    "deviationPct": round4(deviation / expected * 100) if expected else None,
                    "isBackdated": backdated,
                    "exitRecorded": item["outcome"] in {"DEAD", "DEGENERATED"},
                }
                if interval:
                    (
                        observation["intervalActual"],
                        observation["intervalExpected"],
                        observation["intervalDeviationH"],
                    ) = interval
                    result["intervalActual"], result["intervalExpected"], result["intervalDeviationH"] = interval
                state.observations[observation_id] = observation
                audit(state, request, "INSERT", "embryo_observation", observation_id, None, observation)
                touched.add(str(embryo["id"]))
                results.append(result)
            for embryo_id in touched:
                old = copy.deepcopy(state.entities["embryos"][embryo_id])
                _recompute_embryo(state, embryo_id)
                if old != state.entities["embryos"][embryo_id]:
                    audit(state, request, "UPDATE", "embryo", embryo_id, old, state.entities["embryos"][embryo_id])
            return 200, {"results": results}

        return store.execute_mutation(request, body, operation)

    def change_observation(observation_id: str, request: Request, body: dict[str, Any] | None, reason: str = ""):
        payload = normalize(body or {})

        def operation(state: State):
            observation = state.observations.get(observation_id)
            if not observation or observation.get("deletedAt") is not None:
                raise APIError(404, "not_found", "ไม่พบ observation")
            old = copy.deepcopy(observation)
            if request.method == "DELETE":
                if not reason.strip():
                    raise APIError(422, "validation_error", "reason is required")
                observation.update({"deletedAt": iso_now(), "overrideReason": reason.strip(), "updatedAt": iso_now()})
                status, result = 204, b""
                action = "DELETE"
            else:
                correction = str(payload.get("correctionReason") or payload.get("overrideReason") or "").strip()
                if not correction:
                    raise APIError(422, "validation_error", "ต้องระบุ correctionReason")
                allowed = {"observedAt", "outcome", "condition", "notes"}
                candidate = {**observation, **{key: value for key, value in payload.items() if key in allowed}}
                candidate["overrideReason"] = correction
                if message := _validate_observation(state, candidate):
                    raise APIError(422, "validation_error", message)
                lot = state.entities["injection-lots"][str(candidate["injectionLotId"])]
                observed_at = parse_datetime(str(candidate["observedAt"]))
                actual = round4((observed_at - parse_datetime(str(lot["activatedAt"]))).total_seconds() / 3600)
                expected = float(candidate["hpaExpectedSnapshot"])
                candidate.update(
                    {
                        "hpaActual": actual,
                        "hpaExpectedSnapshot": expected,
                        "deviationH": round4(actual - expected),
                        "isBackdated": is_backdated(observed_at, utc_now()),
                        "updatedAt": iso_now(),
                    }
                )
                interval = _interval_metrics(
                    state,
                    str(candidate["embryoId"]),
                    stage_number(str(candidate["stageCode"])),
                    actual,
                    expected,
                    observation_id,
                )
                for field in ("intervalActual", "intervalExpected", "intervalDeviationH"):
                    candidate.pop(field, None)
                if interval:
                    candidate["intervalActual"], candidate["intervalExpected"], candidate["intervalDeviationH"] = (
                        interval
                    )
                state.observations[observation_id] = observation = candidate
                status, result, action = 200, observation, "UPDATE"
            embryo_id = str(observation["embryoId"])
            old_embryo = copy.deepcopy(state.entities["embryos"].get(embryo_id, {}))
            _recompute_embryo(state, embryo_id)
            if old_embryo != state.entities["embryos"].get(embryo_id):
                audit(state, request, "UPDATE", "embryo", embryo_id, old_embryo, state.entities["embryos"][embryo_id])
            audit(state, request, action, "embryo_observation", observation_id, old, observation)
            return status, result

        return store.execute_mutation(request, payload, operation)

    @router.patch("/observations/embryo/{id}")
    async def update_observation(id: str, request: Request, body: dict[str, Any]):
        return change_observation(id, request, body)

    @router.delete("/observations/embryo/{id}")
    async def delete_observation(id: str, request: Request, reason: str = Query("")):
        return change_observation(id, request, None, reason)

    return router

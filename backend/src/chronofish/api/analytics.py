from __future__ import annotations

import statistics
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Annotated, Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Query, Request

from ..core import MemoryStore, State, parse_datetime, utc_now
from ..domain.rules import age_days_on, round4, stage_code, stage_label, stage_number
from .fish import _enrich_fish
from .observations import _expected_hpa

BANGKOK = ZoneInfo("Asia/Bangkok")


def _matches_batch(batch: dict[str, Any], query: dict[str, str]) -> bool:
    mappings = {"batchId": "id", "siteId": "siteId", "operatorId": "operatorId", "treatmentGroupId": "treatmentGroupId"}
    if any(query.get(key) and query[key] != str(batch.get(field, "")) for key, field in mappings.items()):
        return False
    return not (
        query.get("dateFrom")
        and str(batch.get("experimentDate", "")) < query["dateFrom"]
        or query.get("dateTo")
        and str(batch.get("experimentDate", "")) > query["dateTo"]
    )


def filtered_batches(state: State, query: dict[str, str]) -> dict[str, dict[str, Any]]:
    return {
        item_id: item
        for item_id, item in state.entities["batches"].items()
        if item.get("active") is not False and item.get("deletedAt") is None and _matches_batch(item, query)
    }


def filtered_embryos(state: State, query: dict[str, str]) -> list[dict[str, Any]]:
    batches = filtered_batches(state, query)
    result = []
    for embryo in state.entities["embryos"].values():
        if embryo.get("active") is False or embryo.get("deletedAt") is not None:
            continue
        lot = state.entities["injection-lots"].get(str(embryo.get("injectionLotId")))
        if (
            not lot
            or lot.get("active") is False
            or lot.get("deletedAt") is not None
            or lot.get("batchId") not in batches
        ):
            continue
        donor = state.entities["donor-cell-lines"].get(str(lot.get("donorCellLineId")), {})
        if query.get("donorCellLineId") and lot.get("donorCellLineId") != query["donorCellLineId"]:
            continue
        if query.get("strain") and str(donor.get("strain", "")).casefold() != query["strain"].casefold():
            continue
        result.append(embryo)
    return result


def filtered_fish(state: State, query: dict[str, str]) -> dict[str, dict[str, Any]]:
    batches = filtered_batches(state, query)
    result = {}
    for fish_id, fish in state.entities["fish"].items():
        if fish.get("active") is False or fish.get("deletedAt") is not None:
            continue
        enriched = _enrich_fish(state, fish)
        simple = {
            "status": "status",
            "siteId": "siteId",
            "boxId": "fishBoxId",
            "condition": "condition",
            "donorCellLineId": "donorCellLineId",
        }
        if any(
            query.get(key) and str(enriched.get(field, "")).casefold() != query[key].casefold()
            for key, field in simple.items()
        ):
            continue
        if query.get("dobFrom") and str(fish.get("dob", "")) < query["dobFrom"]:
            continue
        if query.get("dobTo") and str(fish.get("dob", "")) > query["dobTo"]:
            continue
        if query.get("strain") and str(enriched.get("strain", "")).casefold() != query["strain"].casefold():
            continue
        embryo = state.entities["embryos"].get(str(fish.get("embryoId")))
        if embryo:
            lot = state.entities["injection-lots"].get(str(embryo.get("injectionLotId")))
            if not lot or lot.get("batchId") not in batches:
                continue
        elif any(query.get(key) for key in ("batchId", "siteId", "operatorId", "treatmentGroupId")):
            continue
        result[fish_id] = enriched
    return result


def observation_index(state: State) -> dict[str, list[dict[str, Any]]]:
    result: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in state.observations.values():
        if item.get("deletedAt") is None:
            result[str(item.get("embryoId"))].append(item)
    return result


def checkpoint_status(embryo: dict[str, Any], stage: int, observations: dict[str, list[dict[str, Any]]]) -> str:
    values = observations.get(str(embryo["id"]), [])
    direct = next((item for item in values if stage_number(str(item.get("stageCode", ""))) == stage), None)
    if direct:
        if direct.get("outcome") == "ALIVE":
            return "alive"
        if direct.get("outcome") in {"DEAD", "DEGENERATED"}:
            return "dead"
        return "blank"
    if embryo.get("exitReason") == "PROMOTED" and stage <= 26:
        return "alive"
    exit_stage = stage_number(str(embryo.get("exitStageCode", "")))
    if exit_stage:
        return "alive" if stage < exit_stage else "dead"
    highest_alive = max(
        (stage_number(str(item.get("stageCode", ""))) for item in values if item.get("outcome") == "ALIVE"), default=0
    )
    return "alive" if stage <= highest_alive else "blank"


def stage_survival(state: State, embryos: list[dict[str, Any]]) -> list[dict[str, Any]]:
    observations = observation_index(state)
    result, previous_alive, survival = [], 0, 1.0
    now = utc_now()
    for order in range(1, 27):
        risk = alive = 0
        for embryo in embryos:
            lot = state.entities["injection-lots"].get(str(embryo.get("injectionLotId")), {})
            if not lot.get("activatedAt"):
                continue
            due = parse_datetime(str(lot["activatedAt"])) + timedelta(
                hours=_expected_hpa(state, lot, stage_code(order))
            )
            if due > now:
                continue
            risk += 1
            alive += checkpoint_status(embryo, order, observations) == "alive"
        n_previous = alive if order == 1 else previous_alive
        if order > 1 and n_previous:
            survival *= alive / n_previous
        first_alive = int(result[0]["alive"]) if result else alive
        result.append(
            {
                "stageOrder": order,
                "stageCode": stage_code(order),
                "stageLabel": stage_label(order),
                "riskSet": risk,
                "alive": alive,
                "nPrev": n_previous,
                "nDead": max(n_previous - alive, 0),
                "surv": survival,
                "pctOfDevelopment": alive * 100 / first_alive if first_alive else 0,
            }
        )
        previous_alive = alive
    return result


def reached_count(state: State, embryos: list[dict[str, Any]], order: int) -> int:
    observations = observation_index(state)
    return sum(
        embryo.get("exitReason") == "PROMOTED" or checkpoint_status(embryo, order, observations) == "alive"
        for embryo in embryos
    )


def control_comparison(
    state: State, embryos: list[dict[str, Any]], batches: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    observations = observation_index(state)
    rows = []
    for order in (19, 22):
        direct = [
            next(
                (
                    item
                    for item in observations.get(str(embryo["id"]), [])
                    if stage_number(str(item["stageCode"])) == order
                ),
                None,
            )
            for embryo in embryos
        ]
        normal = sum(item is not None and item.get("condition") == "NORMAL" for item in direct)
        abnormal = sum(item is not None and item.get("condition") == "ABNORMAL" for item in direct)
        rows.append(_control_row("SCNT", order, normal, abnormal))
    for item in state.entities["control-arm-counts"].values():
        if item.get("deletedAt") is None and item.get("batchId") in batches:
            rows.append(
                _control_row(
                    str(item["armType"]),
                    stage_number(str(item["stageCode"])),
                    int(item["nNormal"]),
                    int(item["nAbnormal"]),
                )
            )
    return sorted(rows, key=lambda item: (item["stageOrder"], item["armType"]))


def _control_row(arm: str, order: int, normal: int, abnormal: int) -> dict[str, Any]:
    total = normal + abnormal
    return {
        "armType": arm,
        "stageOrder": order,
        "stageCode": stage_code(order),
        "stageLabel": stage_label(order),
        "nNormal": normal,
        "nAbnormal": abnormal,
        "n": total,
        "pctNormal": normal / total if total else 0,
        "pctAbnormal": abnormal / total if total else 0,
    }


def query_dict(request: Request) -> dict[str, str]:
    return {key: value for key, value in request.query_params.items() if value}


def build_analytics_router(store: MemoryStore) -> APIRouter:
    router = APIRouter(prefix="/api/v1/analytics")

    @router.get("/kpi")
    def kpi(request: Request) -> dict[str, Any]:
        state, query = store.snapshot(), query_dict(request)
        embryos = filtered_embryos(state, query)
        batches = filtered_batches(state, query)
        fish = filtered_fish(state, query)
        latest = [
            max(
                observation_index(state).get(str(item["id"]), []),
                key=lambda row: str(row.get("observedAt", "")),
                default=None,
            )
            for item in embryos
        ]
        normal = sum(item is not None and item.get("condition") == "NORMAL" for item in latest)
        abnormal = sum(item is not None and item.get("condition") == "ABNORMAL" for item in latest)
        lots = {
            str(item["injectionLotId"]): state.entities["injection-lots"].get(str(item["injectionLotId"]), {})
            for item in embryos
        }
        activated = sum(int(item.get("nActivated", 0)) for item in lots.values()) or len(embryos)
        alive_ages = [int(item.get("ageDays", 0)) for item in fish.values() if item.get("status") == "ALIVE"]
        conditions = {
            name: sum(item.get("condition") == name for item in fish.values()) for name in ("NORMAL", "ABNORMAL")
        }
        undetermined = len(fish) - sum(conditions.values())
        return {
            "stage1": {
                "nBatches": len(batches),
                "nEggs": sum(int(item.get("nEggs", 0)) for item in lots.values()),
                "nActivated": activated,
                "nReachedShield": reached_count(state, embryos, 19),
                "nReachedDay1": reached_count(state, embryos, 22),
                "nPromoted": len(fish),
                "pctNormal": normal / len(embryos) if embryos else 0,
                "pctAbnormal": abnormal / len(embryos) if embryos else 0,
                "controlComparison": control_comparison(state, embryos, batches),
            },
            "stage2": {
                "nFish": len(fish),
                "nAlive": sum(item.get("status") == "ALIVE" for item in fish.values()),
                "nDead": sum(item.get("status") == "DEAD" for item in fish.values()),
                "nFrozen": sum(item.get("status") == "FROZEN" for item in fish.values()),
                "nDiscarded": sum(item.get("status") == "DISCARDED" for item in fish.values()),
                "nNormal": conditions["NORMAL"],
                "nAbnormal": conditions["ABNORMAL"],
                "nUndetermined": undetermined,
                "meanAgeDaysAlive": statistics.mean(alive_ages) if alive_ages else None,
            },
        }

    @router.get("/funnel")
    def funnel(request: Request) -> dict[str, Any]:
        state = store.snapshot()
        embryos = filtered_embryos(state, query_dict(request))
        return {
            "items": [
                {
                    "stageOrder": point["stageOrder"],
                    "stageCode": point["stageCode"],
                    "stageLabel": point["stageLabel"],
                    "alive": point["alive"],
                    "riskSet": point["riskSet"],
                    "pctOfActivated": point["alive"] * 100 / len(embryos) if embryos else 0,
                }
                for point in stage_survival(state, embryos)
            ]
        }

    @router.get("/survival")
    def survival(
        request: Request,
        groupBy: Annotated[list[str] | None, Query()] = None,
    ) -> dict[str, Any]:
        state, query = store.snapshot(), query_dict(request)
        embryos = filtered_embryos(state, query)
        dimensions = []
        for value in groupBy or ["site,strain,treatmentGroup"]:
            dimensions.extend(item for item in value.split(",") if item in {"site", "strain", "treatmentGroup"})
        dimensions = list(dict.fromkeys(dimensions))
        groups: defaultdict[tuple[str, ...], list[dict[str, Any]]] = defaultdict(list)
        metadata = {}
        for embryo in embryos:
            lot = state.entities["injection-lots"][str(embryo["injectionLotId"])]
            batch = state.entities["batches"][str(lot["batchId"])]
            donor = state.entities["donor-cell-lines"].get(str(lot.get("donorCellLineId")), {})
            treatment = state.entities["treatment-groups"].get(str(batch.get("treatmentGroupId")), {})
            values = {
                "site": str(batch.get("siteId", "")),
                "strain": str(donor.get("strain", "")),
                "treatmentGroup": str(batch.get("treatmentGroupId", "")),
            }
            key = tuple(values[item] for item in dimensions)
            groups[key].append(embryo)
            metadata[key] = {**values, "treatmentGroupName": treatment.get("code")}
        items = []
        for key, group in groups.items():
            for point in stage_survival(state, group):
                meta = metadata[key]
                if "site" in dimensions:
                    point["siteId"] = meta["site"]
                if "strain" in dimensions:
                    point["strain"] = meta["strain"]
                if "treatmentGroup" in dimensions:
                    point["treatmentGroupId"] = meta["treatmentGroup"]
                    point["treatmentGroup"] = meta["treatmentGroupName"]
                items.append(point)
        return {"items": items}

    @router.get("/timing-deviation")
    def timing_deviation(request: Request) -> dict[str, Any]:
        state, query = store.snapshot(), query_dict(request)
        allowed = {str(item["id"]) for item in filtered_embryos(state, query)}
        groups: defaultdict[tuple[Any, ...], list[float]] = defaultdict(list)
        expected = {}
        meta = {}
        for observation in state.observations.values():
            if observation.get("deletedAt") is not None or observation.get("embryoId") not in allowed:
                continue
            embryo = state.entities["embryos"][str(observation["embryoId"])]
            lot = state.entities["injection-lots"][str(embryo["injectionLotId"])]
            batch = state.entities["batches"][str(lot["batchId"])]
            donor = state.entities["donor-cell-lines"].get(str(lot.get("donorCellLineId")), {})
            treatment = state.entities["treatment-groups"].get(str(batch.get("treatmentGroupId")), {})
            order = stage_number(str(observation["stageCode"]))
            key = (batch.get("siteId"), donor.get("strain"), treatment.get("code"), order)
            groups[key].append(float(observation.get("deviationH", 0)))
            expected[key] = float(observation.get("hpaExpectedSnapshot", 0))
            meta[key] = {
                "siteId": batch.get("siteId"),
                "strain": donor.get("strain"),
                "treatmentGroupId": treatment.get("id"),
                "treatmentGroup": treatment.get("code"),
                "stageOrder": order,
            }
        rows = []
        for key, values in groups.items():
            row = dict(meta[key])
            row.update(
                {
                    "stageLabel": stage_label(int(row["stageOrder"])),
                    "expectedHpa": expected[key],
                    "n": len(values),
                    "meanDeviationH": round4(statistics.mean(values)),
                    "medianDeviationH": round4(statistics.median(values)),
                    "sdDeviationH": round4(statistics.stdev(values)) if len(values) > 1 else None,
                    "minDeviationH": round4(min(values)),
                    "maxDeviationH": round4(max(values)),
                }
            )
            rows.append(row)
        return {"items": sorted(rows, key=lambda item: (item["stageOrder"], str(item["treatmentGroup"])))}

    @router.get("/abnormality-onset")
    def abnormality(request: Request) -> dict[str, Any]:
        state = store.snapshot()
        counts: defaultdict[int, int] = defaultdict(int)
        for embryo in filtered_embryos(state, query_dict(request)):
            if order := stage_number(str(embryo.get("firstAbnormalStageCode", ""))):
                counts[order] += 1
        return {
            "items": [
                {"stageOrder": order, "stageLabel": stage_label(order), "count": counts[order]}
                for order in sorted(counts)
            ]
        }

    @router.get("/fish-survival")
    def fish_survival(request: Request, splitByCondition: bool = False) -> dict[str, Any]:
        state, query = store.snapshot(), query_dict(request)
        fish = filtered_fish(state, query)
        groups: defaultdict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
        for item in fish.values():
            key = ("ALL", "ALL", "ALL")
            if splitByCondition:
                key = (
                    str(item.get("condition") or "UNDETERMINED"),
                    str(item.get("strain") or "ALL"),
                    str(item.get("treatmentGroupId") or "ALL"),
                )
            groups[key].append(item)
        rows = []
        today = datetime.now(BANGKOK).date()
        for (condition_name, strain_name, treatment_name), items in groups.items():
            max_age = max((age_days_on(date.fromisoformat(item["dob"]), today) for item in items), default=0)
            for age in range(max_age + 1):
                at_risk = sum(age_days_on(date.fromisoformat(item["dob"]), today) >= age for item in items)
                alive = sum(
                    age_days_on(date.fromisoformat(item["dob"]), today) >= age
                    and (
                        item.get("status") == "ALIVE"
                        or not item.get("exitDate")
                        or age_days_on(date.fromisoformat(item["dob"]), date.fromisoformat(item["exitDate"])) > age
                    )
                    for item in items
                )
                row = {
                    "ageDays": age,
                    "atRisk": at_risk,
                    "alive": alive,
                    "nAlive": sum(item.get("status") == "ALIVE" for item in items),
                    "nDead": sum(item.get("status") == "DEAD" for item in items),
                    "nFrozen": sum(item.get("status") == "FROZEN" for item in items),
                    "nDiscarded": sum(item.get("status") == "DISCARDED" for item in items),
                    "nMale": sum(item.get("sex") == "M" for item in items),
                    "nFemale": sum(item.get("sex") == "F" for item in items),
                    "nUnknownSex": sum(item.get("sex") not in {"M", "F"} for item in items),
                    "nBoxes": len({item.get("fishBoxId") for item in items if item.get("fishBoxId")}),
                    "surv": alive / at_risk if at_risk else 0,
                    "strain": strain_name,
                    "treatmentGroup": treatment_name,
                }
                if splitByCondition:
                    row["condition"] = condition_name
                rows.append(row)
        return {"items": rows}

    @router.get("/observation-gaps")
    def gaps(request: Request) -> dict[str, Any]:
        state, query = store.snapshot(), query_dict(request)
        today = datetime.now(BANGKOK).date()
        rows = []
        for fish in filtered_fish(state, query).values():
            latest = max(
                (
                    str(item["observedOn"])
                    for item in state.fish_observations.values()
                    if item.get("cloneFishId") == fish["id"] and item.get("deletedAt") is None
                ),
                default="",
            )
            missed = (today - date.fromisoformat(latest or fish["dob"])).days
            if missed > 0:
                rows.append(
                    {"fishId": fish["id"], "fishCode": fish["fishCode"], "lastObservedOn": latest, "missedDays": missed}
                )
        return {"items": rows}

    @router.get("/pipeline")
    def pipeline(request: Request) -> dict[str, Any]:
        state, query = store.snapshot(), query_dict(request)
        embryos = filtered_embryos(state, query)
        fish = filtered_fish(state, query)
        counts = [
            ("Activated", len(embryos)),
            ("Reached Shield", reached_count(state, embryos, 19)),
            ("Reached Day 1", reached_count(state, embryos, 22)),
            ("Promoted", len(fish)),
            ("Alive Fish", sum(item.get("status") == "ALIVE" for item in fish.values())),
        ]
        start, previous, rows = len(embryos), len(embryos), []
        for step, count in counts:
            rows.append(
                {
                    "step": step,
                    "count": count,
                    "pctOfStart": count / start if start else 0,
                    "pctOfPrevious": count / previous if previous else 0,
                }
            )
            previous = count
        return {"items": rows}

    return router

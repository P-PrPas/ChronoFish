from __future__ import annotations

import statistics
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Annotated, Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Query, Request

from ...domain.rules import age_days_on, round4, stage_code, stage_label, stage_number
from ...domain.state import State
from ...runtime.values import parse_datetime, utc_now
from ...services.fish import enrich_fish, fish_was_alive_on
from ...store import Store
from .observations import _expected_hpa

BANGKOK = ZoneInfo("Asia/Bangkok")
ANALYTICS_FILTER_KEYS = (
    "dateFrom",
    "dateTo",
    "siteId",
    "operatorId",
    "treatmentGroupId",
    "donorCellLineId",
    "strain",
    "batchId",
)
GROUP_DIMENSIONS = {"site", "strain", "treatmentGroup", "operator"}


def analytics_meta(
    query: dict[str, str],
    sample_size: int,
    denominators: dict[str, int] | None = None,
    unknown: dict[str, int] | None = None,
    missing: dict[str, int] | None = None,
) -> dict[str, Any]:
    return {
        "filters": {key: query[key] for key in ANALYTICS_FILTER_KEYS if query.get(key)},
        "sampleSize": sample_size,
        "denominators": denominators or {},
        "unknown": {key: value for key, value in (unknown or {}).items() if value},
        "missing": {key: value for key, value in (missing or {}).items() if value},
    }


def group_dimensions(values: list[str] | None, default: tuple[str, ...]) -> tuple[str, ...]:
    requested = values or [",".join(default)]
    dimensions = [part for value in requested for part in value.split(",") if part in GROUP_DIMENSIONS]
    return tuple(dict.fromkeys(dimensions)) or default


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
        enriched = enrich_fish(state, fish)
        embryo = state.entities["embryos"].get(str(fish.get("embryoId")))
        if embryo:
            lot = state.entities["injection-lots"].get(str(embryo.get("injectionLotId")))
            batch = state.entities["batches"].get(str((lot or {}).get("batchId")))
            if (
                not lot
                or lot.get("active") is False
                or lot.get("deletedAt") is not None
                or not batch
                or batch.get("active") is False
                or batch.get("deletedAt") is not None
                or batch.get("id") not in batches
            ):
                continue
            donor_cell_line_id = lot.get("donorCellLineId")
        elif any(query.get(key) for key in ANALYTICS_FILTER_KEYS):
            continue
        else:
            donor_cell_line_id = fish.get("donorCellLineId")
        simple = {
            "status": "status",
            "siteId": "siteId",
            "boxId": "fishBoxId",
            "condition": "condition",
        }
        if any(
            query.get(key) and str(enriched.get(field, "")).casefold() != query[key].casefold()
            for key, field in simple.items()
        ):
            continue
        if query.get("donorCellLineId") and str(donor_cell_line_id) != query["donorCellLineId"]:
            continue
        if query.get("strain") and str(enriched.get("strain", "")).casefold() != query["strain"].casefold():
            continue
        if query.get("dobFrom") and str(fish.get("dob", "")) < query["dobFrom"]:
            continue
        if query.get("dobTo") and str(fish.get("dob", "")) > query["dobTo"]:
            continue
        result[fish_id] = enriched
    return result


def observation_index(state: State) -> dict[str, list[dict[str, Any]]]:
    result: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in state.observations.values():
        if item.get("deletedAt") is None:
            result[str(item.get("embryoId"))].append(item)
    return result


def filtered_lots(state: State, batches: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {
        item_id: item
        for item_id, item in state.entities["injection-lots"].items()
        if item.get("active") is not False
        and item.get("deletedAt") is None
        and item.get("batchId") in batches
        and item.get("activatedAt")
    }


def activated_count(state: State, batches: dict[str, dict[str, Any]]) -> int:
    return sum(int(item.get("nActivated", 0)) for item in filtered_lots(state, batches).values())


def missing_stage_observations(state: State, embryos: list[dict[str, Any]]) -> int:
    observations = observation_index(state)
    missing = 0
    now = utc_now()
    for order in range(1, 27):
        for embryo in embryos:
            lot = state.entities["injection-lots"].get(str(embryo.get("injectionLotId")), {})
            if not lot.get("activatedAt"):
                continue
            due = parse_datetime(str(lot["activatedAt"])) + timedelta(
                hours=_expected_hpa(state, lot, stage_code(order))
            )
            if due <= now and checkpoint_status(embryo, order, observations) == "blank":
                missing += 1
    return missing


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
                "pctOfDevelopment": alive * 100 / first_alive if first_alive else None,
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
    return {key: value for key in ANALYTICS_FILTER_KEYS if (value := request.query_params.get(key))}


def build_analytics_router(store: Store) -> APIRouter:
    router = APIRouter(prefix="/api/v1/analytics")

    @router.get("/kpi")
    def kpi(request: Request) -> dict[str, Any]:
        state, query = store.snapshot(), query_dict(request)
        embryos = filtered_embryos(state, query)
        batches = filtered_batches(state, query)
        fish = filtered_fish(state, query)
        observations = observation_index(state)
        latest = [
            max(
                observations.get(str(item["id"]), []),
                key=lambda row: str(row.get("observedAt", "")),
                default=None,
            )
            for item in embryos
        ]
        normal = sum(item is not None and item.get("condition") == "NORMAL" for item in latest)
        abnormal = sum(item is not None and item.get("condition") == "ABNORMAL" for item in latest)
        activated = activated_count(state, batches)
        alive_ages = [int(item.get("ageDays", 0)) for item in fish.values() if item.get("status") == "ALIVE"]
        conditions = {
            name: sum(item.get("condition") == name for item in fish.values()) for name in ("NORMAL", "ABNORMAL")
        }
        undetermined = len(fish) - sum(conditions.values())
        promoted = sum(bool(item.get("embryoId")) for item in fish.values())
        return {
            "stage1": {
                "nBatches": len(batches),
                "nEggs": sum(int(item.get("nEggs", 0)) for item in filtered_lots(state, batches).values()),
                "nActivated": activated,
                "nReachedShield": reached_count(state, embryos, 19),
                "nReachedDay1": reached_count(state, embryos, 22),
                "nPromoted": promoted,
                "pctNormal": normal / len(embryos) if embryos else None,
                "pctAbnormal": abnormal / len(embryos) if embryos else None,
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
            "meta": analytics_meta(
                query,
                len(embryos) + len(fish),
                {
                    "activated": activated,
                    "stage1Condition": len(embryos),
                    "stage2Fish": len(fish),
                    "aliveFishAge": len(alive_ages),
                },
                {
                    "stage1Condition": len(embryos) - normal - abnormal,
                    "stage2Condition": undetermined,
                    "fishSex": sum(item.get("sex") not in {"M", "F"} for item in fish.values()),
                },
                {"latestEmbryoObservation": sum(item is None for item in latest)},
            ),
        }

    @router.get("/funnel")
    def funnel(request: Request) -> dict[str, Any]:
        state = store.snapshot()
        query = query_dict(request)
        batches = filtered_batches(state, query)
        embryos = filtered_embryos(state, query)
        activated = activated_count(state, batches)
        return {
            "items": [
                {
                    "stageOrder": point["stageOrder"],
                    "stageCode": point["stageCode"],
                    "stageLabel": point["stageLabel"],
                    "alive": point["alive"],
                    "riskSet": point["riskSet"],
                    "pctOfActivated": point["alive"] * 100 / activated if activated else None,
                }
                for point in stage_survival(state, embryos)
            ],
            "meta": analytics_meta(
                query,
                len(embryos),
                {"activated": activated},
                missing={"stageCheckpoint": missing_stage_observations(state, embryos)},
            ),
        }

    @router.get("/survival")
    def survival(
        request: Request,
        groupBy: Annotated[list[str] | None, Query()] = None,
    ) -> dict[str, Any]:
        state, query = store.snapshot(), query_dict(request)
        embryos = filtered_embryos(state, query)
        dimensions = group_dimensions(groupBy, ("site", "strain", "treatmentGroup"))
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
                "operator": str(batch.get("operatorId", "")),
            }
            key = tuple(values[item] for item in dimensions)
            groups[key].append(embryo)
            metadata[key] = {**values, "treatmentGroupName": treatment.get("code")}
        items = []
        for key, group in groups.items():
            for point in stage_survival(state, group):
                meta = metadata[key]
                point["siteId"] = meta["site"] if "site" in dimensions else None
                point["strain"] = meta["strain"] if "strain" in dimensions else None
                point["treatmentGroupId"] = meta["treatmentGroup"] if "treatmentGroup" in dimensions else None
                point["treatmentGroup"] = meta["treatmentGroupName"] if "treatmentGroup" in dimensions else None
                point["operatorId"] = meta["operator"] if "operator" in dimensions else None
                items.append(point)
        return {
            "items": items,
            "meta": analytics_meta(
                query,
                len(embryos),
                {"activated": activated_count(state, filtered_batches(state, query))},
                missing={"stageCheckpoint": missing_stage_observations(state, embryos)},
            ),
        }

    @router.get("/timing-deviation")
    def timing_deviation(
        request: Request,
        groupBy: Annotated[list[str] | None, Query()] = None,
    ) -> dict[str, Any]:
        state, query = store.snapshot(), query_dict(request)
        allowed = {str(item["id"]) for item in filtered_embryos(state, query)}
        dimensions = group_dimensions(groupBy, ("site", "strain", "treatmentGroup"))
        groups: defaultdict[tuple[Any, ...], list[float]] = defaultdict(list)
        expected = {}
        meta = {}
        missing_deviation = 0
        for observation in state.observations.values():
            if observation.get("deletedAt") is not None or observation.get("embryoId") not in allowed:
                continue
            embryo = state.entities["embryos"].get(str(observation["embryoId"]), {})
            lot = state.entities["injection-lots"].get(str(embryo.get("injectionLotId")), {})
            batch = state.entities["batches"].get(str(lot.get("batchId")), {})
            if not lot or not batch:
                continue
            donor = state.entities["donor-cell-lines"].get(str(lot.get("donorCellLineId")), {})
            treatment = state.entities["treatment-groups"].get(str(batch.get("treatmentGroupId")), {})
            order = stage_number(str(observation["stageCode"]))
            deviation = observation.get("deviationH")
            if deviation is None:
                missing_deviation += 1
                continue
            values = {
                "site": batch.get("siteId"),
                "strain": donor.get("strain"),
                "treatmentGroup": treatment.get("code"),
                "operator": batch.get("operatorId"),
            }
            key = (*tuple(values[item] for item in dimensions), order)
            groups[key].append(float(deviation))
            expected[key] = float(observation.get("hpaExpectedSnapshot", 0))
            meta[key] = {**values, "treatmentGroupId": treatment.get("id"), "stageOrder": order}
        rows = []
        for key, values in groups.items():
            row = dict(meta[key])
            for dimension in GROUP_DIMENSIONS - set(dimensions):
                row[dimension] = None
            row["siteId"] = row.pop("site")
            row["operatorId"] = row.pop("operator")
            row["treatmentGroupId"] = row["treatmentGroupId"] if "treatmentGroup" in dimensions else None
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
        return {
            "items": sorted(rows, key=lambda item: (item["stageOrder"], str(item.get("treatmentGroup")))),
            "meta": analytics_meta(
                query,
                sum(len(values) for values in groups.values()),
                {"observations": sum(len(values) for values in groups.values()) + missing_deviation},
                missing={"deviation": missing_deviation},
            ),
        }

    @router.get("/abnormality-onset")
    def abnormality(request: Request) -> dict[str, Any]:
        state = store.snapshot()
        query = query_dict(request)
        embryos = filtered_embryos(state, query)
        counts: defaultdict[int, int] = defaultdict(int)
        for embryo in embryos:
            if order := stage_number(str(embryo.get("firstAbnormalStageCode", ""))):
                counts[order] += 1
        return {
            "items": [
                {"stageOrder": order, "stageLabel": stage_label(order), "count": counts[order]}
                for order in sorted(counts)
            ],
            "meta": analytics_meta(
                query,
                len(embryos),
                {"embryos": len(embryos)},
                missing={"firstAbnormality": len(embryos) - sum(counts.values())},
            ),
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
                    str(item.get("treatmentGroup") or "ALL"),
                )
            groups[key].append(item)
        rows = []
        today = datetime.now(BANGKOK).date()
        for (condition_name, strain_name, treatment_name), items in groups.items():
            prepared = []
            for item in items:
                dob = date.fromisoformat(item["dob"])
                prepared.append((item, dob, max(age_days_on(dob, today), 0)))
            max_age = max((age for _item, _dob, age in prepared), default=0)
            for age in range(max_age + 1):
                at_risk = sum(item_age >= age for _item, _dob, item_age in prepared)
                alive = sum(
                    item_age >= age and fish_was_alive_on(item, dob + timedelta(days=age))
                    for item, dob, item_age in prepared
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
        return {
            "items": rows,
            "meta": analytics_meta(
                query,
                len(fish),
                {"fish": len(fish), "aliveFish": sum(item.get("status") == "ALIVE" for item in fish.values())},
                {
                    "condition": sum(item.get("condition") not in {"NORMAL", "ABNORMAL"} for item in fish.values()),
                    "sex": sum(item.get("sex") not in {"M", "F"} for item in fish.values()),
                },
            ),
        }

    @router.get("/observation-gaps")
    def gaps(request: Request) -> dict[str, Any]:
        state, query = store.snapshot(), query_dict(request)
        today = datetime.now(BANGKOK).date()
        rows = []
        alive_fish = {
            fish_id: item for fish_id, item in filtered_fish(state, query).items() if item.get("status") == "ALIVE"
        }
        missing_observation = 0
        for fish in alive_fish.values():
            latest = max(
                (
                    str(item["observedOn"])
                    for item in state.fish_observations.values()
                    if item.get("cloneFishId") == fish["id"] and item.get("deletedAt") is None
                ),
                default="",
            )
            if not latest:
                missing_observation += 1
            missed = (today - date.fromisoformat(latest or fish["dob"])).days
            if missed > 0:
                rows.append(
                    {
                        "fishId": fish["id"],
                        "fishCode": fish["fishCode"],
                        "lastObservedOn": latest or None,
                        "missedDays": missed,
                    }
                )
        return {
            "items": rows,
            "meta": analytics_meta(
                query,
                len(alive_fish),
                {"aliveFish": len(alive_fish)},
                missing={"observation": missing_observation},
            ),
        }

    @router.get("/pipeline")
    def pipeline(request: Request) -> dict[str, Any]:
        state, query = store.snapshot(), query_dict(request)
        batches = filtered_batches(state, query)
        embryos = filtered_embryos(state, query)
        fish = filtered_fish(state, query)
        promoted = sum(bool(item.get("embryoId")) for item in fish.values())
        start = activated_count(state, batches)
        counts = [
            ("Activated", start),
            ("Reached Shield", reached_count(state, embryos, 19)),
            ("Reached Day 1", reached_count(state, embryos, 22)),
            ("Promoted", promoted),
            ("Alive Fish", sum(item.get("status") == "ALIVE" for item in fish.values())),
        ]
        previous, rows = start, []
        for step, count in counts:
            rows.append(
                {
                    "step": step,
                    "count": count,
                    "pctOfStart": count / start if start else None,
                    "pctOfPrevious": count / previous if previous else None,
                }
            )
            previous = count
        return {
            "items": rows,
            "meta": analytics_meta(
                query,
                len(embryos),
                {"activated": start, "promoted": promoted, "fish": len(fish)},
            ),
        }

    return router

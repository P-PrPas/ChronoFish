from __future__ import annotations

import statistics
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from ..domain.rules import age_days_on, default_expected_hpa, round4, stage_code, stage_label, stage_number
from ..domain.state import State
from ..runtime.values import parse_datetime, utc_now
from .fish import enrich_fish

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
FISH_GROUP_DIMENSIONS = {"condition", "strain", "treatmentGroup"}
CONTROL_STAGE_ORDERS = {3, 19, 20, 22, 23, 24}
FISH_CENSOR_STATUSES = {"ALIVE", "FROZEN", "DISCARDED"}
DAY5_STAGE_ORDER = 26
FISH_STATUS_ORDER = ("ALIVE", "DEAD", "FROZEN", "DISCARDED")
FISH_AGE_BINS = ((0, 6, "0-6"), (7, 13, "7-13"), (14, 20, "14-20"), (21, 27, "21-27"), (28, None, "28+"))
ABNORMALITY_COMPARISON = {
    "field": "abnormalityGroup",
    "label": "Ever abnormal vs No abnormality recorded",
    "interpretation": "Exploratory comparison; not causal.",
}


def group_dimensions(values: list[str] | None, default: tuple[str, ...]) -> tuple[str, ...]:
    requested = values or [",".join(default)]
    dimensions = [part for value in requested for part in value.split(",") if part in GROUP_DIMENSIONS]
    return tuple(dict.fromkeys(dimensions)) or default


def fish_group_dimensions(values: list[str] | None, split_by_condition: bool) -> tuple[str, ...]:
    if values is None:
        return ("condition", "strain", "treatmentGroup") if split_by_condition else ()
    dimensions = [
        part
        for value in values
        for part in value.split(",")
        if part in FISH_GROUP_DIMENSIONS
    ]
    return tuple(dict.fromkeys(dimensions))


def _quartiles(values: list[float]) -> tuple[float, float]:
    if len(values) == 1:
        return values[0], values[0]
    first, _median, third = statistics.quantiles(values, n=4, method="inclusive")
    return first, third


def _as_date(value: Any) -> date | None:
    if value in (None, ""):
        return None
    try:
        return date.fromisoformat(str(value))
    except ValueError:
        return None


class Analytics:
    """Pure Phase 7 calculations over one consistent store snapshot."""

    def __init__(self, state: State, query: dict[str, str]) -> None:
        self.state = state
        self.query = {key: value for key, value in query.items() if key in ANALYTICS_FILTER_KEYS and value}
        self.observations = self._observation_index()
        self.checkpoints = {
            embryo_id: {stage_number(str(item.get("stageCode", ""))): item for item in items}
            for embryo_id, items in self.observations.items()
        }
        self.highest_alive = {
            embryo_id: max(
                (stage_number(str(item.get("stageCode", ""))) for item in items if item.get("outcome") == "ALIVE"),
                default=0,
            )
            for embryo_id, items in self.observations.items()
        }
        self.expected_hpa: dict[tuple[str, str], float] = {}
        self.due_at: dict[tuple[str, int], datetime] = {}
        self.missing_stage_count: int | None = None
        self.batches = self._filtered_batches()
        self.lots = self._filtered_lots()
        self.embryos = self._filtered_embryos()
        self.fish = self._filtered_fish()

    def _meta(
        self,
        sample_size: int,
        denominators: dict[str, int] | None = None,
        unknown: dict[str, int] | None = None,
        missing: dict[str, int] | None = None,
    ) -> dict[str, Any]:
        return {
            "filters": self.query,
            "sampleSize": sample_size,
            "denominators": denominators or {},
            "unknown": {key: value for key, value in (unknown or {}).items() if value},
            "missing": {key: value for key, value in (missing or {}).items() if value},
        }

    def _matches_batch(self, batch: dict[str, Any]) -> bool:
        mappings = {
            "batchId": "id",
            "siteId": "siteId",
            "operatorId": "operatorId",
            "treatmentGroupId": "treatmentGroupId",
        }
        if any(self.query.get(key) and self.query[key] != str(batch.get(field, "")) for key, field in mappings.items()):
            return False
        return not (
            self.query.get("dateFrom")
            and str(batch.get("experimentDate", "")) < self.query["dateFrom"]
            or self.query.get("dateTo")
            and str(batch.get("experimentDate", "")) > self.query["dateTo"]
        )

    def _filtered_batches(self) -> dict[str, dict[str, Any]]:
        return {
            item_id: item
            for item_id, item in self.state.entities["batches"].items()
            if item.get("active") is not False and item.get("deletedAt") is None and self._matches_batch(item)
        }

    def _filtered_lots(self) -> dict[str, dict[str, Any]]:
        return {
            item_id: item
            for item_id, item in self.state.entities["injection-lots"].items()
            if item.get("active") is not False
            and item.get("deletedAt") is None
            and item.get("batchId") in self.batches
            and item.get("activatedAt")
        }

    def _filtered_embryos(self) -> list[dict[str, Any]]:
        result = []
        for embryo in self.state.entities["embryos"].values():
            if embryo.get("active") is False or embryo.get("deletedAt") is not None:
                continue
            lot = self.lots.get(str(embryo.get("injectionLotId")))
            if not lot:
                continue
            donor = self.state.entities["donor-cell-lines"].get(str(lot.get("donorCellLineId")), {})
            if self.query.get("donorCellLineId") and lot.get("donorCellLineId") != self.query["donorCellLineId"]:
                continue
            if self.query.get("strain") and str(donor.get("strain", "")).casefold() != self.query["strain"].casefold():
                continue
            result.append(embryo)
        return result

    def _filtered_fish(self) -> dict[str, dict[str, Any]]:
        result = {}
        for fish_id, fish in self.state.entities["fish"].items():
            if fish.get("active") is False or fish.get("deletedAt") is not None:
                continue
            enriched = enrich_fish(self.state, fish)
            embryo = self.state.entities["embryos"].get(str(fish.get("embryoId")))
            if embryo:
                lot = self.lots.get(str(embryo.get("injectionLotId")))
                if not lot:
                    continue
                donor_cell_line_id = lot.get("donorCellLineId")
            elif any(
                self.query.get(key) for key in ("dateFrom", "dateTo", "operatorId", "treatmentGroupId", "batchId")
            ):
                continue
            else:
                donor_cell_line_id = fish.get("donorCellLineId")
            if self.query.get("siteId") and str(enriched.get("siteId", "")) != self.query["siteId"]:
                continue
            if self.query.get("donorCellLineId") and str(donor_cell_line_id) != self.query["donorCellLineId"]:
                continue
            if (
                self.query.get("strain")
                and str(enriched.get("strain", "")).casefold() != self.query["strain"].casefold()
            ):
                continue
            result[fish_id] = enriched
        return result

    def _observation_index(self) -> dict[str, list[dict[str, Any]]]:
        result: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
        for item in self.state.observations.values():
            if item.get("deletedAt") is None:
                result[str(item.get("embryoId"))].append(item)
        return result

    def _embryo_abnormality(self, embryo: dict[str, Any]) -> tuple[int | None, bool, bool]:
        values = self.observations.get(str(embryo["id"]), [])
        observed_orders = [
            stage_number(str(item.get("stageCode", "")))
            for item in values
            if item.get("condition") == "ABNORMAL"
        ]
        marker = stage_number(str(embryo.get("firstAbnormalStageCode", "")))
        first_order = marker or min(observed_orders, default=0)
        return first_order or None, bool(first_order), bool(values)

    def _promoted_fish(self) -> list[dict[str, Any]]:
        return [
            item
            for item in self.fish.values()
            if item.get("embryoId")
            and self.state.entities["embryos"].get(str(item.get("embryoId")), {}).get("exitReason") == "PROMOTED"
        ]

    def _fish_abnormality_group(self, fish: dict[str, Any]) -> str:
        values = self.state.fish_observations.values()
        observations = [
            item
            for item in values
            if item.get("cloneFishId") == fish.get("id") and item.get("deletedAt") is None
        ]
        ever_abnormal = bool(
            fish.get("firstAbnormalOn")
            or fish.get("firstAbnormalAgeDays") is not None
            or fish.get("firstAbnormalStageCode")
            or fish.get("condition") == "ABNORMAL"
            or any(item.get("condition") == "ABNORMAL" for item in observations)
        )
        if ever_abnormal:
            return "EVER_ABNORMAL"
        if fish.get("condition") == "NORMAL" and observations:
            return "NO_ABNORMALITY_RECORDED"
        return "UNKNOWN"

    def _checkpoint_status(self, embryo: dict[str, Any], order: int) -> str:
        embryo_id = str(embryo["id"])
        direct = self.checkpoints.get(embryo_id, {}).get(order)
        if direct:
            if direct.get("outcome") == "ALIVE":
                return "alive"
            if direct.get("outcome") in {"DEAD", "DEGENERATED"}:
                return "dead"
            return "blank"
        if embryo.get("exitReason") == "PROMOTED" and order <= 26:
            return "alive"
        exit_stage = stage_number(str(embryo.get("exitStageCode", "")))
        if exit_stage:
            return "alive" if order < exit_stage else "dead"
        return "alive" if order <= self.highest_alive.get(embryo_id, 0) else "blank"

    def _expected_hpa(self, lot: dict[str, Any], code: str) -> float:
        key = (str(lot.get("id")), code)
        if key in self.expected_hpa:
            return self.expected_hpa[key]
        batch = self.state.entities["batches"].get(str(lot.get("batchId")), {})
        profile = self.state.entities["timing-profiles"].get(str(batch.get("timingProfileId")), {})
        entry = next((item for item in (profile or {}).get("entries", []) if item.get("stageCode") == code), None)
        self.expected_hpa[key] = float(entry.get("expectedHpa", 0)) if entry else default_expected_hpa(code)
        return self.expected_hpa[key]

    def _due_at(self, lot: dict[str, Any], order: int) -> datetime:
        key = (str(lot.get("id")), order)
        if key not in self.due_at:
            self.due_at[key] = parse_datetime(str(lot["activatedAt"])) + timedelta(
                hours=self._expected_hpa(lot, stage_code(order))
            )
        return self.due_at[key]

    def _stage_survival(self, embryos: list[dict[str, Any]]) -> list[dict[str, Any]]:
        result, previous_alive, survival = [], 0, 1.0
        now = utc_now()
        for order in range(1, 27):
            risk = alive = 0
            for embryo in embryos:
                lot = self.state.entities["injection-lots"].get(str(embryo.get("injectionLotId")), {})
                if not lot.get("activatedAt"):
                    continue
                if self._due_at(lot, order) > now:
                    continue
                risk += 1
                alive += self._checkpoint_status(embryo, order) == "alive"
            n_previous = alive if order == 1 else previous_alive
            if order > 1 and n_previous:
                # Keep the plotted estimate monotonic even when raw checkpoint
                # counts rise after an observation gap or an explicit correction.
                survival = min(survival, survival * min(1.0, alive / n_previous))
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

    def _missing_stage_observations(self) -> int:
        if self.missing_stage_count is not None:
            return self.missing_stage_count
        missing = 0
        now = utc_now()
        for order in range(1, 27):
            for embryo in self.embryos:
                lot = self.state.entities["injection-lots"].get(str(embryo.get("injectionLotId")), {})
                if not lot.get("activatedAt"):
                    continue
                if self._due_at(lot, order) <= now and self._checkpoint_status(embryo, order) == "blank":
                    missing += 1
        self.missing_stage_count = missing
        return missing

    def _activated_count(self) -> int:
        return sum(int(item.get("nActivated") or 0) for item in self.lots.values())

    def _reached_count(self, order: int) -> int:
        return sum(
            embryo.get("exitReason") == "PROMOTED" or self._checkpoint_status(embryo, order) == "alive"
            for embryo in self.embryos
        )

    @staticmethod
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
            "pctNormal": normal / total if total else None,
            "pctAbnormal": abnormal / total if total else None,
        }

    def _control_comparison(self) -> list[dict[str, Any]]:
        controls = [
            item
            for item in self.state.entities["control-arm-counts"].values()
            if item.get("deletedAt") is None and item.get("batchId") in self.batches
        ]
        orders = CONTROL_STAGE_ORDERS | {stage_number(str(item["stageCode"])) for item in controls}
        rows = []
        for order in sorted(orders):
            direct = [
                next(
                    (
                        item
                        for item in self.observations.get(str(embryo["id"]), [])
                        if stage_number(str(item["stageCode"])) == order
                    ),
                    None,
                )
                for embryo in self.embryos
            ]
            normal = sum(item is not None and item.get("condition") == "NORMAL" for item in direct)
            abnormal = sum(item is not None and item.get("condition") == "ABNORMAL" for item in direct)
            rows.append(self._control_row("SCNT", order, normal, abnormal))
        control_counts: defaultdict[tuple[str, int], list[int]] = defaultdict(lambda: [0, 0])
        for item in controls:
            counts = control_counts[(str(item["armType"]), stage_number(str(item["stageCode"])))]
            counts[0] += int(item["nNormal"])
            counts[1] += int(item["nAbnormal"])
        rows.extend(
            self._control_row(arm, order, counts[0], counts[1]) for (arm, order), counts in control_counts.items()
        )
        return sorted(rows, key=lambda item: (item["stageOrder"], item["armType"]))

    def kpi(self) -> dict[str, Any]:
        latest = [
            max(
                self.observations.get(str(item["id"]), []), key=lambda row: str(row.get("observedAt", "")), default=None
            )
            for item in self.embryos
        ]
        abnormality_states = [self._embryo_abnormality(item) for item in self.embryos]
        ever_abnormal = sum(item[1] for item in abnormality_states)
        no_abnormality_recorded = sum(item[2] and not item[1] for item in abnormality_states)
        missing_abnormality = len(self.embryos) - ever_abnormal - no_abnormality_recorded
        normal = sum(item is not None and item.get("condition") == "NORMAL" for item in latest)
        abnormal = sum(item is not None and item.get("condition") == "ABNORMAL" for item in latest)
        activated = self._activated_count()
        alive_ages = [int(item.get("ageDays") or 0) for item in self.fish.values() if item.get("status") == "ALIVE"]
        conditions = {
            name: sum(item.get("condition") == name for item in self.fish.values()) for name in ("NORMAL", "ABNORMAL")
        }
        undetermined = len(self.fish) - sum(conditions.values())
        promoted = len(self._promoted_fish())
        missing_eggs = sum(item.get("nEggs") is None for item in self.lots.values())
        return {
            "stage1": {
                "nBatches": len(self.batches),
                "nEggs": sum(int(item.get("nEggs") or 0) for item in self.lots.values()),
                "nActivated": activated,
                "nReachedShield": self._reached_count(19),
                "nReachedDay1": self._reached_count(22),
                "nPromoted": promoted,
                "pctNormal": normal / len(self.embryos) if self.embryos else None,
                "pctAbnormal": abnormal / len(self.embryos) if self.embryos else None,
                "abnormalityComparison": {
                    **ABNORMALITY_COMPARISON,
                    "everAbnormal": ever_abnormal,
                    "noAbnormalityRecorded": no_abnormality_recorded,
                    "unknown": missing_abnormality,
                },
                "controlComparison": self._control_comparison(),
            },
            "stage2": {
                "nFish": len(self.fish),
                "nAlive": sum(item.get("status") == "ALIVE" for item in self.fish.values()),
                "nDead": sum(item.get("status") == "DEAD" for item in self.fish.values()),
                "nFrozen": sum(item.get("status") == "FROZEN" for item in self.fish.values()),
                "nDiscarded": sum(item.get("status") == "DISCARDED" for item in self.fish.values()),
                "nNormal": conditions["NORMAL"],
                "nAbnormal": conditions["ABNORMAL"],
                "nUndetermined": undetermined,
                "meanAgeDaysAlive": statistics.mean(alive_ages) if alive_ages else None,
            },
            "meta": self._meta(
                len(self.embryos) + len(self.fish),
                {
                    "activated": activated,
                    "stage1Condition": len(self.embryos),
                    "stage1EverAbnormal": ever_abnormal,
                    "stage1NoAbnormalityRecorded": no_abnormality_recorded,
                    "stage2Fish": len(self.fish),
                    "stage2PromotedFish": promoted,
                    "stage2ManualFish": len(self.fish) - promoted,
                    "aliveFishAge": len(alive_ages),
                },
                {
                    "stage1Condition": len(self.embryos) - normal - abnormal,
                    "stage1AbnormalityStatus": missing_abnormality,
                    "stage2Condition": undetermined,
                    "fishSex": sum(item.get("sex") not in {"M", "F"} for item in self.fish.values()),
                },
                {"latestEmbryoObservation": sum(item is None for item in latest), "nEggs": missing_eggs},
            ),
        }

    def funnel(self) -> dict[str, Any]:
        activated = self._activated_count()
        return {
            "items": [
                {
                    "stageOrder": point["stageOrder"],
                    "stageCode": point["stageCode"],
                    "stageLabel": point["stageLabel"],
                    "alive": point["alive"],
                    "riskSet": point["riskSet"],
                    "nDead": point["nDead"],
                    "pctOfActivated": point["alive"] * 100 / activated if activated else None,
                }
                for point in self._stage_survival(self.embryos)
            ],
            "meta": self._meta(
                len(self.embryos),
                {"activated": activated},
                missing={"stageCheckpoint": self._missing_stage_observations()},
            ),
        }

    def survival(self, group_by: list[str] | None = None) -> dict[str, Any]:
        dimensions = group_dimensions(group_by, ("site", "strain", "treatmentGroup"))
        groups: defaultdict[tuple[str, ...], list[dict[str, Any]]] = defaultdict(list)
        metadata = {}
        for embryo in self.embryos:
            lot = self.lots[str(embryo["injectionLotId"])]
            batch = self.batches[str(lot["batchId"])]
            donor = self.state.entities["donor-cell-lines"].get(str(lot.get("donorCellLineId")), {})
            treatment = self.state.entities["treatment-groups"].get(str(batch.get("treatmentGroupId")), {})
            site = self.state.entities["sites"].get(str(batch.get("siteId")), {})
            values = {
                "site": str(batch.get("siteId", "")),
                "strain": str(donor.get("strain", "")),
                "treatmentGroup": str(batch.get("treatmentGroupId", "")),
                "operator": str(batch.get("operatorId", "")),
            }
            key = tuple(values[item] for item in dimensions)
            groups[key].append(embryo)
            metadata[key] = {**values, "siteCode": site.get("code"), "treatmentGroupName": treatment.get("code")}
        items = []
        for key, group in groups.items():
            for point in self._stage_survival(group):
                meta = metadata[key]
                point.update(
                    {
                        "siteId": meta["site"] if "site" in dimensions else None,
                        "site": meta["siteCode"] if "site" in dimensions else None,
                        "strain": meta["strain"] if "strain" in dimensions else None,
                        "treatmentGroupId": meta["treatmentGroup"] if "treatmentGroup" in dimensions else None,
                        "treatmentGroup": meta["treatmentGroupName"] if "treatmentGroup" in dimensions else None,
                        "operatorId": meta["operator"] if "operator" in dimensions else None,
                    }
                )
                items.append(point)
        return {
            "items": items,
            "meta": self._meta(
                len(self.embryos),
                {"activated": self._activated_count()},
                missing={"stageCheckpoint": self._missing_stage_observations()},
            ),
        }

    def timing_deviation(self, group_by: list[str] | None = None) -> dict[str, Any]:
        allowed = {str(item["id"]) for item in self.embryos}
        dimensions = group_dimensions(group_by, ("site", "strain", "treatmentGroup"))
        groups: defaultdict[tuple[Any, ...], list[float]] = defaultdict(list)
        expected, meta = {}, {}
        missing_deviation = 0
        for observation in self.state.observations.values():
            if observation.get("deletedAt") is not None or observation.get("embryoId") not in allowed:
                continue
            embryo = self.state.entities["embryos"].get(str(observation["embryoId"]), {})
            lot = self.lots.get(str(embryo.get("injectionLotId")), {})
            batch = self.batches.get(str(lot.get("batchId")), {})
            if not lot or not batch:
                continue
            donor = self.state.entities["donor-cell-lines"].get(str(lot.get("donorCellLineId")), {})
            treatment = self.state.entities["treatment-groups"].get(str(batch.get("treatmentGroupId")), {})
            order, deviation = stage_number(str(observation["stageCode"])), observation.get("deviationH")
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
            expected[key] = float(observation.get("hpaExpectedSnapshot") or 0)
            meta[key] = {**values, "treatmentGroupId": treatment.get("id"), "stageOrder": order}
        rows = []
        for key, values in groups.items():
            row = dict(meta[key])
            for dimension in GROUP_DIMENSIONS - set(dimensions):
                row[dimension] = None
            row["siteId"], row["operatorId"] = row.pop("site"), row.pop("operator")
            row["treatmentGroupId"] = row["treatmentGroupId"] if "treatmentGroup" in dimensions else None
            q1, q3 = _quartiles(values)
            row.update(
                {
                    "stageLabel": stage_label(int(row["stageOrder"])),
                    "expectedHpa": expected[key],
                    "n": len(values),
                    "meanDeviationH": round4(statistics.mean(values)),
                    "medianDeviationH": round4(statistics.median(values)),
                    "q1DeviationH": round4(q1),
                    "q3DeviationH": round4(q3),
                    "sdDeviationH": round4(statistics.stdev(values)) if len(values) > 1 else None,
                    "minDeviationH": round4(min(values)),
                    "maxDeviationH": round4(max(values)),
                }
            )
            rows.append(row)
        return {
            "items": sorted(rows, key=lambda item: (item["stageOrder"], str(item.get("treatmentGroup")))),
            "meta": self._meta(
                sum(len(values) for values in groups.values()),
                {"observations": sum(len(values) for values in groups.values()) + missing_deviation},
                missing={"deviation": missing_deviation},
            ),
        }

    def abnormality_onset(self) -> dict[str, Any]:
        counts: defaultdict[int, int] = defaultdict(int)
        states = [self._embryo_abnormality(embryo) for embryo in self.embryos]
        for state in states:
            order = state[0]
            if order:
                counts[order] += 1
        ever_abnormal = sum(item[1] for item in states)
        no_abnormality_recorded = sum(item[2] and not item[1] for item in states)
        missing_abnormality = len(self.embryos) - ever_abnormal - no_abnormality_recorded
        meta = self._meta(
            len(self.embryos),
            {
                "embryos": len(self.embryos),
                "everAbnormal": ever_abnormal,
                "noAbnormalityRecorded": no_abnormality_recorded,
            },
            missing={"firstAbnormality": missing_abnormality},
        )
        meta["comparison"] = ABNORMALITY_COMPARISON
        return {
            "items": [
                {"stageOrder": order, "stageLabel": stage_label(order), "count": counts[order]}
                for order in sorted(counts)
            ],
            "meta": meta,
        }

    def fish_survival(
        self,
        split_by_condition: bool = False,
        group_by: list[str] | None = None,
    ) -> dict[str, Any]:
        dimensions = fish_group_dimensions(group_by, split_by_condition)
        groups: defaultdict[tuple[str, ...], list[dict[str, Any]]] = defaultdict(list)
        today = datetime.now(BANGKOK).date()
        missing_exit_date = 0
        prepared_by_group: defaultdict[tuple[str, ...], list[dict[str, Any]]] = defaultdict(list)
        prepared_all: list[dict[str, Any]] = []
        for item in self.fish.values():
            status = str(item.get("status") or "")
            observations = [
                observation
                for observation in self.state.fish_observations.values()
                if observation.get("cloneFishId") == item.get("id") and observation.get("deletedAt") is None
            ]
            follow_ups = [
                observed
                for observation in observations
                if (observed := _as_date(observation.get("observedOn"))) is not None
            ]
            latest_follow_up = max(follow_ups, default=None)
            exit_date = _as_date(item.get("exitDate"))
            if status == "DEAD":
                event_observations = [
                    observed
                    for observation in observations
                    if observation.get("outcome") == "DEAD"
                    and (observed := _as_date(observation.get("observedOn"))) is not None
                ]
                end_date = exit_date or max(event_observations, default=None) or latest_follow_up or today
                is_event = True
            elif status in FISH_CENSOR_STATUSES:
                end_date = exit_date or latest_follow_up or today
                is_event = False
            else:
                end_date = latest_follow_up or today
                is_event = False
            if exit_date is None and status in {"DEAD", "FROZEN", "DISCARDED"}:
                missing_exit_date += 1
            end_date = min(end_date, today)
            dob = _as_date(item.get("dob")) or today
            end_age = max(age_days_on(dob, end_date), 0)
            values = {
                "condition": self._fish_abnormality_group(item),
                "strain": str(item.get("strain") or "ALL"),
                "treatmentGroup": str(item.get("treatmentGroup") or "ALL"),
            }
            key = tuple(values[dimension] for dimension in dimensions) or ("ALL",)
            groups[key].append(item)
            prepared = {"item": item, "endAge": end_age, "event": is_event}
            prepared_by_group[key].append(prepared)
            prepared_all.append(prepared)

        rows = []
        for key, items in groups.items():
            prepared = prepared_by_group[key]
            values = {dimension: key[index] for index, dimension in enumerate(dimensions)}
            max_age = max((item["endAge"] for item in prepared), default=0)
            survival, greenwood = 1.0, 0.0
            for age in range(max_age + 1):
                at_risk = sum(item["endAge"] >= age for item in prepared)
                events = sum(item["event"] and item["endAge"] == age for item in prepared)
                censored = sum(not item["event"] and item["endAge"] == age for item in prepared)
                if at_risk and events:
                    survival *= 1 - events / at_risk
                    if at_risk > events:
                        greenwood += events / (at_risk * (at_risk - events))
                survival = max(0.0, min(1.0, survival))
                variance = survival * survival * greenwood
                margin = 1.96 * variance**0.5
                row = {
                    "ageDays": age,
                    "atRisk": at_risk,
                    "alive": at_risk - events,
                    "nEvents": events,
                    "nCensored": censored,
                    "nAlive": sum(item.get("status") == "ALIVE" for item in items),
                    "nDead": sum(item.get("status") == "DEAD" for item in items),
                    "nFrozen": sum(item.get("status") == "FROZEN" for item in items),
                    "nDiscarded": sum(item.get("status") == "DISCARDED" for item in items),
                    "nMale": sum(item.get("sex") == "M" for item in items),
                    "nFemale": sum(item.get("sex") == "F" for item in items),
                    "nUnknownSex": sum(item.get("sex") not in {"M", "F"} for item in items),
                    "nBoxes": len({item.get("fishBoxId") for item in items if item.get("fishBoxId")}),
                    "surv": survival,
                    "survLower95": max(0.0, survival - margin),
                    "survUpper95": min(1.0, survival + margin),
                    "condition": values.get("condition"),
                    "abnormalityGroup": values.get("condition"),
                    "strain": values.get("strain", "ALL"),
                    "treatmentGroup": values.get("treatmentGroup", "ALL"),
                }
                rows.append(row)
        meta = self._meta(
            len(self.fish),
            {
                "fish": len(self.fish),
                "events": sum(item.get("status") == "DEAD" for item in self.fish.values()),
                "censored": sum(item.get("status") in FISH_CENSOR_STATUSES for item in self.fish.values()),
                "aliveFish": sum(item.get("status") == "ALIVE" for item in self.fish.values()),
            },
            {
                "condition": sum(
                    item.get("condition") not in {"NORMAL", "ABNORMAL"} for item in self.fish.values()
                ),
                "sex": sum(item.get("sex") not in {"M", "F"} for item in self.fish.values()),
            },
            {"exitDate": missing_exit_date},
        )
        meta["method"] = "Kaplan-Meier"
        meta["comparison"] = ABNORMALITY_COMPARISON
        return {
            "items": rows,
            "meta": meta,
            "supporting": self._fish_supporting(prepared_all, missing_exit_date),
        }

    def _fish_supporting(self, prepared: list[dict[str, Any]], missing_exit_date: int) -> dict[str, Any]:
        total = len(self.fish)
        status_counts = {
            status: sum(item.get("status") == status for item in self.fish.values())
            for status in FISH_STATUS_ORDER
        }
        unknown_status = total - sum(status_counts.values())
        status_rows = [
            {"status": status, "n": count, "pct": count / total if total else None}
            for status, count in status_counts.items()
        ]
        if unknown_status:
            status_rows.append(
                {"status": "UNKNOWN", "n": unknown_status, "pct": unknown_status / total if total else None}
            )

        sex_counts = {
            "M": sum(item.get("sex") == "M" for item in self.fish.values()),
            "F": sum(item.get("sex") == "F" for item in self.fish.values()),
        }
        sex_counts["UNKNOWN"] = total - sex_counts["M"] - sex_counts["F"]
        sex_rows = [
            {"sex": sex, "n": count, "pct": count / total if total else None}
            for sex, count in sex_counts.items()
        ]

        ages = [max(int(item.get("endAge", 0)), 0) for item in prepared]
        age_rows = []
        for lower, upper, label in FISH_AGE_BINS:
            count = sum(age >= lower and (upper is None or age <= upper) for age in ages)
            age_rows.append(
                {"bin": label, "minDays": lower, "maxDays": upper, "n": count, "pct": count / total if total else None}
            )

        box_counts: defaultdict[str, int] = defaultdict(int)
        box_status_counts: defaultdict[str, dict[str, int]] = defaultdict(
            lambda: {status: 0 for status in (*FISH_STATUS_ORDER, "UNKNOWN")}
        )
        for item in self.fish.values():
            box_id = str(item.get("fishBoxId") or "")
            box_counts[box_id] += 1
            status = str(item.get("status") or "UNKNOWN")
            if status not in FISH_STATUS_ORDER:
                status = "UNKNOWN"
            box_status_counts[box_id][status] += 1
        cohort_restricted = any(
            self.query.get(key)
            for key in ("batchId", "operatorId", "treatmentGroupId", "donorCellLineId", "strain", "dateFrom", "dateTo")
        )
        boxes = []
        if not cohort_restricted:
            boxes = [
                box
                for box in self.state.entities["fish-boxes"].values()
                if box.get("active") is not False
                and box.get("deletedAt") is None
                and (not self.query.get("siteId") or str(box.get("siteId")) == self.query["siteId"])
            ]
        else:
            boxes = [
                self.state.entities["fish-boxes"].get(box_id, {"id": box_id, "boxCode": box_id})
                for box_id in box_counts
                if box_id
            ]
        box_rows = [
            {
                "fishBoxId": str(box.get("id")),
                "boxCode": str(box.get("boxCode") or box.get("id")),
                "n": box_counts.get(str(box.get("id")), 0),
                "pct": box_counts.get(str(box.get("id")), 0) / total if total else None,
                "empty": box_counts.get(str(box.get("id")), 0) == 0,
                "statusCounts": box_status_counts[str(box.get("id"))],
            }
            for box in boxes
        ]
        if box_counts.get(""):
            box_rows.append(
                {
                    "fishBoxId": None,
                    "boxCode": "Unassigned",
                    "n": box_counts[""],
                    "pct": box_counts[""] / total if total else None,
                    "empty": False,
                    "statusCounts": box_status_counts[""],
                }
            )
        box_rows.sort(key=lambda row: (-int(row["n"]), str(row["boxCode"])))

        by_batch: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
        for embryo in self.embryos:
            lot = self.lots.get(str(embryo.get("injectionLotId")))
            if lot and lot.get("batchId") in self.batches:
                by_batch[str(lot["batchId"])].append(embryo)
        today = datetime.now(BANGKOK).date()
        batch_rows = []
        for batch_id, batch in sorted(self.batches.items(), key=lambda item: str(item[1].get("batchCode") or item[0])):
            day5_observations = []
            for embryo in by_batch.get(batch_id, []):
                observations = [
                    item
                    for item in self.observations.get(str(embryo.get("id")), [])
                    if stage_number(str(item.get("stageCode", ""))) == DAY5_STAGE_ORDER
                ]
                if observations:
                    day5_observations.append(max(observations, key=lambda item: str(item.get("observedAt", ""))))
            n_normal = sum(item.get("condition") == "NORMAL" for item in day5_observations)
            n_abnormal = sum(item.get("condition") == "ABNORMAL" for item in day5_observations)
            denominator = n_normal + n_abnormal
            embryo_count = len(by_batch.get(batch_id, []))
            experiment_date = _as_date(batch.get("experimentDate"))
            day5_date = experiment_date + timedelta(days=5) if experiment_date else None
            if not day5_observations:
                status = "NOT_ELIGIBLE" if day5_date and today < day5_date else "MISSING"
            elif denominator == 0:
                status = "MISSING_CONDITION"
            else:
                status = "ELIGIBLE"
            batch_rows.append(
                {
                    "batchId": batch_id,
                    "batchCode": str(batch.get("batchCode") or batch_id),
                    "status": status,
                    "eligible": status == "ELIGIBLE",
                    "n": len(day5_observations),
                    "denominator": denominator,
                    "nNormal": n_normal,
                    "nAbnormal": n_abnormal,
                    "missingEmbryos": max(embryo_count - len(day5_observations), 0),
                    "pctNormal": n_normal / denominator if denominator else None,
                }
            )
        batch_rows.sort(
            key=lambda row: (
                not row["eligible"],
                -(float(row["pctNormal"]) if row["pctNormal"] is not None else -1),
                str(row["batchCode"]),
            )
        )

        known_sex = sex_counts["M"] + sex_counts["F"]
        return {
            "statusComposition": status_rows,
            "ageDistribution": age_rows,
            "ageDefinition": (
                "Age in days at each fish's current follow-up date, exit/status date, "
                "or today when no date is recorded."
            ),
            "sexComposition": sex_rows,
            "sexCompleteness": {
                "known": known_sex,
                "unknown": sex_counts["UNKNOWN"],
                "pctComplete": known_sex / total if total else None,
            },
            "boxCensus": box_rows,
            "boxMeta": {"nBoxes": len(box_rows), "emptyBoxes": sum(row["empty"] for row in box_rows)},
            "batchPerformance": batch_rows,
            "day5Definition": (
                "Day 5 is protocol stage order 26; performance is pct normal among "
                "embryos with known Day 5 condition."
            ),
            "missingExitDate": missing_exit_date,
        }

    def observation_gaps(self) -> dict[str, Any]:
        today, rows = datetime.now(BANGKOK).date(), []
        alive_fish = {fish_id: item for fish_id, item in self.fish.items() if item.get("status") == "ALIVE"}
        missing_observation = 0
        for fish in alive_fish.values():
            latest = max(
                (
                    str(item["observedOn"])
                    for item in self.state.fish_observations.values()
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
            "meta": self._meta(
                len(alive_fish),
                {"aliveFish": len(alive_fish)},
                missing={"observation": missing_observation},
            ),
        }

    def pipeline(self) -> dict[str, Any]:
        promoted_fish, start = self._promoted_fish(), self._activated_count()
        promoted = len(promoted_fish)
        counts = [
            ("Activated", start),
            ("Reached Shield", self._reached_count(19)),
            ("Reached Day 1", self._reached_count(22)),
            ("Promoted", promoted),
            ("Alive Fish", sum(item.get("status") == "ALIVE" for item in promoted_fish)),
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
            "meta": self._meta(
                len(self.embryos),
                {
                    "activated": start,
                    "promoted": promoted,
                    "fish": len(self.fish),
                    "promotedFish": promoted,
                    "alivePromotedFish": sum(item.get("status") == "ALIVE" for item in promoted_fish),
                    "manualFish": len(self.fish) - promoted,
                },
            ),
        }

    def dashboard(
        self,
        stage1_group_by: list[str] | None = None,
        stage2_group_by: list[str] | None = None,
    ) -> dict[str, Any]:
        profile_ids = {
            str(batch.get("timingProfileId")) for batch in self.batches.values() if batch.get("timingProfileId")
        } or {
            str(profile.get("id"))
            for profile in self.state.entities["timing-profiles"].values()
            if profile.get("isCurrent")
        }
        return {
            "reportMeta": {
                "generatedAt": utc_now().isoformat().replace("+00:00", "Z"),
                "timingProfileVersions": sorted(
                    {
                        int(profile["version"])
                        for profile in self.state.entities["timing-profiles"].values()
                        if str(profile.get("id")) in profile_ids
                    }
                ),
            },
            "kpi": self.kpi(),
            "funnel": self.funnel(),
            "survival": self.survival(stage1_group_by),
            "timingDeviation": self.timing_deviation(),
            "abnormalityOnset": self.abnormality_onset(),
            "fishSurvival": self.fish_survival(bool(stage2_group_by), stage2_group_by),
            "observationGaps": self.observation_gaps(),
            "pipeline": self.pipeline(),
        }


# Export reporting still consumes these narrow calculation seams. Keeping them
# here makes the dashboard and exports share the same Phase 7 rules.
def filtered_batches(state: State, query: dict[str, str]) -> dict[str, dict[str, Any]]:
    return Analytics(state, query).batches


def filtered_embryos(state: State, query: dict[str, str]) -> list[dict[str, Any]]:
    return Analytics(state, query).embryos


def filtered_fish(state: State, query: dict[str, str]) -> dict[str, dict[str, Any]]:
    return Analytics(state, query).fish


def observation_index(state: State) -> dict[str, list[dict[str, Any]]]:
    return Analytics(state, {})._observation_index()


def checkpoint_status(embryo: dict[str, Any], order: int, observations: dict[str, list[dict[str, Any]]]) -> str:
    values = observations.get(str(embryo["id"]), [])
    direct = next((item for item in values if stage_number(str(item.get("stageCode", ""))) == order), None)
    if direct:
        if direct.get("outcome") == "ALIVE":
            return "alive"
        if direct.get("outcome") in {"DEAD", "DEGENERATED"}:
            return "dead"
        return "blank"
    if embryo.get("exitReason") == "PROMOTED" and order <= 26:
        return "alive"
    exit_stage = stage_number(str(embryo.get("exitStageCode", "")))
    if exit_stage:
        return "alive" if order < exit_stage else "dead"
    highest_alive = max(
        (stage_number(str(item.get("stageCode", ""))) for item in values if item.get("outcome") == "ALIVE"),
        default=0,
    )
    return "alive" if order <= highest_alive else "blank"


def stage_survival(state: State, embryos: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return Analytics(state, {})._stage_survival(embryos)


def reached_count(state: State, embryos: list[dict[str, Any]], order: int) -> int:
    analytics = Analytics(state, {})
    analytics.embryos = embryos
    return analytics._reached_count(order)

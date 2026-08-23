from __future__ import annotations

import csv
import json
import statistics
from collections import defaultdict
from io import StringIO
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import Response

from ...domain.rules import stage_code, stage_label, stage_number
from ...domain.state import State
from ...reporting.xlsx import Sheet, build_xlsx
from ...runtime.values import iso_now
from ...store import Store
from .analytics import (
    checkpoint_status,
    filtered_batches,
    filtered_embryos,
    filtered_fish,
    observation_index,
    reached_count,
    stage_survival,
)


def _text(value: Any) -> str:
    return "" if value is None else str(value)


def _r_rows(state: State, query: dict[str, str]) -> list[list[object]]:
    groups: defaultdict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for embryo in filtered_embryos(state, query):
        lot = state.entities["injection-lots"][str(embryo["injectionLotId"])]
        batch = state.entities["batches"][str(lot["batchId"])]
        site = state.entities["sites"].get(str(batch.get("siteId")), {})
        donor = state.entities["donor-cell-lines"].get(str(lot.get("donorCellLineId")), {})
        groups[(_text(site.get("code")), _text(donor.get("strain")), _text(batch.get("replicateNo")))].append(embryo)
    observations = observation_index(state)
    rows = []
    for (site, strain, replicate), embryos in sorted(groups.items()):
        counts = [
            sum(checkpoint_status(item, order, observations) == "alive" for item in embryos) for order in range(1, 27)
        ]
        rows.append([site, strain, replicate, f"{strain}_{replicate}", *counts])
    return rows


R_HEADERS = ["Sites", "Strain", "Replicate", "Strain_Rep", *(stage_code(order) for order in range(1, 27))]


def _query(request: Request) -> dict[str, str]:
    return dict(request.query_params)


def _batch_rows(state: State, query: dict[str, str]) -> list[list[object]]:
    rows = []
    batches = filtered_batches(state, query)
    for lot in sorted(state.entities["injection-lots"].values(), key=lambda item: _text(item.get("id"))):
        batch = batches.get(str(lot.get("batchId")))
        if not batch or lot.get("deletedAt") is not None:
            continue
        donor = state.entities["donor-cell-lines"].get(str(lot.get("donorCellLineId")), {})
        site = state.entities["sites"].get(str(batch.get("siteId")), {})
        operator = state.entities["operators"].get(str(batch.get("operatorId")), {})
        treatment = state.entities["treatment-groups"].get(str(batch.get("treatmentGroupId")), {})
        rows.append(
            [
                batch.get("batchCode"),
                batch.get("experimentDate"),
                site.get("code"),
                operator.get("name"),
                treatment.get("code"),
                batch.get("clutchCode"),
                batch.get("replicateNo"),
                batch.get("recipientEggLotId"),
                batch.get("csofLotId"),
                batch.get("incubationTempC"),
                lot.get("lotNo"),
                donor.get("strain"),
                donor.get("preparation"),
                donor.get("batchCode"),
                lot.get("enuPowerPct"),
                lot.get("enuPulseUs"),
                lot.get("enuLed"),
                lot.get("enuStartAt"),
                lot.get("enuFinishAt"),
                lot.get("activatedAt"),
                lot.get("nEggs"),
                lot.get("nActivated"),
                lot.get("notes"),
            ]
        )
    return rows


def _embryo_observation_rows(state: State, query: dict[str, str]) -> list[list[object]]:
    allowed = {str(item["id"]) for item in filtered_embryos(state, query)}
    rows = []
    for item in sorted(state.observations.values(), key=lambda value: _text(value.get("id"))):
        if item.get("deletedAt") is not None or str(item.get("embryoId")) not in allowed:
            continue
        embryo = state.entities["embryos"].get(str(item.get("embryoId")), {})
        lot = state.entities["injection-lots"].get(str(embryo.get("injectionLotId")), {})
        batch = state.entities["batches"].get(str(lot.get("batchId")), {})
        expected = float(item.get("hpaExpectedSnapshot") or 0)
        deviation = float(item.get("deviationH") or 0)
        order = stage_number(_text(item.get("stageCode")))
        rows.append(
            [
                embryo.get("embryoCode"),
                batch.get("batchCode"),
                lot.get("lotNo"),
                embryo.get("wellPosition"),
                item.get("stageCode"),
                order,
                stage_label(order),
                item.get("observedAt"),
                item.get("hpaActual"),
                item.get("hpaExpectedSnapshot"),
                item.get("deviationH"),
                deviation / expected * 100 if expected else "",
                item.get("outcome"),
                item.get("condition"),
                item.get("operatorId"),
                item.get("isBackdated"),
                item.get("notes"),
            ]
        )
    return rows


def _embryo_matrix_rows(state: State, query: dict[str, str]) -> list[list[object]]:
    observations = observation_index(state)
    rows = []
    for embryo in filtered_embryos(state, query):
        lot = state.entities["injection-lots"].get(str(embryo.get("injectionLotId")), {})
        batch = state.entities["batches"].get(str(lot.get("batchId")), {})
        site = state.entities["sites"].get(str(batch.get("siteId")), {})
        donor = state.entities["donor-cell-lines"].get(str(lot.get("donorCellLineId")), {})
        treatment = state.entities["treatment-groups"].get(str(batch.get("treatmentGroupId")), {})
        values = {"alive": 1, "dead": 0, "blank": ""}
        rows.append(
            [
                embryo.get("embryoCode"),
                batch.get("batchCode"),
                site.get("code"),
                donor.get("strain"),
                treatment.get("code"),
                *(values[checkpoint_status(embryo, order, observations)] for order in range(1, 27)),
            ]
        )
    return rows


def _embryo_groups(state: State, query: dict[str, str]) -> dict[tuple[str, str, str, str], list[dict[str, Any]]]:
    groups: defaultdict[tuple[str, str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for embryo in filtered_embryos(state, query):
        lot = state.entities["injection-lots"][str(embryo["injectionLotId"])]
        batch = state.entities["batches"][str(lot["batchId"])]
        site = state.entities["sites"].get(str(batch.get("siteId")), {})
        donor = state.entities["donor-cell-lines"].get(str(lot.get("donorCellLineId")), {})
        treatment = state.entities["treatment-groups"].get(str(batch.get("treatmentGroupId")), {})
        groups[
            (
                _text(site.get("code")),
                _text(donor.get("strain")),
                _text(treatment.get("code")),
                _text(batch.get("batchCode")),
            )
        ].append(embryo)
    return dict(groups)


def _stage_count_rows(state: State, query: dict[str, str]) -> list[list[object]]:
    rows = []
    for (site, strain, treatment, batch), embryos in sorted(_embryo_groups(state, query).items()):
        for item in stage_survival(state, embryos):
            rows.append(
                [
                    site,
                    strain,
                    treatment,
                    batch,
                    item["stageOrder"],
                    item["stageLabel"],
                    item["riskSet"],
                    item["alive"],
                    item["nPrev"],
                    item["nDead"],
                    item["surv"],
                    item["pctOfDevelopment"],
                ]
            )
    return rows


def _timing_deviation_rows(state: State, query: dict[str, str]) -> list[list[object]]:
    allowed = {str(item["id"]) for item in filtered_embryos(state, query)}
    groups: defaultdict[tuple[str, str, str, int], list[float]] = defaultdict(list)
    for item in state.observations.values():
        embryo = state.entities["embryos"].get(str(item.get("embryoId")))
        if not embryo or embryo["id"] not in allowed or item.get("deletedAt") is not None:
            continue
        lot = state.entities["injection-lots"][str(embryo["injectionLotId"])]
        batch = state.entities["batches"][str(lot["batchId"])]
        site = state.entities["sites"].get(str(batch.get("siteId")), {})
        donor = state.entities["donor-cell-lines"].get(str(lot.get("donorCellLineId")), {})
        treatment = state.entities["treatment-groups"].get(str(batch.get("treatmentGroupId")), {})
        key = (
            _text(site.get("code")),
            _text(donor.get("strain")),
            _text(treatment.get("code")),
            stage_number(_text(item.get("stageCode"))),
        )
        groups[key].append(float(item.get("deviationH") or 0))
    return [
        [
            site,
            strain,
            treatment,
            order,
            stage_label(order),
            len(values),
            statistics.mean(values),
            statistics.median(values),
            statistics.stdev(values) if len(values) > 1 else 0,
            min(values),
            max(values),
        ]
        for (site, strain, treatment, order), values in sorted(groups.items())
    ]


def _fish_rows(
    state: State, query: dict[str, str]
) -> tuple[list[list[object]], list[list[object]], list[list[object]]]:
    fish = filtered_fish(state, query)
    register, observations, specimens = [], [], []
    for fish_id, item in sorted(fish.items()):
        donor = state.entities["donor-cell-lines"].get(str(item.get("donorCellLineId")), {})
        site = state.entities["sites"].get(str(item.get("siteId")), {})
        box = state.entities["fish-boxes"].get(str(item.get("fishBoxId")), {})
        embryo = state.entities["embryos"].get(str(item.get("embryoId")), {})
        register.append(
            [
                item.get("fishCode"),
                item.get("runningNo"),
                item.get("dob"),
                donor.get("strain"),
                donor.get("batchCode"),
                site.get("code"),
                box.get("boxCode"),
                item.get("status"),
                item.get("condition"),
                item.get("firstAbnormalOn"),
                item.get("firstAbnormalAgeDays"),
                item.get("sex"),
                item.get("finClipped"),
                item.get("exitDate"),
                item.get("exitReason"),
                item.get("ageDays"),
                embryo.get("embryoCode"),
                item.get("remarks"),
            ]
        )
        for observation in state.fish_observations.values():
            if observation.get("cloneFishId") == fish_id and observation.get("deletedAt") is None:
                observations.append(
                    [
                        item.get("fishCode"),
                        observation.get("observedOn"),
                        observation.get("ageDays"),
                        observation.get("outcome"),
                        observation.get("condition"),
                        observation.get("operatorId"),
                        observation.get("isBackdated"),
                        observation.get("notes"),
                    ]
                )
        for specimen in state.entities["specimens"].values():
            if specimen.get("cloneFishId") == fish_id and specimen.get("deletedAt") is None:
                specimens.append(
                    [
                        specimen.get("specimenCode"),
                        item.get("fishCode"),
                        specimen.get("specimenKind"),
                        specimen.get("specimenType"),
                        specimen.get("collectedOn"),
                        specimen.get("frozenOn"),
                        specimen.get("storage"),
                        specimen.get("notes"),
                    ]
                )
    return register, observations, specimens


def _fish_matrix(state: State, query: dict[str, str]) -> tuple[list[str], list[list[object]]]:
    fish = filtered_fish(state, query)
    max_age = max(
        (
            int(item.get("ageDays") or 0)
            for item in state.fish_observations.values()
            if item.get("cloneFishId") in fish and item.get("deletedAt") is None
        ),
        default=0,
    )
    columns = [f"d{age}" for age in range(1, max_age + 1)]
    rows = []
    for fish_id, item in sorted(fish.items()):
        donor = state.entities["donor-cell-lines"].get(str(item.get("donorCellLineId")), {})
        by_age = {
            int(value["ageDays"]): 1 if value.get("outcome") == "ALIVE" else 0
            for value in state.fish_observations.values()
            if value.get("cloneFishId") == fish_id and value.get("deletedAt") is None
        }
        rows.append(
            [
                item.get("fishCode"),
                item.get("dob"),
                donor.get("strain"),
                item.get("status"),
                *(by_age.get(age, "") for age in range(1, max_age + 1)),
            ]
        )
    return columns, rows


def _control_rows(state: State, query: dict[str, str]) -> list[list[object]]:
    batches = filtered_batches(state, query)
    rows = []
    for item in state.entities["control-arm-counts"].values():
        batch = batches.get(str(item.get("batchId")))
        if not batch or item.get("deletedAt") is not None:
            continue
        site = state.entities["sites"].get(str(batch.get("siteId")), {})
        rows.append(
            [
                batch.get("batchCode"),
                batch.get("experimentDate"),
                site.get("code"),
                item.get("armType"),
                stage_label(stage_number(_text(item.get("stageCode")))),
                item.get("nNormal"),
                item.get("nAbnormal"),
            ]
        )
    return rows


def _summary_rows(state: State, query: dict[str, str]) -> list[list[object]]:
    groups: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    for embryo in filtered_embryos(state, query):
        lot = state.entities["injection-lots"][str(embryo["injectionLotId"])]
        donor = state.entities["donor-cell-lines"].get(str(lot.get("donorCellLineId")), {})
        groups[_text(donor.get("strain"))].append(embryo)
    index = observation_index(state)
    fish = filtered_fish(state, query)
    rows = []
    for strain, embryos in sorted(groups.items()):
        lots = {str(item["injectionLotId"]) for item in embryos}
        batches = {str(state.entities["injection-lots"][lot]["batchId"]) for lot in lots}
        latest = [
            max(index.get(str(embryo["id"]), []), key=lambda item: str(item.get("observedAt")), default={})
            for embryo in embryos
        ]
        normal = sum(item.get("condition") == "NORMAL" for item in latest)
        abnormal = sum(item.get("condition") == "ABNORMAL" for item in latest)
        promoted = sum(item.get("strain") == strain for item in fish.values())
        rows.append(
            [
                strain,
                len(batches),
                sum(int(state.entities["injection-lots"][lot].get("nEggs") or 0) for lot in lots),
                sum(int(state.entities["injection-lots"][lot].get("nActivated") or 0) for lot in lots),
                reached_count(state, embryos, 19),
                reached_count(state, embryos, 22),
                promoted,
                normal,
                abnormal,
                normal / len(embryos) if embryos else 0,
                abnormal / len(embryos) if embryos else 0,
            ]
        )
    return rows


def _timing_rows(state: State) -> list[list[object]]:
    rows = []
    for profile in sorted(state.entities["timing-profiles"].values(), key=lambda item: int(item.get("version", 0))):
        for entry in profile.get("entries", []):
            rows.append(
                [
                    entry.get("stageOrder"),
                    entry.get("stageCode"),
                    entry.get("stageLabel"),
                    entry.get("expectedHpa"),
                    entry.get("phase"),
                    entry.get("stageScope"),
                    profile.get("id"),
                    profile.get("version"),
                    profile.get("referenceTempC"),
                    profile.get("sourceNote"),
                ]
            )
    return rows


def _sheets(state: State, query: dict[str, str]) -> list[Sheet]:
    fish_register, fish_observations, specimens = _fish_rows(state, query)
    fish_columns, fish_matrix = _fish_matrix(state, query)
    r_rows = _r_rows(state, query)
    sheets: list[Sheet] = [
        ("00_Metadata", ["key", "value"], [["exported_at", iso_now()], ["filters", json.dumps(query, sort_keys=True)]]),
        (
            "01_Batches",
            [
                "batch_code",
                "experiment_date",
                "site",
                "operator",
                "treatment_group",
                "clutch_code",
                "replicate_no",
                "recipient_egg_lot",
                "csof_lot",
                "incubation_temp_c",
                "lot_no",
                "donor_strain",
                "donor_preparation",
                "donor_batch_code",
                "enu_power_pct",
                "enu_pulse_us",
                "enu_led",
                "enu_start_at",
                "enu_finish_at",
                "activated_at",
                "n_eggs",
                "n_activated",
                "notes",
            ],
            _batch_rows(state, query),
        ),
        (
            "02_Embryo_Observations",
            [
                "embryo_code",
                "batch_code",
                "lot_no",
                "well_position",
                "stage_code",
                "stage_order",
                "stage_label",
                "observed_at",
                "hpa_actual",
                "hpa_expected",
                "deviation_h",
                "deviation_pct",
                "outcome",
                "condition",
                "operator",
                "is_backdated",
                "notes",
            ],
            _embryo_observation_rows(state, query),
        ),
        (
            "03_Embryo_Matrix",
            [
                "embryo_code",
                "batch_code",
                "site",
                "strain",
                "treatment_group",
                *(stage_code(order) for order in range(1, 27)),
            ],
            _embryo_matrix_rows(state, query),
        ),
        (
            "04_Stage_Counts",
            [
                "site",
                "strain",
                "treatment_group",
                "batch_code",
                "stage_order",
                "stage_label",
                "risk_set",
                "alive",
                "n_prev",
                "n_dead",
                "surv",
                "pct_of_development",
            ],
            _stage_count_rows(state, query),
        ),
        (
            "05_Timing_Deviation",
            [
                "site",
                "strain",
                "treatment_group",
                "stage_order",
                "stage_label",
                "n",
                "mean_deviation_h",
                "median_deviation_h",
                "sd_deviation_h",
                "min_deviation_h",
                "max_deviation_h",
            ],
            _timing_deviation_rows(state, query),
        ),
        (
            "06_Fish_Register",
            [
                "fish_code",
                "running_no",
                "dob",
                "strain",
                "donor_batch_code",
                "site",
                "fish_box",
                "status",
                "condition",
                "first_abnormal_on",
                "first_abnormal_age_days",
                "sex",
                "fin_clipped",
                "exit_date",
                "exit_reason",
                "age_days_current",
                "embryo_code",
                "remarks",
            ],
            fish_register,
        ),
        (
            "07_Fish_Observations",
            ["fish_code", "observed_on", "age_days", "outcome", "condition", "operator", "is_backdated", "notes"],
            fish_observations,
        ),
        ("08_Fish_Matrix", ["fish_code", "dob", "strain", "status", *fish_columns], fish_matrix),
        (
            "09_Control_Arms",
            ["batch_code", "experiment_date", "site", "arm_type", "stage_label", "n_normal", "n_abnormal"],
            _control_rows(state, query),
        ),
        (
            "10_Specimens",
            [
                "specimen_code",
                "fish_code",
                "specimen_kind",
                "specimen_type",
                "collected_on",
                "frozen_on",
                "storage",
                "notes",
            ],
            specimens,
        ),
        (
            "11_Summary",
            [
                "strain",
                "n_batches",
                "n_eggs",
                "n_activated",
                "n_reached_shield",
                "n_reached_day1",
                "n_promoted",
                "n_normal",
                "n_abnormal",
                "pct_normal",
                "pct_abnormal",
            ],
            _summary_rows(state, query),
        ),
        ("12_R_Analysis_Table", R_HEADERS, r_rows),
        (
            "13_Stage_Timing_Reference",
            [
                "stage_order",
                "stage_code",
                "stage_label",
                "expected_hpa",
                "phase",
                "stage_scope",
                "profile_id",
                "profile_version",
                "reference_temp_c",
                "source_note",
            ],
            _timing_rows(state),
        ),
    ]
    sheets[0][2].extend([[f"row_count.{name}", len(rows)] for name, _headers, rows in sheets[1:]])
    return sheets


def build_export_router(store: Store) -> APIRouter:
    router = APIRouter(prefix="/api/v1/exports")

    @router.get("/r-table")
    def export_r_table(request: Request) -> Response:
        output = StringIO(newline="")
        writer = csv.writer(output)
        writer.writerow(R_HEADERS)
        writer.writerows(_r_rows(store.snapshot(), _query(request)))
        return Response(
            "\ufeff" + output.getvalue(),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="chronofish-r-table.csv"'},
        )

    @router.post("/excel")
    async def export_excel(request: Request) -> Response:
        body = await request.json()

        def operation(state: State):
            filters = {key: _text(value) for key, value in (body.get("filters") or {}).items() if value is not None}
            return (
                200,
                build_xlsx(_sheets(state, filters)),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )

        response = store.execute_mutation(request, body, operation)
        response.headers["Content-Disposition"] = 'attachment; filename="chronofish-export.xlsx"'
        return response

    return router

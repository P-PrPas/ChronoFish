from __future__ import annotations

from datetime import UTC, datetime, timedelta
from time import perf_counter

import pytest
from test_experiments import create_batch, headers
from test_fish import BANGKOK, setup_eligible_embryo


def analytics_fixture(client, write_headers):
    batch, donor = create_batch(client, write_headers)
    activated = (datetime.now(UTC) - timedelta(days=8)).replace(microsecond=0)
    lot_response = client.post(
        f"/api/v1/batches/{batch['id']}/injection-lots",
        headers=headers(write_headers, 510),
        json={
            "lotNo": "analytics",
            "donorCellLineId": donor["id"],
            "activatedAt": activated.isoformat().replace("+00:00", "Z"),
            "nEggs": 5,
            "nActivated": 3,
        },
    )
    assert lot_response.status_code == 201, lot_response.text
    embryos = lot_response.json()["embryos"]
    observed_at = (datetime.now(UTC) - timedelta(minutes=1)).isoformat().replace("+00:00", "Z")
    observations = [
        (embryos[0], "stage_19_50%", "ALIVE", "NORMAL", 512),
        (embryos[0], "stage_22_1D", "ALIVE", "NORMAL", 513),
        (embryos[1], "stage_19_50%", "DEAD", "NORMAL", 514),
        (embryos[2], "stage_19_50%", "ALIVE", "ABNORMAL", 515),
        (embryos[2], "stage_22_1D", "ALIVE", "ABNORMAL", 516),
    ]
    payload = [
        {
            "clientUuid": f"01900000-0000-7000-8000-{number:012d}",
            "embryoId": embryo["id"],
            "stageCode": stage,
            "observedAt": observed_at,
            "outcome": outcome,
            "condition": condition,
        }
        for embryo, stage, outcome, condition, number in observations
    ]
    observed_response = client.post(
        "/api/v1/observations/embryo",
        headers=headers(write_headers, 517),
        json={"observations": payload},
    )
    assert observed_response.status_code == 200, observed_response.text
    return batch, donor, lot_response.json()


def test_dashboard_endpoints_return_complete_shapes(client, write_headers):
    setup_eligible_embryo(client, write_headers)
    kpi = client.get("/api/v1/analytics/kpi")
    assert kpi.status_code == 200
    assert {"nActivated", "nReachedShield", "nReachedDay1", "nPromoted", "pctNormal"} <= set(kpi.json()["stage1"])
    assert {"nFish", "nAlive", "nNormal", "nAbnormal"} <= set(kpi.json()["stage2"])
    for endpoint in (
        "funnel",
        "survival",
        "timing-deviation",
        "abnormality-onset",
        "fish-survival",
        "observation-gaps",
        "pipeline",
    ):
        response = client.get(f"/api/v1/analytics/{endpoint}")
        assert response.status_code == 200, (endpoint, response.text)
        assert isinstance(response.json()["items"], list)
        assert {"filters", "sampleSize", "denominators", "unknown", "missing"} <= set(response.json()["meta"])


def test_dashboard_bundle_uses_one_consistent_snapshot(client, store, monkeypatch):
    original = store.snapshot
    calls = 0

    def counted_snapshot():
        nonlocal calls
        calls += 1
        return original()

    monkeypatch.setattr(store, "snapshot", counted_snapshot)
    response = client.get("/api/v1/analytics/dashboard")
    assert response.status_code == 200, response.text
    assert set(response.json()) == {
        "reportMeta",
        "kpi",
        "funnel",
        "survival",
        "timingDeviation",
        "abnormalityOnset",
        "fishSurvival",
        "observationGaps",
        "pipeline",
    }
    assert response.json()["reportMeta"]["generatedAt"].endswith("Z")
    assert response.json()["reportMeta"]["timingProfileVersions"] == [1]
    assert calls == 1


def test_survival_returns_twenty_six_stages_and_fractional_survival(client, write_headers):
    setup_eligible_embryo(client, write_headers)
    rows = client.get("/api/v1/analytics/survival").json()["items"]
    assert len(rows) == 26
    assert rows[0]["stageOrder"] == 1
    assert 0 <= rows[0]["surv"] <= 1


def test_analytics_fixture_matches_manual_counts_and_shared_filters(client, write_headers):
    batch, donor, lot = analytics_fixture(client, write_headers)
    filters = {
        "dateFrom": "2026-08-20",
        "dateTo": "2026-08-20",
        "siteId": batch["siteId"],
        "operatorId": batch["operatorId"],
        "treatmentGroupId": batch["treatmentGroupId"],
        "donorCellLineId": donor["id"],
        "strain": "AB",
        "batchId": batch["id"],
    }
    kpi = client.get("/api/v1/analytics/kpi", params=filters).json()
    assert {key: kpi["stage1"][key] for key in ("nBatches", "nEggs", "nActivated")} == {
        "nBatches": 1,
        "nEggs": 5,
        "nActivated": 3,
    }
    assert kpi["stage1"]["nPromoted"] == 0
    assert kpi["stage1"]["pctNormal"] == pytest.approx(2 / 3)
    assert kpi["stage1"]["pctAbnormal"] == pytest.approx(1 / 3)
    assert kpi["meta"]["filters"] == filters
    assert kpi["meta"]["denominators"]["activated"] == 3
    assert [item["id"] for item in client.get("/api/v1/batches", params=filters).json()["items"]] == [batch["id"]]

    for endpoint in (
        "funnel",
        "survival",
        "timing-deviation",
        "abnormality-onset",
        "fish-survival",
        "observation-gaps",
        "pipeline",
    ):
        response = client.get(f"/api/v1/analytics/{endpoint}", params=filters)
        assert response.status_code == 200, (endpoint, response.text)
        assert response.json()["meta"]["filters"] == filters

    funnel = client.get("/api/v1/analytics/funnel", params=filters).json()
    stage_19_funnel = next(item for item in funnel["items"] if item["stageOrder"] == 19)
    assert stage_19_funnel["alive"] == 2
    assert stage_19_funnel["pctOfActivated"] == pytest.approx(200 / 3)

    survival = client.get("/api/v1/analytics/survival", params={**filters, "groupBy": ["operator"]}).json()
    stage_19 = next(item for item in survival["items"] if item["stageOrder"] == 19)
    stage_22 = next(item for item in survival["items"] if item["stageOrder"] == 22)
    assert stage_19["operatorId"] == batch["operatorId"]
    assert stage_19["riskSet"] == 3
    assert (stage_19["alive"], stage_19["nPrev"], stage_19["nDead"]) == (2, 3, 1)
    assert stage_19["surv"] == pytest.approx(2 / 3)
    assert stage_22["surv"] == pytest.approx(2 / 3)
    assert survival["meta"]["missing"]["stageCheckpoint"] > 0

    timing = client.get("/api/v1/analytics/timing-deviation", params={**filters, "groupBy": ["operator"]}).json()
    assert {item["operatorId"] for item in timing["items"]} == {batch["operatorId"]}
    assert {item["stageOrder"] for item in timing["items"]} == {19, 22}

    abnormality = client.get("/api/v1/analytics/abnormality-onset", params=filters).json()
    assert abnormality["items"] == [{"stageOrder": 19, "stageLabel": "Shield", "count": 1}]
    assert abnormality["meta"]["denominators"]["everAbnormal"] == 1
    assert abnormality["meta"]["denominators"]["noAbnormalityRecorded"] == 2
    assert abnormality["meta"]["missing"].get("firstAbnormality", 0) == 0

    pipeline = client.get("/api/v1/analytics/pipeline", params=filters).json()
    assert [item["count"] for item in pipeline["items"]] == [3, 2, 2, 0, 0]
    assert pipeline["items"][0]["pctOfStart"] == 1


def test_stage1_survival_does_not_increase_when_raw_alive_rises_after_a_gap(client, write_headers, store):
    _batch, _donor, lot = analytics_fixture(client, write_headers)
    with store.lock:
        stage_19 = next(
            item
            for item in store.state.observations.values()
            if item.get("embryoId") == lot["embryos"][0]["id"] and item.get("stageCode") == "stage_19_50%"
        )
        stage_19["outcome"] = "DEAD"

    rows = client.get("/api/v1/analytics/survival").json()["items"]
    assert all(current["surv"] <= previous["surv"] for previous, current in zip(rows, rows[1:], strict=False))
    stage_19_row = next(item for item in rows if item["stageOrder"] == 19)
    stage_22_row = next(item for item in rows if item["stageOrder"] == 22)
    assert (stage_19_row["alive"], stage_19_row["nPrev"]) == (1, 3)
    assert (stage_22_row["alive"], stage_22_row["nPrev"]) == (2, 2)
    assert stage_22_row["surv"] == pytest.approx(stage_19_row["surv"])


def test_manual_fish_is_not_counted_as_promoted_and_uses_unknown_metadata(client, write_headers):
    _batch, donor = create_batch(client, write_headers)
    today = datetime.now(BANGKOK).date().isoformat()
    fish_response = client.post(
        "/api/v1/fish",
        headers=headers(write_headers, 520),
        json={"fishCode": "manual-analytics", "dob": today, "donorCellLineId": donor["id"]},
    )
    assert fish_response.status_code == 201, fish_response.text
    assert client.get("/api/v1/fish", params={"batchId": _batch["id"]}).json()["items"] == []
    assert len(client.get("/api/v1/fish", params={"donorCellLineId": donor["id"]}).json()["items"]) == 1
    result = client.get("/api/v1/analytics/kpi").json()
    assert result["stage1"]["nPromoted"] == 0
    assert result["stage2"]["nFish"] == 1
    assert result["meta"]["unknown"]["fishSex"] == 1
    pipeline = client.get("/api/v1/analytics/pipeline").json()
    assert pipeline["items"][-1]["step"] == "Alive Fish"
    assert pipeline["items"][-1]["count"] == 0
    assert pipeline["meta"]["denominators"]["manualFish"] == 1
    filtered = client.get("/api/v1/analytics/kpi", params={"donorCellLineId": donor["id"]}).json()
    assert filtered["stage2"]["nFish"] == 1
    fish_survival = client.get("/api/v1/analytics/fish-survival", params={"splitByCondition": True}).json()
    assert fish_survival["items"][0]["treatmentGroup"] == "ALL"


def test_zero_denominator_and_missing_checkpoint_are_explicit(client, write_headers):
    empty_kpi = client.get("/api/v1/analytics/kpi").json()
    assert empty_kpi["stage1"]["pctNormal"] is None
    assert empty_kpi["meta"]["denominators"]["activated"] == 0
    empty_pipeline = client.get("/api/v1/analytics/pipeline").json()
    assert all(item["pctOfStart"] is None and item["pctOfPrevious"] is None for item in empty_pipeline["items"])

    batch, donor = create_batch(client, write_headers)
    activated = (datetime.now(UTC) - timedelta(days=8)).isoformat().replace("+00:00", "Z")
    lot = client.post(
        f"/api/v1/batches/{batch['id']}/injection-lots",
        headers=headers(write_headers, 530),
        json={"lotNo": "missing", "donorCellLineId": donor["id"], "activatedAt": activated, "nActivated": 1},
    ).json()
    survival = client.get("/api/v1/analytics/survival").json()
    assert survival["items"][0]["surv"] == 1
    assert survival["items"][1]["nPrev"] == 0
    assert survival["items"][1]["surv"] == 1
    assert survival["items"][1]["pctOfDevelopment"] is None
    assert survival["meta"]["missing"]["stageCheckpoint"] >= len(lot["embryos"])
    abnormality = client.get("/api/v1/analytics/abnormality-onset").json()
    assert abnormality["meta"]["denominators"].get("noAbnormalityRecorded", 0) == 0
    assert abnormality["meta"]["missing"]["firstAbnormality"] == len(lot["embryos"])


def test_dashboard_bundle_smoke_fixture_stays_under_three_seconds(client, store):
    today = datetime.now(BANGKOK).date()
    with store.lock:
        store.state.entities["fish"] = {
            f"fish-{index}": {
                "id": f"fish-{index}",
                "fishCode": f"F-{index}",
                "dob": (today - timedelta(days=index % 1826)).isoformat(),
                "donorCellLineId": "donor-fixture",
                "status": "ALIVE",
                "condition": "NORMAL",
                "sex": "UNKNOWN",
                "fishBoxId": None,
                "active": True,
                "deletedAt": None,
            }
            for index in range(500)
        }
    start = perf_counter()
    assert client.get("/api/v1/analytics/dashboard").status_code == 200
    assert perf_counter() - start < 3


def test_fish_survival_respects_dead_status_without_exit_date(client, store):
    with store.lock:
        store.state.entities["fish"] = {
            "dead-fish": {
                "id": "dead-fish",
                "fishCode": "DEAD-1",
                "dob": datetime.now(BANGKOK).date().isoformat(),
                "donorCellLineId": "donor-fixture",
                "status": "DEAD",
                "condition": "NORMAL",
                "sex": "UNKNOWN",
                "active": True,
                "deletedAt": None,
            }
        }
    point = client.get("/api/v1/analytics/fish-survival").json()["items"][0]
    assert (point["atRisk"], point["alive"], point["surv"]) == (1, 0, 0)
    assert point["nEvents"] == 1
    assert client.get("/api/v1/analytics/fish-survival").json()["meta"]["missing"]["exitDate"] == 1


def test_fish_survival_uses_kaplan_meier_events_and_last_follow_up_censoring(client, store):
    today = datetime.now(BANGKOK).date()
    dob = (today - timedelta(days=4)).isoformat()
    with store.lock:
        store.state.entities["fish"] = {
            "alive": {
                "id": "alive", "fishCode": "ALIVE", "dob": dob, "status": "ALIVE",
                "condition": "NORMAL", "sex": "UNKNOWN", "active": True, "deletedAt": None,
            },
            "dead": {
                "id": "dead", "fishCode": "DEAD", "dob": dob, "status": "DEAD",
                "condition": "NORMAL", "sex": "UNKNOWN", "exitDate": (today - timedelta(days=2)).isoformat(),
                "active": True, "deletedAt": None,
            },
            "frozen": {
                "id": "frozen", "fishCode": "FROZEN", "dob": dob, "status": "FROZEN",
                "condition": "ABNORMAL", "sex": "UNKNOWN",
                "firstAbnormalOn": (today - timedelta(days=1)).isoformat(),
                "exitDate": (today - timedelta(days=1)).isoformat(), "active": True, "deletedAt": None,
            },
            "discarded": {
                "id": "discarded", "fishCode": "DISCARDED", "dob": dob, "status": "DISCARDED",
                "condition": "NORMAL", "sex": "UNKNOWN", "exitDate": (today - timedelta(days=3)).isoformat(),
                "active": True, "deletedAt": None,
            },
        }
        store.state.fish_observations["alive-follow-up"] = {
            "id": "alive-follow-up", "cloneFishId": "alive", "observedOn": (today - timedelta(days=2)).isoformat(),
            "outcome": "ALIVE", "condition": "NORMAL", "deletedAt": None,
        }

    result = client.get("/api/v1/analytics/fish-survival").json()
    rows = result["items"]
    assert [(row["ageDays"], row["atRisk"], row["nEvents"], row["nCensored"]) for row in rows] == [
        (0, 4, 0, 0), (1, 4, 0, 1), (2, 3, 1, 1), (3, 1, 0, 1)
    ]
    assert [row["surv"] for row in rows] == pytest.approx([1, 1, 2 / 3, 2 / 3])
    assert all(current["surv"] <= previous["surv"] for previous, current in zip(rows, rows[1:], strict=False))
    assert all(0 <= row["survLower95"] <= row["surv"] <= row["survUpper95"] <= 1 for row in rows)
    split = client.get("/api/v1/analytics/fish-survival?splitByCondition=true").json()
    assert split["meta"]["method"] == "Kaplan-Meier"
    assert split["meta"]["comparison"]["label"] == "Ever abnormal vs No abnormality recorded"
    assert split["meta"]["comparison"]["interpretation"] == "Exploratory comparison; not causal."
    assert {row["abnormalityGroup"] for row in split["items"]} == {
        "EVER_ABNORMAL", "NO_ABNORMALITY_RECORDED", "UNKNOWN"
    }


def test_nullable_egg_count_is_reported_without_breaking_kpi(client, write_headers):
    batch, donor = create_batch(client, write_headers)
    response = client.post(
        f"/api/v1/batches/{batch['id']}/injection-lots",
        headers=headers(write_headers, 540),
        json={
            "lotNo": "unknown-eggs",
            "donorCellLineId": donor["id"],
            "activatedAt": (datetime.now(UTC) - timedelta(hours=1)).isoformat(),
            "nEggs": None,
            "nActivated": 1,
        },
    )
    assert response.status_code == 201, response.text
    kpi = client.get("/api/v1/analytics/kpi")
    assert kpi.status_code == 200, kpi.text
    assert kpi.json()["stage1"]["nEggs"] == 0
    assert kpi.json()["meta"]["missing"]["nEggs"] == 1


def test_control_comparison_pairs_scnt_at_control_stage_and_keeps_zero_unknown(client, write_headers):
    batch, _donor = create_batch(client, write_headers)
    saved = client.put(
        f"/api/v1/batches/{batch['id']}/control-arm-counts",
        headers=headers(write_headers, 541),
        json={
            "items": [
                {
                    "armType": "IVF",
                    "stageCode": "stage_03_4C",
                    "nNormal": 0,
                    "nAbnormal": 0,
                }
            ]
        },
    )
    assert saved.status_code == 200, saved.text
    comparison = client.get("/api/v1/analytics/kpi", params={"batchId": batch["id"]}).json()["stage1"][
        "controlComparison"
    ]
    stage_three = [item for item in comparison if item["stageOrder"] == 3]
    assert {item["armType"] for item in stage_three} == {"SCNT", "IVF"}
    ivf = next(item for item in stage_three if item["armType"] == "IVF")
    assert ivf["pctNormal"] is None
    assert ivf["pctAbnormal"] is None

    second_batch = client.post(
        "/api/v1/batches",
        headers=headers(write_headers, 542),
        json={
            "experimentDate": "2026-08-21",
            "siteId": batch["siteId"],
            "operatorId": batch["operatorId"],
            "protocolId": batch["protocolId"],
            "treatmentGroupId": batch["treatmentGroupId"],
        },
    ).json()
    client.put(
        f"/api/v1/batches/{second_batch['id']}/control-arm-counts",
        headers=headers(write_headers, 543),
        json={"items": [{"armType": "IVF", "stageCode": "stage_03_4C", "nNormal": 2, "nAbnormal": 1}]},
    )
    aggregated = client.get("/api/v1/analytics/kpi").json()["stage1"]["controlComparison"]
    ivf_rows = [item for item in aggregated if item["stageOrder"] == 3 and item["armType"] == "IVF"]
    assert len(ivf_rows) == 1
    assert (ivf_rows[0]["n"], ivf_rows[0]["nNormal"], ivf_rows[0]["nAbnormal"]) == (3, 2, 1)

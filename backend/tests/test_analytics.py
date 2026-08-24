from __future__ import annotations

from datetime import UTC, datetime, timedelta
from time import perf_counter

import pytest
from test_experiments import create_batch, headers
from test_fish import setup_eligible_embryo


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
        assert set(response.json()["meta"]) == {"filters", "sampleSize", "denominators", "unknown", "missing"}


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
    assert abnormality["meta"]["missing"]["firstAbnormality"] == 2

    pipeline = client.get("/api/v1/analytics/pipeline", params=filters).json()
    assert [item["count"] for item in pipeline["items"]] == [3, 2, 2, 0, 0]
    assert pipeline["items"][0]["pctOfStart"] == 1


def test_manual_fish_is_not_counted_as_promoted_and_uses_unknown_metadata(client, write_headers):
    _batch, donor = create_batch(client, write_headers)
    today = datetime.now().date().isoformat()
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


def test_five_year_dashboard_fixture_stays_under_three_seconds(client, store):
    today = datetime.now().date()
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
    for endpoint in (
        "kpi",
        "funnel",
        "survival",
        "timing-deviation",
        "abnormality-onset",
        "fish-survival",
        "observation-gaps",
        "pipeline",
    ):
        assert client.get(f"/api/v1/analytics/{endpoint}").status_code == 200
    assert perf_counter() - start < 3


def test_fish_survival_respects_dead_status_without_exit_date(client, store):
    with store.lock:
        store.state.entities["fish"] = {
            "dead-fish": {
                "id": "dead-fish",
                "fishCode": "DEAD-1",
                "dob": datetime.now().date().isoformat(),
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

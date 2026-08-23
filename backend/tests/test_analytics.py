from __future__ import annotations

from test_fish import setup_eligible_embryo


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


def test_survival_returns_twenty_six_stages_and_fractional_survival(client, write_headers):
    setup_eligible_embryo(client, write_headers)
    rows = client.get("/api/v1/analytics/survival").json()["items"]
    assert len(rows) == 26
    assert rows[0]["stageOrder"] == 1
    assert 0 <= rows[0]["surv"] <= 1

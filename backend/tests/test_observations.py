from __future__ import annotations

from datetime import UTC, datetime, timedelta

from test_experiments import create_batch, headers


def setup_embryo(client, write_headers):
    batch, donor = create_batch(client, write_headers)
    activated = (datetime.now(UTC) - timedelta(hours=10)).isoformat().replace("+00:00", "Z")
    lot = client.post(
        f"/api/v1/batches/{batch['id']}/injection-lots",
        headers=headers(write_headers, 301),
        json={"lotNo": "1", "donorCellLineId": donor["id"], "activatedAt": activated, "nActivated": 1},
    ).json()
    return batch, lot, lot["embryos"][0], activated


def test_checkpoint_and_bulk_observation_snapshot_timing(client, write_headers):
    _batch, lot, embryo, activated = setup_embryo(client, write_headers)
    checkpoint = client.get(f"/api/v1/injection-lots/{lot['id']}/checkpoints/stage_05_16C")
    assert checkpoint.status_code == 200
    observed = (datetime.fromisoformat(activated.replace("Z", "+00:00")) + timedelta(hours=2)).isoformat()
    response = client.post(
        "/api/v1/observations/embryo",
        headers=headers(write_headers, 302),
        json={
            "observations": [
                {
                    "clientUuid": "01900000-0000-7000-8000-000000000301",
                    "embryoId": embryo["id"],
                    "stageCode": "stage_05_16C",
                    "observedAt": observed,
                    "outcome": "ALIVE",
                    "condition": "NORMAL",
                }
            ]
        },
    )
    assert response.status_code == 200, response.text
    result = response.json()["results"][0]
    assert result["status"] == "created"
    assert result["hpaActual"] == 2
    assert result["hpaExpected"] == 1.5
    assert result["deviationH"] == 0.5


def test_observation_duplicate_and_delete_requires_reason(client, write_headers):
    _batch, _lot, embryo, activated = setup_embryo(client, write_headers)
    body = {
        "observations": [
            {
                "clientUuid": "01900000-0000-7000-8000-000000000302",
                "embryoId": embryo["id"],
                "stageCode": "stage_02_2C",
                "observedAt": activated,
                "outcome": "ALIVE",
                "condition": "NORMAL",
            }
        ]
    }
    created = client.post("/api/v1/observations/embryo", headers=headers(write_headers, 303), json=body).json()
    observation_id = created["results"][0]["id"]
    duplicate = client.post("/api/v1/observations/embryo", headers=headers(write_headers, 304), json=body)
    assert duplicate.json()["results"][0]["status"] == "duplicate"
    missing = client.delete(f"/api/v1/observations/embryo/{observation_id}", headers=headers(write_headers, 305))
    assert missing.status_code == 422
    deleted = client.delete(
        f"/api/v1/observations/embryo/{observation_id}?reason=wrong-entry", headers=headers(write_headers, 306)
    )
    assert deleted.status_code == 204


def test_abnormal_observation_updates_embryo_projection(client, write_headers):
    _batch, lot, embryo, activated = setup_embryo(client, write_headers)
    response = client.post(
        "/api/v1/observations/embryo",
        headers=headers(write_headers, 307),
        json={
            "observations": [
                {
                    "clientUuid": "01900000-0000-7000-8000-000000000307",
                    "embryoId": embryo["id"],
                    "stageCode": "stage_03_4C",
                    "observedAt": activated,
                    "outcome": "ALIVE",
                    "condition": "ABNORMAL",
                }
            ]
        },
    )
    assert response.json()["results"][0]["status"] == "created"
    projected = client.get(f"/api/v1/injection-lots/{lot['id']}/embryos").json()["items"][0]
    assert projected["firstAbnormalStageCode"] == "stage_03_4C"

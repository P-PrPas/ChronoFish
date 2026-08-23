from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from test_experiments import create_batch, headers

BANGKOK = ZoneInfo("Asia/Bangkok")


def setup_eligible_embryo(client, write_headers, condition="NORMAL"):
    batch, donor = create_batch(client, write_headers)
    activated = (datetime.now(UTC) - timedelta(days=6)).isoformat().replace("+00:00", "Z")
    lot = client.post(
        f"/api/v1/batches/{batch['id']}/injection-lots",
        headers=headers(write_headers, 401),
        json={"lotNo": "1", "donorCellLineId": donor["id"], "activatedAt": activated, "nActivated": 1},
    ).json()
    embryo = lot["embryos"][0]
    observed = client.post(
        "/api/v1/observations/embryo",
        headers=headers(write_headers, 402),
        json={
            "observations": [
                {
                    "clientUuid": "01900000-0000-7000-8000-000000000401",
                    "embryoId": embryo["id"],
                    "stageCode": "stage_26_5D",
                    "observedAt": (datetime.now(UTC) - timedelta(minutes=1)).isoformat(),
                    "outcome": "ALIVE",
                    "condition": condition,
                }
            ]
        },
    )
    assert observed.json()["results"][0]["status"] == "created"
    return embryo


def test_promotion_allocates_running_number_and_closes_embryo(client, write_headers):
    embryo = setup_eligible_embryo(client, write_headers)
    pending = client.get("/api/v1/promotions/pending").json()["items"]
    assert pending[0]["embryoId"] == embryo["id"]
    response = client.post(
        "/api/v1/promotions",
        headers=headers(write_headers, 403),
        json={"promotions": [{"clientUuid": "01900000-0000-7000-8000-000000000403", "embryoId": embryo["id"]}]},
    )
    assert response.status_code == 201, response.text
    fish = response.json()["items"][0]["fish"]
    assert fish["runningNo"] == 1
    assert fish["dob"] != datetime.now(UTC).date().isoformat()
    assert client.get("/api/v1/promotions/pending").json()["items"] == []


def test_abnormal_promotion_inherits_first_marker_and_replays_idempotently(client, write_headers):
    embryo = setup_eligible_embryo(client, write_headers, condition="ABNORMAL")
    response = client.post(
        "/api/v1/promotions",
        headers=headers(write_headers, 403),
        json={"promotions": [{"clientUuid": "01900000-0000-7000-8000-000000000403", "embryoId": embryo["id"]}]},
    )
    replay = client.post(
        "/api/v1/promotions",
        headers=headers(write_headers, 403),
        json={"promotions": [{"clientUuid": "01900000-0000-7000-8000-000000000403", "embryoId": embryo["id"]}]},
    )

    assert response.status_code == 201
    assert replay.status_code == response.status_code
    assert replay.content == response.content
    fish = response.json()["items"][0]["fish"]
    assert fish["condition"] == "ABNORMAL"
    assert fish["firstAbnormalOn"]
    assert fish["firstAbnormalAgeDays"] is not None
    assert len(client.get("/api/v1/fish").json()["items"]) == 1


def test_concurrent_promotions_allocate_unique_running_numbers(client, write_headers):
    batch, donor = create_batch(client, write_headers)
    activated = (datetime.now(UTC) - timedelta(days=6)).isoformat().replace("+00:00", "Z")
    lot = client.post(
        f"/api/v1/batches/{batch['id']}/injection-lots",
        headers=headers(write_headers, 411),
        json={"lotNo": "1", "donorCellLineId": donor["id"], "activatedAt": activated, "nActivated": 2},
    ).json()
    observations = [
        {
            "clientUuid": f"01900000-0000-7000-8000-0000000004{index + 1:02d}",
            "embryoId": embryo["id"],
            "stageCode": "stage_26_5D",
            "observedAt": (datetime.now(UTC) - timedelta(minutes=1)).isoformat(),
            "outcome": "ALIVE",
            "condition": "NORMAL",
        }
        for index, embryo in enumerate(lot["embryos"])
    ]
    observed = client.post(
        "/api/v1/observations/embryo",
        headers=headers(write_headers, 412),
        json={"observations": observations},
    )
    assert observed.status_code == 200

    def promote(index):
        return client.post(
            "/api/v1/promotions",
            headers=headers(write_headers, 420 + index),
            json={
                "promotions": [
                    {
                        "clientUuid": (f"01900000-0000-7000-8000-0000000005{index:02d}"),
                        "embryoId": lot["embryos"][index]["id"],
                    }
                ]
            },
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(promote, range(2)))

    assert [response.status_code for response in responses] == [201, 201]
    assert {response.json()["items"][0]["fish"]["runningNo"] for response in responses} == {1, 2}


def test_manual_fish_requires_reason_when_backdated_and_roll_call_tracks_write(client, write_headers):
    _batch, donor = create_batch(client, write_headers)
    old_dob = (datetime.now(UTC) - timedelta(days=3)).date().isoformat()
    invalid = client.post(
        "/api/v1/fish",
        headers=headers(write_headers, 404),
        json={"fishCode": "manual-1", "dob": old_dob, "donorCellLineId": donor["id"]},
    )
    assert invalid.status_code == 422
    fish = client.post(
        "/api/v1/fish",
        headers=headers(write_headers, 405),
        json={
            "fishCode": "manual-1",
            "dob": old_dob,
            "donorCellLineId": donor["id"],
            "overrideReason": "legacy fish",
        },
    ).json()
    assert (
        client.patch(f"/api/v1/fish/{fish['id']}", headers=headers(write_headers, 409), json={"sex": "F"}).json()["sex"]
        == "F"
    )
    assert (
        client.patch(
            f"/api/v1/fish/{fish['id']}", headers=headers(write_headers, 410), json={"sex": "FEMALE"}
        ).status_code
        == 422
    )
    today = datetime.now(BANGKOK).date().isoformat()
    observation = client.post(
        "/api/v1/observations/fish",
        headers=headers(write_headers, 406),
        json={
            "observations": [
                {
                    "clientUuid": "01900000-0000-7000-8000-000000000406",
                    "cloneFishId": fish["id"],
                    "observedOn": today,
                    "outcome": "ALIVE",
                    "condition": "NORMAL",
                }
            ]
        },
    )
    assert observation.json()["results"][0]["status"] == "created"
    roll_call = client.get(f"/api/v1/fish/roll-call?date={today}").json()["items"]
    assert roll_call[0]["alreadyRecorded"] is True


def test_specimen_can_mark_fin_clipped(client, write_headers):
    _batch, donor = create_batch(client, write_headers)
    today = datetime.now(BANGKOK).date().isoformat()
    fish = client.post(
        "/api/v1/fish",
        headers=headers(write_headers, 407),
        json={"fishCode": "manual-2", "dob": today, "donorCellLineId": donor["id"]},
    ).json()
    specimen = client.post(
        f"/api/v1/fish/{fish['id']}/specimens",
        headers=headers(write_headers, 408),
        json={
            "specimenCode": "CL1",
            "specimenKind": "CL",
            "specimenType": "CAUDAL_FIN_CLIP",
            "markFinClipped": True,
        },
    )
    assert specimen.status_code == 201
    assert client.get(f"/api/v1/fish/{fish['id']}").json()["finClipped"] is True


def test_roll_call_only_returns_alive_fish_and_validates_specimen_dates(client, write_headers):
    _batch, donor = create_batch(client, write_headers)
    today = datetime.now(BANGKOK).date().isoformat()
    fish = client.post(
        "/api/v1/fish",
        headers=headers(write_headers, 413),
        json={"fishCode": "roll-call-1", "dob": today, "donorCellLineId": donor["id"]},
    ).json()
    future_roll_call = client.get(
        f"/api/v1/fish/roll-call?date={(datetime.now(BANGKOK).date() - timedelta(days=1)).isoformat()}"
    )
    assert future_roll_call.status_code == 200
    assert future_roll_call.json()["items"] == []

    invalid = client.post(
        f"/api/v1/fish/{fish['id']}/specimens",
        headers=headers(write_headers, 414),
        json={
            "specimenCode": "date-invalid",
            "specimenKind": "CL",
            "specimenType": "CAUDAL_FIN_CLIP",
            "collectedOn": "2026-08-20",
            "frozenOn": "2026-08-19",
        },
    )
    assert invalid.status_code == 422
    assert (
        client.patch(
            f"/api/v1/fish/{fish['id']}",
            headers=headers(write_headers, 415),
            json={"status": "FROZEN"},
        ).status_code
        == 422
    )

    observation = client.post(
        "/api/v1/observations/fish",
        headers=headers(write_headers, 416),
        json={
            "observations": [
                {
                    "clientUuid": "01900000-0000-7000-8000-000000000416",
                    "cloneFishId": fish["id"],
                    "observedOn": today,
                    "outcome": "FROZEN",
                    "condition": "NORMAL",
                }
            ]
        },
    )
    assert observation.json()["results"][0]["status"] == "created"
    assert client.get(f"/api/v1/fish/roll-call?date={today}").json()["items"] == []

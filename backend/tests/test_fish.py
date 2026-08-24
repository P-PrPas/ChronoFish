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


def test_promotion_rejects_an_unknown_fish_box_without_closing_embryo(client, write_headers):
    embryo = setup_eligible_embryo(client, write_headers)
    response = client.post(
        "/api/v1/promotions",
        headers=headers(write_headers, 404),
        json={
            "promotions": [
                {
                    "clientUuid": "01900000-0000-7000-8000-000000000404",
                    "embryoId": embryo["id"],
                    "fishBoxId": "01900000-0000-7000-8000-000000009999",
                }
            ]
        },
    )

    assert response.status_code == 201
    assert response.json()["items"][0]["status"] == "rejected"
    assert [item["embryoId"] for item in client.get("/api/v1/promotions/pending").json()["items"]] == [embryo["id"]]


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
    audit_item = client.get(f"/api/v1/audit-log?table=clone_fish&recordId={fish['id']}").json()["items"][0]
    assert audit_item["newValues"]["overrideReason"] == "legacy fish"
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
    assert roll_call[0]["observationId"] == observation.json()["results"][0]["id"]
    assert roll_call[0]["recordedOutcome"] == "ALIVE"


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


def test_partial_fish_update_preserves_box_and_accepts_contract_fields(client, write_headers):
    batch, donor = create_batch(client, write_headers)
    box = client.post(
        "/api/v1/fish-boxes",
        headers=headers(write_headers, 417),
        json={"boxCode": "BOX-PARTIAL", "siteId": batch["siteId"]},
    ).json()
    today = datetime.now(BANGKOK).date().isoformat()
    fish = client.post(
        "/api/v1/fish",
        headers=headers(write_headers, 418),
        json={
            "fishCode": "partial-update",
            "dob": today,
            "donorCellLineId": donor["id"],
            "fishBoxId": box["id"],
        },
    ).json()

    updated = client.patch(
        f"/api/v1/fish/{fish['id']}",
        headers=headers(write_headers, 419),
        json={"remarks": "keep the assigned box"},
    )
    fin_clipped = client.patch(
        f"/api/v1/fish/{fish['id']}",
        headers=headers(write_headers, 420),
        json={"finClipped": True},
    )
    invalid_fin_clipped = client.patch(
        f"/api/v1/fish/{fish['id']}",
        headers=headers(write_headers, 430),
        json={"finClipped": "yes"},
    )
    blank_code = client.patch(
        f"/api/v1/fish/{fish['id']}",
        headers=headers(write_headers, 431),
        json={"fishCode": " "},
    )

    assert updated.status_code == 200, updated.text
    assert updated.json()["fishBoxId"] == box["id"]
    assert fin_clipped.status_code == 200, fin_clipped.text
    assert fin_clipped.json()["finClipped"] is True
    assert invalid_fin_clipped.status_code == 422
    assert blank_code.status_code == 422


def test_deleting_only_exit_observation_reopens_fish(client, write_headers):
    _batch, donor = create_batch(client, write_headers)
    today = datetime.now(BANGKOK).date().isoformat()
    fish = client.post(
        "/api/v1/fish",
        headers=headers(write_headers, 421),
        json={"fishCode": "reopen-after-delete", "dob": today, "donorCellLineId": donor["id"]},
    ).json()
    injected = client.post(
        "/api/v1/observations/fish",
        headers=headers(write_headers, 434),
        json={
            "observations": [
                {
                    "clientUuid": "01900000-0000-7000-8000-000000000434",
                    "cloneFishId": fish["id"],
                    "observedOn": today,
                    "outcome": "DEAD",
                    "condition": "NORMAL",
                    "deletedAt": "2026-08-24T00:00:00Z",
                }
            ]
        },
    )
    assert injected.json()["results"][0]["status"] == "rejected"
    observed = client.post(
        "/api/v1/observations/fish",
        headers=headers(write_headers, 422),
        json={
            "observations": [
                {
                    "clientUuid": "01900000-0000-7000-8000-000000000422",
                    "cloneFishId": fish["id"],
                    "observedOn": today,
                    "outcome": "DEAD",
                    "condition": "NORMAL",
                }
            ]
        },
    ).json()["results"][0]

    immutable_field = client.patch(
        f"/api/v1/observations/fish/{observed['id']}",
        headers=headers(write_headers, 432),
        json={"cloneFishId": fish["id"], "correctionReason": "must remain immutable"},
    )

    deleted = client.delete(
        f"/api/v1/observations/fish/{observed['id']}?reason=wrong-outcome",
        headers=headers(write_headers, 423),
    )
    correction_after_delete = client.patch(
        f"/api/v1/observations/fish/{observed['id']}",
        headers=headers(write_headers, 433),
        json={"outcome": "ALIVE", "correctionReason": "must not revive a deleted row"},
    )
    detail = client.get(f"/api/v1/fish/{fish['id']}").json()
    roll_call = client.get(f"/api/v1/fish/roll-call?date={today}").json()["items"]

    assert immutable_field.status_code == 422
    assert deleted.status_code == 204
    assert correction_after_delete.status_code == 404
    assert detail["status"] == "ALIVE"
    assert detail.get("exitDate") is None
    assert detail.get("exitReason") is None
    assert [item["fishId"] for item in roll_call] == [fish["id"]]


def test_backdated_range_is_recorded_and_historical_risk_set_is_queryable(client, write_headers):
    _batch, donor = create_batch(client, write_headers)
    today = datetime.now(BANGKOK).date()
    fish = client.post(
        "/api/v1/fish",
        headers=headers(write_headers, 424),
        json={
            "fishCode": "backdated-range",
            "dob": (today - timedelta(days=4)).isoformat(),
            "donorCellLineId": donor["id"],
            "overrideReason": "legacy registration",
        },
    ).json()
    dates = [(today - timedelta(days=offset)).isoformat() for offset in (3, 2, 1)]
    observations = [
        {
            "clientUuid": f"01900000-0000-7000-8000-0000000004{24 + index}",
            "cloneFishId": fish["id"],
            "observedOn": observed_on,
            "outcome": "ALIVE",
            "condition": "NORMAL",
            "overrideReason": "weekend closure",
        }
        for index, observed_on in enumerate(dates)
    ]

    saved = client.post(
        "/api/v1/observations/fish",
        headers=headers(write_headers, 428),
        json={"observations": observations},
    )
    frozen = client.post(
        "/api/v1/observations/fish",
        headers=headers(write_headers, 429),
        json={
            "observations": [
                {
                    "clientUuid": "01900000-0000-7000-8000-000000000429",
                    "cloneFishId": fish["id"],
                    "observedOn": today.isoformat(),
                    "outcome": "FROZEN",
                    "condition": "NORMAL",
                }
            ]
        },
    )

    assert saved.status_code == 200, saved.text
    assert [item["status"] for item in saved.json()["results"]] == ["created", "created", "created"]
    detail = client.get(f"/api/v1/fish/{fish['id']}").json()
    assert [item["isBackdated"] for item in detail["observations"][:3]] == [True, True, True]
    assert frozen.json()["results"][0]["status"] == "created"
    historical = client.get(f"/api/v1/fish/roll-call?date={dates[-1]}").json()["items"]
    assert [item["fishId"] for item in historical] == [fish["id"]]
    assert historical[0]["status"] == "ALIVE"
    assert client.get(f"/api/v1/fish/roll-call?date={today.isoformat()}").json()["items"] == []

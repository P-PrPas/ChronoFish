from __future__ import annotations

from datetime import UTC, datetime, timedelta

from test_experiments import create_batch, headers


def setup_embryo(client, write_headers, count=1):
    batch, donor = create_batch(client, write_headers)
    activated = (datetime.now(UTC) - timedelta(hours=10)).isoformat().replace("+00:00", "Z")
    lot = client.post(
        f"/api/v1/batches/{batch['id']}/injection-lots",
        headers=headers(write_headers, 301),
        json={"lotNo": "1", "donorCellLineId": donor["id"], "activatedAt": activated, "nActivated": count},
    ).json()
    return batch, lot, lot["embryos"][0], activated


def test_due_queue_honors_dashboard_batch_and_date_filters(client, write_headers):
    batch, lot, _embryo, _activated = setup_embryo(client, write_headers)

    matching = client.get(f"/api/v1/due-checkpoints?batchId={batch['id']}").json()
    excluded_batch = client.get("/api/v1/due-checkpoints?batchId=00000000-0000-7000-8000-000000000999").json()
    excluded_date = client.get("/api/v1/due-checkpoints?dateFrom=2999-01-01").json()

    assert any(item["injectionLotId"] == lot["id"] for item in matching["overdue"] + matching["upcoming"])
    assert excluded_batch["overdue"] + excluded_batch["upcoming"] == []
    assert excluded_date["overdue"] + excluded_date["upcoming"] == []


def test_due_and_checkpoint_read_models_track_original_and_surviving_embryos(client, write_headers):
    _batch, lot, _embryo, activated = setup_embryo(client, write_headers, count=3)
    observed = (datetime.fromisoformat(activated.replace("Z", "+00:00")) + timedelta(hours=1)).isoformat()
    first_checkpoint = client.post(
        "/api/v1/observations/embryo",
        headers=headers(write_headers, 320),
        json={
            "observations": [
                {
                    "clientUuid": f"01900000-0000-7000-8000-{320 + index:012d}",
                    "embryoId": embryo["id"],
                    "stageCode": "stage_02_2C",
                    "observedAt": observed,
                    "outcome": "DEAD" if index == 0 else "ALIVE",
                    "condition": "NORMAL",
                }
                for index, embryo in enumerate(lot["embryos"])
            ]
        },
    )
    assert first_checkpoint.status_code == 200

    entry = client.get(f"/api/v1/injection-lots/{lot['id']}/checkpoints/stage_03_4C").json()
    assert entry["totalEmbryos"] == 3
    assert entry["embryosRemaining"] == 2
    assert len(entry["embryos"]) == 3
    dead = next(item for item in entry["embryos"] if item["embryoId"] == lot["embryos"][0]["id"])
    assert (dead["isDead"], dead["priorOutcome"], dead["priorStageCode"]) == (
        True,
        "DEAD",
        "stage_02_2C",
    )
    assert {
        (item["priorOutcome"], item["priorStageCode"])
        for item in entry["embryos"]
        if not item["isDead"]
    } == {("ALIVE", "stage_02_2C")}

    second_observed = (datetime.fromisoformat(activated.replace("Z", "+00:00")) + timedelta(hours=2)).isoformat()
    second_checkpoint = client.post(
        "/api/v1/observations/embryo",
        headers=headers(write_headers, 324),
        json={
            "observations": [
                {
                    "clientUuid": f"01900000-0000-7000-8000-{324 + index:012d}",
                    "embryoId": embryo["embryoId"],
                    "stageCode": "stage_03_4C",
                    "observedAt": second_observed,
                    "outcome": "DEAD",
                    "condition": "NORMAL",
                }
                for index, embryo in enumerate(item for item in entry["embryos"] if not item["isDead"])
            ]
        },
    )
    interval = second_checkpoint.json()["results"][0]
    assert (interval["intervalActual"], interval["intervalExpected"], interval["intervalDeviationH"]) == (
        1,
        0.25,
        0.75,
    )
    due = client.get("/api/v1/due-checkpoints").json()
    assert all(item["injectionLotId"] != lot["id"] for item in due["overdue"] + due["upcoming"])


def test_dead_embryo_rejects_later_observation_even_with_override(client, write_headers):
    _batch, lot, embryo, activated = setup_embryo(client, write_headers)
    activation = datetime.fromisoformat(activated.replace("Z", "+00:00"))

    dead = client.post(
        "/api/v1/observations/embryo",
        headers=headers(write_headers, 325),
        json={
            "observations": [
                {
                    "clientUuid": "01900000-0000-7000-8000-000000000325",
                    "embryoId": embryo["id"],
                    "stageCode": "stage_02_2C",
                    "observedAt": (activation + timedelta(hours=1)).isoformat(),
                    "outcome": "DEAD",
                    "condition": "NORMAL",
                }
            ]
        },
    )
    resurrected = client.post(
        "/api/v1/observations/embryo",
        headers=headers(write_headers, 326),
        json={
            "observations": [
                {
                    "clientUuid": "01900000-0000-7000-8000-000000000326",
                    "embryoId": embryo["id"],
                    "stageCode": "stage_03_4C",
                    "observedAt": (activation + timedelta(hours=2)).isoformat(),
                    "outcome": "ALIVE",
                    "condition": "NORMAL",
                    "overrideReason": "should not resurrect a dead embryo",
                }
            ]
        },
    )

    assert dead.json()["results"][0]["status"] == "created"
    assert resurrected.json()["results"][0]["status"] == "rejected"
    assert "ตัวอ่อนตายแล้ว" in resurrected.json()["results"][0]["error"]["message"]


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
    assert result["deviationPct"] == 33.3333
    assert result["deviationLabel"] == "ช้ากว่าสากล 30 นาที"
    assert result["deviationLabelEn"] == "30 minutes slower than reference"
    assert result["isBackdated"] is True


def test_checkpoint_entry_supports_independent_embryo_stages(client, write_headers):
    _batch, lot, embryo, activated = setup_embryo(client, write_headers)
    observed = (datetime.fromisoformat(activated.replace("Z", "+00:00")) + timedelta(hours=2)).isoformat()
    response = client.post(
        "/api/v1/observations/embryo",
        headers=headers(write_headers, 352),
        json={
            "observations": [
                {
                    "clientUuid": "01900000-0000-7000-8000-000000000352",
                    "embryoId": embryo["id"],
                    "stageCode": "stage_05_16C",
                    "observedAt": observed,
                    "outcome": "ALIVE",
                    "condition": "ABNORMAL",
                }
            ]
        },
    )
    assert response.status_code == 200

    entry = client.get(f"/api/v1/injection-lots/{lot['id']}/checkpoints/stage_03_4C").json()

    assert len(entry["stages"]) == 26
    assert entry["stages"][0]["stageCode"] == "stage_01_1C"
    assert entry["embryos"][0]["priorStageCode"] == "stage_05_16C"
    assert entry["embryos"][0]["defaultCondition"] == "ABNORMAL"


def test_uat_t02_saves_all_fifteen_alive_observations(client, write_headers):
    _batch, lot, _embryo, activated = setup_embryo(client, write_headers, count=15)
    response = client.post(
        "/api/v1/observations/embryo",
        headers=headers(write_headers, 347),
        json={
            "observations": [
                {
                    "clientUuid": f"01900000-0000-7000-8000-{347 + index:012d}",
                    "embryoId": embryo["id"],
                    "stageCode": "stage_02_2C",
                    "observedAt": activated,
                    "outcome": "ALIVE",
                    "condition": "NORMAL",
                }
                for index, embryo in enumerate(lot["embryos"])
            ]
        },
    )

    assert response.status_code == 200, response.text
    assert len(response.json()["results"]) == 15
    assert {item["status"] for item in response.json()["results"]} == {"created"}


def test_uat_t04_reports_exactly_twenty_five_minutes_late(client, write_headers):
    _batch, _lot, embryo, activated = setup_embryo(client, write_headers)
    activation = datetime.fromisoformat(activated.replace("Z", "+00:00"))
    observed = (activation + timedelta(hours=1, minutes=10)).isoformat()
    result = client.post(
        "/api/v1/observations/embryo",
        headers=headers(write_headers, 363),
        json={
            "observations": [
                {
                    "clientUuid": "01900000-0000-7000-8000-000000000363",
                    "embryoId": embryo["id"],
                    "stageCode": "stage_02_2C",
                    "observedAt": observed,
                    "outcome": "ALIVE",
                    "condition": "NORMAL",
                }
            ]
        },
    ).json()["results"][0]

    assert result["hpaExpected"] == 0.75
    assert result["deviationH"] == 0.4167
    assert result["deviationLabel"] == "ช้ากว่าสากล 25 นาที"
    assert result["deviationLabelEn"] == "25 minutes slower than reference"


def test_partial_checkpoint_save_remains_due_until_every_active_embryo_is_recorded(client, write_headers):
    _batch, lot, _embryo, activated = setup_embryo(client, write_headers, count=2)

    def save(number, embryo):
        return client.post(
            "/api/v1/observations/embryo",
            headers=headers(write_headers, number),
            json={
                "observations": [
                    {
                        "clientUuid": f"01900000-0000-7000-8000-{number:012d}",
                        "embryoId": embryo["id"],
                        "stageCode": "stage_02_2C",
                        "observedAt": activated,
                        "outcome": "ALIVE",
                        "condition": "NORMAL",
                    }
                ]
            },
        )

    assert save(364, lot["embryos"][0]).status_code == 200
    partial_due = client.get("/api/v1/due-checkpoints").json()
    assert any(
        item["injectionLotId"] == lot["id"] and item["stageCode"] == "stage_02_2C"
        for item in partial_due["overdue"] + partial_due["upcoming"]
    )

    assert save(365, lot["embryos"][1]).status_code == 200
    completed_due = client.get("/api/v1/due-checkpoints").json()
    assert all(
        item["injectionLotId"] != lot["id"] or item["stageOrder"] > 2
        for item in completed_due["overdue"] + completed_due["upcoming"]
    )


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


def test_client_uuid_replayed_four_times_creates_one_audited_observation(client, write_headers):
    _batch, _lot, embryo, activated = setup_embryo(client, write_headers)
    body = {
        "observations": [
            {
                "clientUuid": "01900000-0000-7000-8000-000000000330",
                "embryoId": embryo["id"],
                "stageCode": "stage_02_2C",
                "observedAt": activated,
                "outcome": "ALIVE",
                "condition": "NORMAL",
            }
        ]
    }

    results = [
        client.post("/api/v1/observations/embryo", headers=headers(write_headers, number), json=body).json()["results"][
            0
        ]
        for number in range(330, 334)
    ]

    assert [item["status"] for item in results] == ["created", "duplicate", "duplicate", "duplicate"]
    assert len({item["id"] for item in results}) == 1
    audits = client.get(f"/api/v1/audit-log?table=embryo_observation&recordId={results[0]['id']}").json()["items"]
    assert [item["action"] for item in audits] == ["INSERT"]


def test_bulk_observation_shape_and_time_boundaries_are_enforced(client, write_headers):
    _batch, _lot, embryo, activated = setup_embryo(client, write_headers)
    assert (
        client.post(
            "/api/v1/observations/embryo", headers=headers(write_headers, 342), json={"observations": []}
        ).status_code
        == 422
    )
    too_many = [
        {
            "clientUuid": f"01900000-0000-7000-8000-{1000 + index:012d}",
            "embryoId": embryo["id"],
            "stageCode": "stage_02_2C",
            "observedAt": activated,
            "outcome": "ALIVE",
            "condition": "NORMAL",
        }
        for index in range(201)
    ]
    assert (
        client.post(
            "/api/v1/observations/embryo",
            headers=headers(write_headers, 343),
            json={"observations": too_many},
        ).status_code
        == 422
    )

    before_activation = (datetime.fromisoformat(activated.replace("Z", "+00:00")) - timedelta(seconds=1)).isoformat()
    future = (datetime.now(UTC) + timedelta(minutes=6)).isoformat()
    response = client.post(
        "/api/v1/observations/embryo",
        headers=headers(write_headers, 344),
        json={
            "observations": [
                {
                    "clientUuid": "01900000-0000-7000-8000-000000000344",
                    "embryoId": embryo["id"],
                    "stageCode": "stage_02_2C",
                    "observedAt": before_activation,
                    "outcome": "ALIVE",
                    "condition": "NORMAL",
                },
                {
                    "clientUuid": "01900000-0000-7000-8000-000000000345",
                    "embryoId": embryo["id"],
                    "stageCode": "stage_03_4C",
                    "observedAt": future,
                    "outcome": "ALIVE",
                    "condition": "NORMAL",
                },
            ]
        },
    )
    assert response.status_code == 200
    assert [item["status"] for item in response.json()["results"]] == ["rejected", "rejected"]
    assert "activatedAt" in response.json()["results"][0]["error"]["message"]
    assert "5 นาที" in response.json()["results"][1]["error"]["message"]


def test_monotonic_survival_allows_earlier_observation_but_never_later_resurrection(client, write_headers):
    _batch, lot, embryo, activated = setup_embryo(client, write_headers)
    activation = datetime.fromisoformat(activated.replace("Z", "+00:00"))

    def observe(number, stage, hours, outcome, override_reason=None):
        item = {
            "clientUuid": f"01900000-0000-7000-8000-{number:012d}",
            "embryoId": embryo["id"],
            "stageCode": stage,
            "observedAt": (activation + timedelta(hours=hours)).isoformat(),
            "outcome": outcome,
            "condition": "NORMAL",
        }
        if override_reason:
            item["overrideReason"] = override_reason
        return client.post(
            "/api/v1/observations/embryo",
            headers=headers(write_headers, number),
            json={"observations": [item]},
        ).json()["results"][0]

    assert observe(334, "stage_04_8C", 3, "DEAD")["status"] == "created"
    assert observe(335, "stage_02_2C", 1, "ALIVE")["status"] == "created"
    assert client.get(f"/api/v1/injection-lots/{lot['id']}/embryos").json()["items"][0]["exitReason"] == "DEAD"
    assert observe(336, "stage_05_16C", 4, "ALIVE")["status"] == "rejected"
    assert observe(337, "stage_05_16C", 4, "ALIVE", "death was entered on the wrong embryo")["status"] == "rejected"
    assert client.get(f"/api/v1/injection-lots/{lot['id']}/embryos").json()["items"][0]["exitReason"] == "DEAD"


def test_skipped_checkpoints_are_implied_alive_without_creating_fake_rows(client, write_headers):
    _batch, lot, embryo, activated = setup_embryo(client, write_headers)
    result = client.post(
        "/api/v1/observations/embryo",
        headers=headers(write_headers, 346),
        json={
            "observations": [
                {
                    "clientUuid": "01900000-0000-7000-8000-000000000346",
                    "embryoId": embryo["id"],
                    "stageCode": "stage_04_8C",
                    "observedAt": activated,
                    "outcome": "ALIVE",
                    "condition": "NORMAL",
                }
            ]
        },
    ).json()["results"][0]

    due = client.get("/api/v1/due-checkpoints").json()
    lot_items = [item for item in due["overdue"] + due["upcoming"] if item["injectionLotId"] == lot["id"]]
    assert lot_items and all(item["stageOrder"] > 4 for item in lot_items)
    audits = client.get(f"/api/v1/audit-log?table=embryo_observation&recordId={result['id']}").json()["items"]
    assert [item["action"] for item in audits] == ["INSERT"]


def test_correction_only_changes_public_fields_and_deleted_observations_stay_deleted(client, write_headers):
    _batch, lot, embryo, activated = setup_embryo(client, write_headers, count=2)
    created = client.post(
        "/api/v1/observations/embryo",
        headers=headers(write_headers, 338),
        json={
            "observations": [
                {
                    "clientUuid": "01900000-0000-7000-8000-000000000338",
                    "embryoId": embryo["id"],
                    "stageCode": "stage_03_4C",
                    "observedAt": activated,
                    "outcome": "DEAD",
                    "condition": "NORMAL",
                }
            ]
        },
    ).json()["results"][0]
    corrected = client.patch(
        f"/api/v1/observations/embryo/{created['id']}",
        headers=headers(write_headers, 339),
        json={
            "embryoId": lot["embryos"][1]["id"],
            "stageCode": "stage_09_256C",
            "clientUuid": "01900000-0000-7000-8000-000000000339",
            "outcome": "ALIVE",
            "condition": "ABNORMAL",
            "correctionReason": "wrong outcome",
        },
    )

    assert corrected.status_code == 200, corrected.text
    assert corrected.json()["embryoId"] == embryo["id"]
    assert corrected.json()["stageCode"] == "stage_03_4C"
    assert corrected.json()["clientUuid"] == "01900000-0000-7000-8000-000000000338"
    assert corrected.json()["outcome"] == "ALIVE"
    assert corrected.json()["hpaExpectedSnapshot"] == created["hpaExpected"]
    assert (
        client.delete(
            f"/api/v1/observations/embryo/{created['id']}?reason=remove-wrong-row",
            headers=headers(write_headers, 340),
        ).status_code
        == 204
    )
    assert (
        client.patch(
            f"/api/v1/observations/embryo/{created['id']}",
            headers=headers(write_headers, 341),
            json={"outcome": "DEAD", "correctionReason": "should not revive"},
        ).status_code
        == 404
    )
    audits = client.get(f"/api/v1/audit-log?table=embryo_observation&recordId={created['id']}").json()["items"]
    assert {item["action"] for item in audits} == {"INSERT", "UPDATE", "DELETE"}


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


def test_new_timing_version_only_applies_to_new_batches(client, write_headers):
    batch, _lot, embryo, activated = setup_embryo(client, write_headers)
    observed_at = (datetime.fromisoformat(activated.replace("Z", "+00:00")) + timedelta(hours=3)).isoformat()
    observation_body = {
        "observations": [
            {
                "clientUuid": "01900000-0000-7000-8000-000000000310",
                "embryoId": embryo["id"],
                "stageCode": "stage_09_256C",
                "observedAt": observed_at,
                "outcome": "ALIVE",
                "condition": "NORMAL",
            }
        ]
    }
    created = client.post(
        "/api/v1/observations/embryo",
        headers=headers(write_headers, 310),
        json=observation_body,
    ).json()["results"][0]
    old_profile_id = batch["timingProfileId"]

    profile_response = client.post(
        "/api/v1/timing-profiles",
        headers=headers(write_headers, 311),
        json={
            "protocolId": batch["protocolId"],
            "name": "Later 256-cell stage",
            "entries": [{"stageCode": "stage_09_256C", "expectedHpa": 2.7}],
        },
    )
    assert profile_response.status_code == 201, profile_response.text
    new_profile_id = profile_response.json()["id"]

    replayed = client.post(
        "/api/v1/observations/embryo",
        headers=headers(write_headers, 312),
        json=observation_body,
    ).json()["results"][0]
    old_batch = client.get(f"/api/v1/batches/{batch['id']}").json()
    new_batch_response = client.post(
        "/api/v1/batches",
        headers=headers(write_headers, 313),
        json={
            "experimentDate": "2026-08-21",
            "siteId": batch["siteId"],
            "operatorId": batch["operatorId"],
            "protocolId": batch["protocolId"],
            "treatmentGroupId": batch["treatmentGroupId"],
        },
    )

    assert created["hpaExpected"] == 2.5
    assert created["deviationH"] == 0.5
    assert replayed["status"] == "duplicate"
    assert replayed["hpaExpected"] == created["hpaExpected"]
    assert replayed["deviationH"] == created["deviationH"]
    assert old_batch["timingProfileId"] == old_profile_id
    assert new_batch_response.status_code == 201, new_batch_response.text
    assert new_batch_response.json()["timingProfileId"] == new_profile_id

from __future__ import annotations


def headers(base: dict[str, str], number: int) -> dict[str, str]:
    return {**base, "X-Idempotency-Key": f"01900000-0000-7000-8000-{number:012d}"}


def setup_master(client, base):
    site = client.post("/api/v1/sites", headers=headers(base, 201), json={"code": "KU", "name": "KU Lab"}).json()
    operator = client.post("/api/v1/operators", headers=headers(base, 202), json={"name": "Tech"}).json()
    donor = client.post(
        "/api/v1/donor-cell-lines",
        headers=headers(base, 203),
        json={"strain": "AB", "preparation": "CHUNKS"},
    ).json()
    treatment = client.post(
        "/api/v1/treatment-groups", headers=headers(base, 204), json={"code": "SCNT", "armType": "SCNT"}
    ).json()
    return site, operator, donor, treatment


def create_batch(client, base, number=205):
    site, operator, donor, treatment = setup_master(client, base)
    response = client.post(
        "/api/v1/batches",
        headers=headers(base, number),
        json={
            "experimentDate": "2026-08-20",
            "siteId": site["id"],
            "operatorId": operator["id"],
            "protocolId": "01900000-0000-7000-8000-000000000001",
            "treatmentGroupId": treatment["id"],
        },
    )
    assert response.status_code == 201, response.text
    return response.json(), donor


def test_batch_lot_and_embryos_are_created_atomically(client, write_headers):
    batch, donor = create_batch(client, write_headers)
    lot = client.post(
        f"/api/v1/batches/{batch['id']}/injection-lots",
        headers=headers(write_headers, 206),
        json={
            "lotNo": "June_2",
            "donorCellLineId": donor["id"],
            "activatedAt": "2026-08-20T00:00:00Z",
            "nActivated": 2,
            "wellPositions": ["A1", "A2"],
        },
    )
    assert lot.status_code == 201, lot.text
    assert [item["embryoCode"] for item in lot.json()["embryos"]] == [
        f"{batch['batchCode']}_June_2_1",
        f"{batch['batchCode']}_June_2_2",
    ]
    detail = client.get(f"/api/v1/batches/{batch['id']}").json()
    assert len(detail["injectionLots"][0]["embryos"]) == 2


def test_enu_after_activation_is_warning_not_rejection(client, write_headers):
    batch, donor = create_batch(client, write_headers)
    response = client.post(
        f"/api/v1/batches/{batch['id']}/injection-lots",
        headers=headers(write_headers, 207),
        json={
            "lotNo": "1",
            "donorCellLineId": donor["id"],
            "activatedAt": "2026-08-20T00:00:00Z",
            "enuFinishAt": "2026-08-20T08:00:01+07:00",
            "nActivated": 0,
        },
    )
    assert response.status_code == 201, response.text
    assert response.json()["warnings"]


def test_lot_rejects_fractional_counts_without_leaving_partial_data(client, write_headers):
    batch, donor = create_batch(client, write_headers)
    response = client.post(
        f"/api/v1/batches/{batch['id']}/injection-lots",
        headers=headers(write_headers, 234),
        json={
            "lotNo": "1",
            "donorCellLineId": donor["id"],
            "activatedAt": "2026-08-20T00:00:00Z",
            "nEggs": 2.5,
            "nActivated": 1.5,
        },
    )
    invalid_lot_number = client.post(
        f"/api/v1/batches/{batch['id']}/injection-lots",
        headers=headers(write_headers, 238),
        json={
            "lotNo": 1,
            "donorCellLineId": donor["id"],
            "activatedAt": "2026-08-20T00:00:00Z",
            "nActivated": 1,
        },
    )

    assert response.status_code == 422
    assert invalid_lot_number.status_code == 422
    assert client.get(f"/api/v1/batches/{batch['id']}").json()["injectionLots"] == []


def test_duplicate_batch_lot_template_can_be_activated_once(client, write_headers):
    batch, donor = create_batch(client, write_headers)
    source = client.post(
        f"/api/v1/batches/{batch['id']}/injection-lots",
        headers=headers(write_headers, 212),
        json={
            "lotNo": "1",
            "donorCellLineId": donor["id"],
            "activatedAt": "2026-08-20T00:00:00Z",
            "enuStartAt": "2026-08-19T23:00:00Z",
            "enuFinishAt": "2026-08-19T23:30:00Z",
            "nActivated": 1,
        },
    )
    assert source.status_code == 201, source.text
    duplicated = client.post(
        f"/api/v1/batches/{batch['id']}/duplicate",
        headers=headers(write_headers, 213),
        json={"experimentDate": "2026-08-21", "copyInjectionLots": True},
    )
    assert duplicated.status_code == 201, duplicated.text
    draft = client.get(f"/api/v1/batches/{duplicated.json()['id']}").json()["injectionLots"][0]
    assert draft["activatedAt"] is None
    assert draft["enuStartAt"] is None
    assert draft["enuFinishAt"] is None
    assert draft["nActivated"] == 0

    activated = client.patch(
        f"/api/v1/injection-lots/{draft['id']}",
        headers=headers(write_headers, 214),
        json={
            "activatedAt": "2026-08-21T00:00:00Z",
            "nActivated": 2,
            "wellPositions": ["A1", "A2"],
            "batchId": "must-not-change",
            "lotNo": "must-not-change",
            "deletedAt": "2026-08-21T00:00:00Z",
        },
    )
    assert activated.status_code == 200, activated.text
    assert len(activated.json()["embryos"]) == 2
    assert activated.json()["batchId"] == duplicated.json()["id"]
    assert activated.json()["lotNo"] == "1"
    assert activated.json().get("deletedAt") is None
    again = client.patch(
        f"/api/v1/injection-lots/{draft['id']}",
        headers=headers(write_headers, 215),
        json={"activatedAt": "2026-08-21T01:00:00Z", "nActivated": 1},
    )
    assert again.status_code == 409


def test_control_replacement_validates_all_rows_and_revives_soft_deleted(client, write_headers):
    batch, _donor = create_batch(client, write_headers)
    path = f"/api/v1/batches/{batch['id']}/control-arm-counts"
    first = client.put(
        path,
        headers=headers(write_headers, 208),
        json={"items": [{"armType": "IVF", "stageCode": "stage_01_1C", "nNormal": 4, "nAbnormal": 2}]},
    )
    assert first.status_code == 200
    item_id = first.json()["items"][0]["id"]
    assert client.put(path, headers=headers(write_headers, 209), json={"items": []}).status_code == 200
    revived = client.put(
        path,
        headers=headers(write_headers, 210),
        json={"items": [{"armType": "IVF", "stageCode": "stage_01_1C", "nNormal": 3, "nAbnormal": 1}]},
    )
    assert revived.json()["items"][0]["id"] == item_id
    invalid = client.put(
        path,
        headers=headers(write_headers, 211),
        json={
            "items": [
                {"armType": "IVF", "stageCode": "stage_01_1C", "nNormal": 5, "nAbnormal": 1},
                {"armType": "INVALID", "stageCode": "stage_02_2C", "nNormal": 1, "nAbnormal": 0},
            ]
        },
    )
    assert invalid.status_code == 422
    assert client.get(path).json()["items"][0]["nNormal"] == 3


def test_batches_always_pin_current_timing_and_cannot_be_rebound(client, write_headers):
    batch, _donor = create_batch(client, write_headers)
    old_profile_id = batch["timingProfileId"]
    new_profile = client.post(
        "/api/v1/timing-profiles",
        headers=headers(write_headers, 216),
        json={
            "protocolId": batch["protocolId"],
            "name": "Current for new batches",
            "entries": [{"stageCode": "stage_09_256C", "expectedHpa": 2.7}],
        },
    ).json()

    supplied_old_profile = client.post(
        "/api/v1/batches",
        headers=headers(write_headers, 217),
        json={
            "batchCode": "PIN-CURRENT",
            "experimentDate": "2026-08-21",
            "siteId": batch["siteId"],
            "operatorId": batch["operatorId"],
            "protocolId": batch["protocolId"],
            "timingProfileId": old_profile_id,
            "treatmentGroupId": batch["treatmentGroupId"],
        },
    )
    rebound = client.patch(
        f"/api/v1/batches/{batch['id']}",
        headers=headers(write_headers, 218),
        json={"timingProfileId": new_profile["id"]},
    )
    duplicated = client.post(
        f"/api/v1/batches/{batch['id']}/duplicate",
        headers=headers(write_headers, 219),
        json={"experimentDate": "2026-08-22"},
    )

    assert supplied_old_profile.status_code == 201, supplied_old_profile.text
    assert supplied_old_profile.json()["timingProfileId"] == new_profile["id"]
    assert rebound.status_code == 200, rebound.text
    assert rebound.json()["timingProfileId"] == old_profile_id
    assert duplicated.status_code == 201, duplicated.text
    assert duplicated.json()["timingProfileId"] == new_profile["id"]


def test_batch_filter_and_update_validate_the_public_contract(client, write_headers):
    batch, _donor = create_batch(client, write_headers)

    own_batches = client.get(f"/api/v1/batches?operatorId={batch['operatorId']}").json()["items"]
    other_batches = client.get("/api/v1/batches?operatorId=00000000-0000-7000-8000-000000000001").json()["items"]
    invalid_update = client.patch(
        f"/api/v1/batches/{batch['id']}",
        headers=headers(write_headers, 220),
        json={"incubationTempC": 51},
    )

    assert [item["id"] for item in own_batches] == [batch["id"]]
    assert other_batches == []
    assert invalid_update.status_code == 422
    assert client.get(f"/api/v1/batches/{batch['id']}").json().get("incubationTempC") is None


def test_batch_update_preserves_inactive_historical_references(client, write_headers):
    batch, _donor = create_batch(client, write_headers)
    assert (
        client.patch(
            f"/api/v1/sites/{batch['siteId']}",
            headers=headers(write_headers, 236),
            json={"active": False},
        ).status_code
        == 200
    )

    updated = client.patch(
        f"/api/v1/batches/{batch['id']}",
        headers=headers(write_headers, 237),
        json={"notes": "historical site retained"},
    )

    assert updated.status_code == 200, updated.text
    assert updated.json()["siteId"] == batch["siteId"]
    assert updated.json()["notes"] == "historical site retained"


def test_embryo_patch_only_changes_a_unique_valid_well(client, write_headers):
    batch, donor = create_batch(client, write_headers)
    lot = client.post(
        f"/api/v1/batches/{batch['id']}/injection-lots",
        headers=headers(write_headers, 221),
        json={
            "lotNo": "1",
            "donorCellLineId": donor["id"],
            "activatedAt": "2026-08-20T00:00:00Z",
            "nActivated": 2,
        },
    ).json()
    first, second = lot["embryos"]
    fractional_add = client.post(
        f"/api/v1/injection-lots/{lot['id']}/embryos",
        headers=headers(write_headers, 235),
        json={"count": 1.5},
    )

    assigned = client.patch(
        f"/api/v1/embryos/{first['id']}",
        headers=headers(write_headers, 222),
        json={"wellPosition": "A1", "embryoCode": "HACKED", "seqInLot": 99},
    )
    duplicate = client.patch(
        f"/api/v1/embryos/{second['id']}",
        headers=headers(write_headers, 223),
        json={"wellPosition": "A1"},
    )
    invalid = client.patch(
        f"/api/v1/embryos/{second['id']}",
        headers=headers(write_headers, 224),
        json={"wellPosition": "A13"},
    )

    assert fractional_add.status_code == 422
    assert assigned.status_code == 200, assigned.text
    assert (assigned.json()["wellPosition"], assigned.json()["embryoCode"], assigned.json()["seqInLot"]) == (
        "A1",
        first["embryoCode"],
        1,
    )
    assert duplicate.status_code == 409
    assert invalid.status_code == 422
    items = client.get(f"/api/v1/injection-lots/{lot['id']}/embryos").json()["items"]
    assert [item.get("wellPosition") for item in items] == ["A1", None]
    assert client.delete(f"/api/v1/embryos/{first['id']}", headers=headers(write_headers, 232)).status_code == 204
    reused = client.patch(
        f"/api/v1/embryos/{second['id']}",
        headers=headers(write_headers, 233),
        json={"wellPosition": "A1"},
    )
    assert reused.status_code == 200, reused.text


def test_uat_batch_three_lots_create_fifteen_embryos_without_partial_lots(client, write_headers):
    site, operator, donor, treatment = setup_master(client, write_headers)
    batch_response = client.post(
        "/api/v1/batches",
        headers=headers(write_headers, 225),
        json={
            "batchCode": "1_Jan_Control",
            "experimentDate": "2026-08-20",
            "siteId": site["id"],
            "operatorId": operator["id"],
            "protocolId": "01900000-0000-7000-8000-000000000001",
            "treatmentGroupId": treatment["id"],
        },
    )
    assert batch_response.status_code == 201, batch_response.text
    batch = batch_response.json()

    created = []
    for lot_number in range(1, 4):
        response = client.post(
            f"/api/v1/batches/{batch['id']}/injection-lots",
            headers=headers(write_headers, 225 + lot_number),
            json={
                "lotNo": str(lot_number),
                "donorCellLineId": donor["id"],
                "activatedAt": f"2026-08-20T0{lot_number}:00:00+07:00",
                "nActivated": 5,
                "wellPositions": [f"A{index}" for index in range(1, 6)],
            },
        )
        assert response.status_code == 201, response.text
        created.extend(response.json()["embryos"])

    rejected = client.post(
        f"/api/v1/batches/{batch['id']}/injection-lots",
        headers=headers(write_headers, 229),
        json={
            "lotNo": "4",
            "donorCellLineId": donor["id"],
            "activatedAt": "2026-08-20T04:00:00+07:00",
            "nActivated": 2,
            "wellPositions": ["A1", "A1"],
        },
    )

    assert len(created) == 15
    assert [item["embryoCode"] for item in created[:5]] == [f"1_Jan_Control_1_{index}" for index in range(1, 6)]
    assert rejected.status_code == 422
    detail = client.get(f"/api/v1/batches/{batch['id']}").json()
    assert len(detail["injectionLots"]) == 3
    assert sum(len(lot["embryos"]) for lot in detail["injectionLots"]) == 15


def test_control_counts_return_canonical_labels_in_deterministic_order(client, write_headers):
    batch, _donor = create_batch(client, write_headers)
    path = f"/api/v1/batches/{batch['id']}/control-arm-counts"
    saved = client.put(
        path,
        headers=headers(write_headers, 230),
        json={
            "items": [
                {"armType": "NATURAL_BREEDING", "stageCode": "stage_22_1D", "nNormal": 4, "nAbnormal": 1},
                {"armType": "IVF", "stageCode": "stage_19_SH", "nNormal": 3, "nAbnormal": 2},
            ]
        },
    )
    invalid = client.put(
        path,
        headers=headers(write_headers, 231),
        json={"items": [{"armType": "IVF", "stageCode": "stage_19_SH", "nNormal": True, "nAbnormal": 0}]},
    )

    assert saved.status_code == 200, saved.text
    assert [(item["stageCode"], item["stageLabel"]) for item in saved.json()["items"]] == [
        ("stage_19_SH", "Shield"),
        ("stage_22_1D", "Day 1"),
    ]
    assert invalid.status_code == 422
    assert client.get(path).json()["items"] == saved.json()["items"]

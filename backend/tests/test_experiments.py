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

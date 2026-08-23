from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from chronofish.app import create_app
from chronofish.config import Config
from chronofish.domain.state import DEMO_OPERATOR_ID, PROTOCOL_ID
from chronofish.runtime.values import uuid7
from chronofish.store.sql import SQLStore

DRIVER = os.getenv("CHRONOFISH_TEST_DATABASE_DRIVER")
DATABASE_URL = os.getenv("CHRONOFISH_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DRIVER or not DATABASE_URL, reason="integration database is not configured")


def _config() -> Config:
    return Config(
        8080,
        "test",
        str(DRIVER),
        str(DATABASE_URL),
        (),
        (),
        Path(__file__).parents[1] / "db" / "migrations" / str(DRIVER),
        3,
        1,
    )


def _headers() -> dict[str, str]:
    return {
        "X-Operator-Id": DEMO_OPERATOR_ID,
        "X-Device-Id": "pytest-sql",
        "X-Idempotency-Key": uuid7(),
    }


def test_sql_store_persists_workflow_idempotency_and_audit_across_instances():
    suffix = uuid7().split("-")[0]
    first_store = SQLStore(_config())
    first = TestClient(create_app(_config(), first_store))
    site_headers = _headers()
    site_body = {"code": f"SQL-{suffix}", "name": f"SQL site {suffix}"}
    site_response = first.post("/api/v1/sites", headers=site_headers, json=site_body)
    assert site_response.status_code == 201, site_response.text
    duplicate_site = first.post("/api/v1/sites", headers=site_headers, json=site_body)
    assert duplicate_site.status_code == 200
    assert duplicate_site.content == site_response.content
    site = site_response.json()
    donor = first.post(
        "/api/v1/donor-cell-lines",
        headers=_headers(),
        json={"strain": f"strain-{suffix}", "preparation": "DISSOCIATED"},
    ).json()
    treatment = first.post(
        "/api/v1/treatment-groups",
        headers=_headers(),
        json={"code": f"T-{suffix}", "name": "SQL treatment", "armType": "SCNT"},
    ).json()
    batch_response = first.post(
        "/api/v1/batches",
        headers=_headers(),
        json={
            "batchCode": f"B-{suffix}",
            "experimentDate": datetime.now(UTC).date().isoformat(),
            "siteId": site["id"],
            "operatorId": DEMO_OPERATOR_ID,
            "protocolId": PROTOCOL_ID,
            "treatmentGroupId": treatment["id"],
        },
    )
    assert batch_response.status_code == 201, batch_response.text
    activated = (datetime.now(UTC) - timedelta(hours=2)).isoformat().replace("+00:00", "Z")
    lot_response = first.post(
        f"/api/v1/batches/{batch_response.json()['id']}/injection-lots",
        headers=_headers(),
        json={"lotNo": "1", "donorCellLineId": donor["id"], "activatedAt": activated, "nActivated": 1},
    )
    assert lot_response.status_code == 201, lot_response.text
    embryo = lot_response.json()["embryos"][0]
    observation = first.post(
        "/api/v1/observations/embryo",
        headers=_headers(),
        json={
            "observations": [
                {
                    "clientUuid": uuid7(),
                    "embryoId": embryo["id"],
                    "stageCode": "stage_05_16C",
                    "observedAt": datetime.now(UTC).isoformat(),
                    "outcome": "ALIVE",
                    "condition": "NORMAL",
                }
            ]
        },
    )
    assert observation.status_code == 200, observation.text
    duplicated = first.post(
        f"/api/v1/batches/{batch_response.json()['id']}/duplicate",
        headers=_headers(),
        json={"experimentDate": datetime.now(UTC).date().isoformat(), "copyInjectionLots": True},
    )
    assert duplicated.status_code == 201, duplicated.text
    duplicated_id = duplicated.json()["id"]
    first_store.close()

    second_store = SQLStore(_config())
    second = TestClient(create_app(_config(), second_store))
    sites = second.get("/api/v1/sites").json()["items"]
    assert sum(item["id"] == site["id"] for item in sites) == 1
    embryos = second.get(f"/api/v1/injection-lots/{lot_response.json()['id']}/embryos").json()["items"]
    assert embryos[0]["id"] == embryo["id"]
    draft = second.get(f"/api/v1/batches/{duplicated_id}").json()["injectionLots"][0]
    assert draft["activatedAt"] is None
    activated_template = second.patch(
        f"/api/v1/injection-lots/{draft['id']}",
        headers=_headers(),
        json={"activatedAt": activated, "nActivated": 1},
    )
    assert activated_template.status_code == 200, activated_template.text
    assert len(activated_template.json()["embryos"]) == 1
    audits = second.get(f"/api/v1/audit-log?recordId={site['id']}").json()["items"]
    assert audits and audits[0]["action"] == "INSERT"
    second_store.close()


def test_concurrent_timing_versions_are_serialized_with_one_current_profile():
    store = SQLStore(_config())
    client = TestClient(create_app(_config(), store))

    def create_profile(expected_hpa: float):
        return client.post(
            "/api/v1/timing-profiles",
            headers=_headers(),
            json={
                "protocolId": PROTOCOL_ID,
                "name": f"Concurrent {expected_hpa}",
                "entries": [{"stageCode": "stage_02_2C", "expectedHpa": expected_hpa}],
            },
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(create_profile, (0.81, 0.82)))

    assert [response.status_code for response in responses] == [201, 201]
    versions = sorted(response.json()["version"] for response in responses)
    assert versions[1] == versions[0] + 1
    profiles = client.get(f"/api/v1/timing-profiles?protocolId={PROTOCOL_ID}").json()["items"]
    assert sum(profile["isCurrent"] for profile in profiles) == 1
    assert profiles[0]["version"] == versions[1]
    store.close()


def test_concurrent_batch_codes_and_live_wells_remain_unique():
    suffix = uuid7().split("-")[0]
    store = SQLStore(_config())
    client = TestClient(create_app(_config(), store))
    site = client.post(
        "/api/v1/sites", headers=_headers(), json={"code": f"W-{suffix}", "name": f"Well site {suffix}"}
    ).json()
    operator = client.post("/api/v1/operators", headers=_headers(), json={"name": f"Well tech {suffix}"}).json()
    donor = client.post(
        "/api/v1/donor-cell-lines",
        headers=_headers(),
        json={"strain": f"well-{suffix}", "preparation": "CHUNKS"},
    ).json()
    treatment = client.post(
        "/api/v1/treatment-groups",
        headers=_headers(),
        json={"code": f"W-{suffix}", "name": "Well test", "armType": "SCNT"},
    ).json()
    batch_body = {
        "batchCode": f"CONCURRENT-{suffix}",
        "experimentDate": datetime.now(UTC).date().isoformat(),
        "siteId": site["id"],
        "operatorId": operator["id"],
        "protocolId": PROTOCOL_ID,
        "treatmentGroupId": treatment["id"],
    }

    def create_batch():
        return client.post("/api/v1/batches", headers=_headers(), json=batch_body)

    with ThreadPoolExecutor(max_workers=2) as executor:
        batch_responses = list(executor.map(lambda _index: create_batch(), range(2)))

    assert sorted(response.status_code for response in batch_responses) == [201, 409]
    batch = next(response.json() for response in batch_responses if response.status_code == 201)
    lot = client.post(
        f"/api/v1/batches/{batch['id']}/injection-lots",
        headers=_headers(),
        json={
            "lotNo": "1",
            "donorCellLineId": donor["id"],
            "activatedAt": (datetime.now(UTC) - timedelta(minutes=1)).isoformat(),
            "nActivated": 2,
        },
    ).json()

    def claim_well(embryo_id: str):
        return client.patch(f"/api/v1/embryos/{embryo_id}", headers=_headers(), json={"wellPosition": "A1"})

    with ThreadPoolExecutor(max_workers=2) as executor:
        well_responses = list(executor.map(claim_well, [item["id"] for item in lot["embryos"]]))

    assert sorted(response.status_code for response in well_responses) == [200, 409]
    embryos = client.get(f"/api/v1/injection-lots/{lot['id']}/embryos").json()["items"]
    assert sum(item.get("wellPosition") == "A1" for item in embryos) == 1
    store.close()


def test_concurrent_observation_save_correction_and_soft_delete_are_consistent():
    suffix = uuid7().split("-")[0]
    store = SQLStore(_config())
    client = TestClient(create_app(_config(), store))
    site = client.post(
        "/api/v1/sites", headers=_headers(), json={"code": f"O-{suffix}", "name": f"Observation site {suffix}"}
    ).json()
    donor = client.post(
        "/api/v1/donor-cell-lines",
        headers=_headers(),
        json={"strain": f"observation-{suffix}", "preparation": "CHUNKS"},
    ).json()
    treatment = client.post(
        "/api/v1/treatment-groups",
        headers=_headers(),
        json={"code": f"O-{suffix}", "name": "Observation test", "armType": "SCNT"},
    ).json()
    batch = client.post(
        "/api/v1/batches",
        headers=_headers(),
        json={
            "batchCode": f"OBS-{suffix}",
            "experimentDate": datetime.now(UTC).date().isoformat(),
            "siteId": site["id"],
            "operatorId": DEMO_OPERATOR_ID,
            "protocolId": PROTOCOL_ID,
            "treatmentGroupId": treatment["id"],
        },
    ).json()
    activated = (datetime.now(UTC) - timedelta(hours=2)).isoformat()
    embryo = client.post(
        f"/api/v1/batches/{batch['id']}/injection-lots",
        headers=_headers(),
        json={"lotNo": "1", "donorCellLineId": donor["id"], "activatedAt": activated, "nActivated": 1},
    ).json()["embryos"][0]

    def observe(_index: int):
        return client.post(
            "/api/v1/observations/embryo",
            headers=_headers(),
            json={
                "observations": [
                    {
                        "clientUuid": uuid7(),
                        "embryoId": embryo["id"],
                        "stageCode": "stage_02_2C",
                        "observedAt": datetime.now(UTC).isoformat(),
                        "outcome": "ALIVE",
                        "condition": "NORMAL",
                    }
                ]
            },
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(observe, range(2)))

    assert [response.status_code for response in responses] == [200, 200]
    results = [response.json()["results"][0] for response in responses]
    assert sorted(item["status"] for item in results) == ["created", "duplicate"]
    assert len({item["id"] for item in results}) == 1
    observation_id = results[0]["id"]
    corrected = client.patch(
        f"/api/v1/observations/embryo/{observation_id}",
        headers=_headers(),
        json={"condition": "ABNORMAL", "correctionReason": "microscope review"},
    )
    assert corrected.status_code == 200, corrected.text
    assert (
        client.delete(
            f"/api/v1/observations/embryo/{observation_id}?reason=duplicate-lab-entry", headers=_headers()
        ).status_code
        == 204
    )
    audits = client.get(f"/api/v1/audit-log?table=embryo_observation&recordId={observation_id}").json()["items"]
    assert {item["action"] for item in audits} == {"INSERT", "UPDATE", "DELETE"}
    store.close()

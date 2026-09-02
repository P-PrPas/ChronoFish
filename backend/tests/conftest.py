from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient

from chronofish.app import create_app
from chronofish.config import Config
from chronofish.store import MemoryStore


@pytest.fixture
def store() -> MemoryStore:
    return MemoryStore()


@pytest.fixture
def client(store: MemoryStore) -> TestClient:
    config = Config(8080, "test", "memory", "", (), (), __import__("pathlib").Path("."), 10, 5)
    return TestClient(create_app(config, store))


@pytest.fixture
def write_headers() -> dict[str, str]:
    return {
        "X-Operator-Id": "00000000-0000-7000-8000-000000000001",
        "X-Device-Id": "pytest",
        "X-Idempotency-Key": "01900000-0000-7000-8000-000000000099",
    }


@pytest.fixture
def unique_key() -> Callable[[], str]:
    number = 1_000

    def next_key() -> str:
        nonlocal number
        number += 1
        return f"01900000-0000-7000-8000-{number:012d}"

    return next_key


@pytest.fixture
def master_data(client: TestClient, write_headers: dict[str, str], unique_key: Callable[[], str]) -> dict[str, Any]:
    def create(path: str, body: dict[str, Any]) -> dict[str, Any]:
        response = client.post(path, headers={**write_headers, "X-Idempotency-Key": unique_key()}, json=body)
        assert response.status_code == 201, response.text
        return response.json()

    site = create("/api/v1/sites", {"code": "KU", "name": "KU Lab"})
    donor = create("/api/v1/donor-cell-lines", {"strain": "AB", "preparation": "CHUNKS"})
    treatment = create("/api/v1/treatment-groups", {"code": "SCNT", "armType": "SCNT"})
    return {
        "site": site,
        "operator": store_operator(client),
        "donor": donor,
        "treatment": treatment,
        "fish_box": create("/api/v1/fish-boxes", {"boxCode": "A-01", "siteId": site["id"]}),
        "recipient_egg_lot": create("/api/v1/recipient-egg-lots", {"breed": "AB", "label": "REC-1"}),
        "csof_lot": create("/api/v1/csof-lots", {"lotCode": "CSOF-1"}),
    }


def store_operator(client: TestClient) -> dict[str, Any]:
    return client.get("/api/v1/operators").json()["items"][0]


@pytest.fixture
def fixed_clock(monkeypatch: pytest.MonkeyPatch) -> datetime:
    value = datetime(2026, 9, 2, 12, tzinfo=UTC)
    from chronofish.api.routes import fish, observations
    from chronofish.runtime import values

    monkeypatch.setattr(values, "utc_now", lambda: value)
    monkeypatch.setattr(observations, "utc_now", lambda: value)
    monkeypatch.setattr(fish, "utc_now", lambda: value)
    return value

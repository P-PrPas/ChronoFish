from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from chronofish.app import create_app
from chronofish.config import Config
from chronofish.core import MemoryStore


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

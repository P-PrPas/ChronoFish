from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pytest
from starlette.requests import Request

from chronofish.runtime.errors import APIError
from chronofish.store.memory import MemoryStore


def mutation_request(key: int) -> Request:
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/v1/sites",
            "query_string": b"",
            "headers": [
                (b"x-operator-id", b"00000000-0000-7000-8000-000000000001"),
                (b"x-device-id", b"pytest"),
                (b"x-idempotency-key", f"01900000-0000-7000-8000-{key:012d}".encode()),
            ],
        }
    )


def test_snapshot_is_an_isolated_deep_copy():
    store = MemoryStore()
    snapshot = store.snapshot()
    snapshot.entities["operators"]["00000000-0000-7000-8000-000000000001"]["name"] = "Changed"

    assert store.snapshot().entities["operators"]["00000000-0000-7000-8000-000000000001"]["name"] == "Demo operator"


def test_failed_mutation_leaves_state_untouched():
    store = MemoryStore()

    def fail(state):
        state.entities["sites"]["site"] = {"id": "site"}
        raise APIError(422, "validation_error", "no partial writes")

    with pytest.raises(APIError):
        store.execute_mutation(mutation_request(1), {}, fail)
    assert store.snapshot().entities["sites"] == {}


def test_successful_mutation_commits_working_copy_atomically():
    store = MemoryStore()

    def save(state):
        state.entities["sites"]["site"] = {"id": "site"}
        state.entities["fish-boxes"]["box"] = {"id": "box"}
        return 201, {"id": "site"}

    assert store.execute_mutation(mutation_request(2), {}, save).status_code == 201
    snapshot = store.snapshot()
    assert set(snapshot.entities["sites"]) == {"site"}
    assert set(snapshot.entities["fish-boxes"]) == {"box"}


def test_idempotency_cache_stores_status_media_type_and_body():
    store = MemoryStore()

    def csv(_state):
        return 200, b"a,b", "text/csv"

    first = store.execute_mutation(mutation_request(3), {}, csv)
    replay = store.execute_mutation(mutation_request(3), {}, csv)
    assert (first.status_code, first.headers["content-type"], first.body) == (200, "text/csv; charset=utf-8", b"a,b")
    assert (replay.status_code, replay.headers["content-type"], replay.body) == (200, "text/csv; charset=utf-8", b"a,b")


def test_concurrent_mutations_are_serialized_by_the_lock():
    store = MemoryStore()

    def mutate(index: int) -> int:
        def save(state):
            state.entities["sites"][str(index)] = {"id": str(index)}
            return 201, {"id": str(index)}

        return store.execute_mutation(mutation_request(index + 10), {"id": index}, save).status_code

    with ThreadPoolExecutor(max_workers=8) as pool:
        assert list(pool.map(mutate, range(8))) == [201] * 8
    assert len(store.snapshot().entities["sites"]) == 8

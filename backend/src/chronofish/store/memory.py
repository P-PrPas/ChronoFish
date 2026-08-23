from __future__ import annotations

import copy
import threading
from dataclasses import dataclass
from typing import Any

from fastapi import Request
from fastapi.responses import Response

from ..domain.state import State
from ..runtime.errors import APIError
from ..runtime.mutations import encode_result, request_fingerprint, validate_write_context
from .base import Mutation


@dataclass(slots=True)
class StoredResponse:
    request_hash: str
    status: int
    content_type: str
    body: bytes


class MemoryStore:
    """Development/test adapter. Production uses SQLStore."""

    def __init__(self) -> None:
        self.state = State.seeded()
        self.idempotency: dict[str, StoredResponse] = {}
        self.lock = threading.RLock()

    def snapshot(self) -> State:
        with self.lock:
            return copy.deepcopy(self.state)

    def execute_mutation(self, request: Request, body: Any, operation: Mutation) -> Response:
        with self.lock:
            _operator, _device, key = validate_write_context(request, self.state)
            scope, request_hash = request_fingerprint(request, body)
            scope = f"{scope}:{key}"
            previous = self.idempotency.get(scope)
            if previous:
                if previous.request_hash != request_hash:
                    raise APIError(409, "idempotency_conflict", "X-Idempotency-Key ถูกใช้กับ request อื่นแล้ว")
                return Response(previous.body, previous.status, media_type=previous.content_type)
            working = copy.deepcopy(self.state)
            status, media_type, encoded = encode_result(operation(working))
            self.idempotency[scope] = StoredResponse(request_hash, status, media_type, encoded)
            self.state = working
            return Response(encoded, status, media_type=media_type)

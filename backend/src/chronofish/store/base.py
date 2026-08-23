from __future__ import annotations

from collections.abc import Callable
from typing import Any, Protocol

from fastapi import Request
from fastapi.responses import Response

from ..domain.state import State

Mutation = Callable[[State], tuple[int, Any] | tuple[int, Any, str]]


class Store(Protocol):
    def snapshot(self) -> State: ...

    def execute_mutation(self, request: Request, body: Any, operation: Mutation) -> Response: ...

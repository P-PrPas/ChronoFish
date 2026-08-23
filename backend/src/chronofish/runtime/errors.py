from __future__ import annotations

from typing import Any

from fastapi.responses import JSONResponse


class APIError(Exception):
    def __init__(self, status: int, code: str, message: str, details: Any = None):
        super().__init__(message)
        self.status, self.code, self.message, self.details = status, code, message, details


def error_response(error: APIError) -> JSONResponse:
    body = {"error": {"code": error.code, "message": error.message}}
    if error.details is not None:
        body["error"]["details"] = error.details
    return JSONResponse(body, status_code=error.status, media_type="application/json; charset=utf-8")

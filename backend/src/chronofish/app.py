from __future__ import annotations

import ipaddress
import logging
import time
from collections import defaultdict, deque

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import __version__
from .api.analytics import build_analytics_router
from .api.audit import build_audit_router
from .api.experiments import build_experiments_router
from .api.exports import build_export_router
from .api.fish import build_fish_router
from .api.master import build_master_router
from .api.observations import build_observations_router
from .api.timing import build_timing_router
from .config import Config, load_config
from .core import APIError, MemoryStore, error_response

LOGGER = logging.getLogger("chronofish.http")
MAX_REQUEST_BYTES = 10 * 1024 * 1024


def create_app(config: Config | None = None, store: MemoryStore | None = None) -> FastAPI:
    config = config or load_config()
    if store is None:
        if config.db_driver != "memory":
            from .store.sql import SQLStore

            store = SQLStore(config)
        else:
            store = MemoryStore()
    app = FastAPI(title="ChronoFish API", version=__version__, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.store = store
    if close_store := getattr(store, "close", None):
        app.router.add_event_handler("shutdown", close_store)
    if config.allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(config.allowed_origins),
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
            allow_headers=["Content-Type", "X-Operator-Id", "X-Device-Id", "X-Idempotency-Key"],
        )

    hits: defaultdict[str, deque[float]] = defaultdict(deque)

    @app.middleware("http")
    async def security(request: Request, call_next):
        started = time.monotonic()
        host = request.client.host if request.client else "127.0.0.1"
        if config.ip_allowlist:
            try:
                address = ipaddress.ip_address(host)
            except ValueError:
                return error_response(APIError(403, "network_denied", "เครือข่ายนี้ไม่ได้รับอนุญาต"))
            if not any(address in network for network in config.ip_allowlist):
                return error_response(APIError(403, "network_denied", "เครือข่ายนี้ไม่ได้รับอนุญาต"))
        now, bucket = time.monotonic(), hits[host]
        while bucket and now - bucket[0] >= 60:
            bucket.popleft()
        if len(bucket) >= 120:
            response = error_response(APIError(429, "rate_limited", "เรียก API ถี่เกินไป กรุณาลองใหม่ภายหลัง"))
            response.headers["Retry-After"] = "60"
            return response
        bucket.append(now)
        try:
            content_length = int(request.headers.get("content-length", "0") or 0)
        except ValueError:
            return error_response(APIError(400, "invalid_request", "Content-Length is invalid"))
        if content_length > MAX_REQUEST_BYTES:
            return error_response(APIError(413, "request_too_large", "request body is too large"))
        media_type = request.headers.get("content-type", "").partition(";")[0].strip().lower()
        expected_media_type = "text/csv" if request.url.path == "/api/v1/timing-profiles/csv" else "application/json"
        if (request.method in {"POST", "PUT", "PATCH"} or content_length) and media_type != expected_media_type:
            return error_response(APIError(400, "invalid_request", f"Content-Type must be {expected_media_type}"))
        try:
            response = await call_next(request)
        except APIError as error:
            response = error_response(error)
        except Exception:
            LOGGER.exception("unhandled API error method=%s path=%s", request.method, request.url.path)
            response = error_response(APIError(500, "internal_error", "an unexpected error occurred"))
        LOGGER.info(
            "request method=%s path=%s status=%s duration_ms=%d",
            request.method,
            request.url.path,
            response.status_code,
            (time.monotonic() - started) * 1000,
        )
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        if response.headers.get("content-type", "").partition(";")[0].lower() == "application/json":
            response.headers["Content-Type"] = "application/json; charset=utf-8"
        return response

    @app.get("/api/v1/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "version": __version__}

    app.include_router(build_master_router(store))
    app.include_router(build_timing_router(store))
    app.include_router(build_experiments_router(store))
    app.include_router(build_observations_router(store))
    app.include_router(build_fish_router(store))
    app.include_router(build_analytics_router(store))
    app.include_router(build_export_router(store))
    app.include_router(build_audit_router(store))

    @app.exception_handler(APIError)
    async def handle_api_error(_request: Request, error: APIError) -> JSONResponse:
        return error_response(error)

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(_request: Request, _error: RequestValidationError) -> JSONResponse:
        return error_response(APIError(400, "invalid_request", "request is invalid"))

    return app

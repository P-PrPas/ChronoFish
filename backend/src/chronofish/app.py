from __future__ import annotations

import ipaddress
import time
from collections import defaultdict, deque

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import __version__
from .api.master import build_master_router
from .api.timing import build_timing_router
from .config import Config, load_config
from .core import APIError, MemoryStore, error_response


def create_app(config: Config | None = None, store: MemoryStore | None = None) -> FastAPI:
    config = config or load_config()
    if config.db_driver != "memory":
        from .store.sql import SQLStore

        store = SQLStore(config)
    store = store or MemoryStore()
    app = FastAPI(title="ChronoFish API", version=__version__, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.store = store
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
            response = await call_next(request)
        except APIError as error:
            response = error_response(error)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.get("/api/v1/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "version": __version__}

    app.include_router(build_master_router(store))
    app.include_router(build_timing_router(store))

    @app.exception_handler(APIError)
    async def handle_api_error(_request: Request, error: APIError) -> JSONResponse:
        return error_response(error)

    return app

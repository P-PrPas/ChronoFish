from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query, Request

from ...services.analytics import ANALYTICS_FILTER_KEYS, Analytics
from ...store import Store


def query_dict(request: Request) -> dict[str, str]:
    return {key: value for key in ANALYTICS_FILTER_KEYS if (value := request.query_params.get(key))}


def build_analytics_router(store: Store) -> APIRouter:
    router = APIRouter(prefix="/api/v1/analytics")

    def service(request: Request) -> Analytics:
        return Analytics(store.snapshot(), query_dict(request))

    @router.get("/dashboard")
    def dashboard(
        request: Request,
        stage1GroupBy: Annotated[list[str] | None, Query()] = None,
        stage2GroupBy: Annotated[list[str] | None, Query()] = None,
    ) -> dict[str, Any]:
        return service(request).dashboard(stage1GroupBy, stage2GroupBy)

    @router.get("/kpi")
    def kpi(request: Request) -> dict[str, Any]:
        return service(request).kpi()

    @router.get("/funnel")
    def funnel(request: Request) -> dict[str, Any]:
        return service(request).funnel()

    @router.get("/survival")
    def survival(
        request: Request,
        groupBy: Annotated[list[str] | None, Query()] = None,
    ) -> dict[str, Any]:
        return service(request).survival(groupBy)

    @router.get("/timing-deviation")
    def timing_deviation(
        request: Request,
        groupBy: Annotated[list[str] | None, Query()] = None,
    ) -> dict[str, Any]:
        return service(request).timing_deviation(groupBy)

    @router.get("/abnormality-onset")
    def abnormality_onset(request: Request) -> dict[str, Any]:
        return service(request).abnormality_onset()

    @router.get("/fish-survival")
    def fish_survival(
        request: Request,
        splitByCondition: bool = False,
        groupBy: Annotated[list[str] | None, Query()] = None,
    ) -> dict[str, Any]:
        return service(request).fish_survival(splitByCondition, groupBy)

    @router.get("/observation-gaps")
    def observation_gaps(request: Request) -> dict[str, Any]:
        return service(request).observation_gaps()

    @router.get("/pipeline")
    def pipeline(request: Request) -> dict[str, Any]:
        return service(request).pipeline()

    return router

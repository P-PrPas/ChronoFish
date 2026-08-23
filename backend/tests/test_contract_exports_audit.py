from __future__ import annotations

import csv
from io import BytesIO, StringIO
from pathlib import Path
from zipfile import ZipFile

import yaml
from test_observations import setup_embryo


def test_fastapi_registers_every_openapi_operation(client):
    document = yaml.safe_load((Path(__file__).parents[2] / "api" / "openapi.yaml").read_text(encoding="utf-8"))
    expected = {
        (method.upper(), f"/api/v1{path}")
        for path, operations in document["paths"].items()
        for method in operations
        if method in {"get", "post", "put", "patch", "delete"}
    }
    actual = {
        (method, route.path)
        for route in client.app.routes
        for method in getattr(route, "methods", set())
        if method in {"GET", "POST", "PUT", "PATCH", "DELETE"}
    }
    assert expected <= actual
    assert len(expected) == 70


def test_r_export_has_stable_30_column_shape(client):
    response = client.get("/api/v1/exports/r-table")
    assert response.status_code == 200
    header = next(csv.reader(StringIO(response.content.decode("utf-8-sig"))))
    assert header[:4] == ["Sites", "Strain", "Replicate", "Strain_Rep"]
    assert len(header) == 30


def test_excel_export_is_idempotent_valid_14_sheet_xlsx(client, write_headers):
    setup_embryo(client, write_headers)
    first = client.post("/api/v1/exports/excel", headers=write_headers, json={"filters": {}})
    second = client.post("/api/v1/exports/excel", headers=write_headers, json={"filters": {}})
    assert first.status_code == 200
    assert second.content == first.content
    with ZipFile(BytesIO(first.content)) as archive:
        worksheet_names = [name for name in archive.namelist() if name.startswith("xl/worksheets/sheet")]
        workbook = archive.read("xl/workbook.xml").decode()
        batch_sheet = archive.read("xl/worksheets/sheet2.xml").decode()
        embryo_matrix = archive.read("xl/worksheets/sheet4.xml").decode()
        r_table = archive.read("xl/worksheets/sheet13.xml").decode()
    assert len(worksheet_names) == 14
    assert "00_Metadata" in workbook
    assert "13_Stage_Timing_Reference" in workbook
    assert '<row r="2">' in batch_sheet
    assert '<row r="2">' in embryo_matrix
    assert '<row r="2">' in r_table


def test_audit_filters_and_uses_opaque_cursor(client, write_headers):
    for index in range(3):
        headers = {**write_headers, "X-Idempotency-Key": f"01900000-0000-7000-8000-{index + 200:012d}"}
        assert (
            client.post(
                "/api/v1/sites", headers=headers, json={"code": f"S{index}", "name": f"Site {index}"}
            ).status_code
            == 201
        )
    first = client.get("/api/v1/audit-log?table=sites&limit=2").json()
    assert len(first["items"]) == 2
    assert first["nextCursor"]
    second = client.get(f"/api/v1/audit-log?table=sites&limit=2&cursor={first['nextCursor']}").json()
    assert len(second["items"]) == 1
    assert {item["id"] for item in first["items"]}.isdisjoint(item["id"] for item in second["items"])

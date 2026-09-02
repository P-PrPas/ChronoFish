from __future__ import annotations

import csv
import re
from datetime import datetime
from io import BytesIO, StringIO
from pathlib import Path
from xml.etree import ElementTree
from zipfile import ZipFile

import yaml
from test_experiments import headers
from test_fish import BANGKOK
from test_observations import setup_embryo

from chronofish.reporting.xlsx import build_xlsx


def worksheet_rows(xml: bytes) -> list[list[str]]:
    root = ElementTree.fromstring(xml)
    namespace = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    return [
        [
            (
                cell.findtext(".//x:t", default="", namespaces=namespace)
                if cell.get("t") == "inlineStr"
                else cell.findtext("x:v", default="", namespaces=namespace)
            )
            for cell in row.findall("x:c", namespace)
        ]
        for row in root.findall(".//x:row", namespace)
    ]


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
    assert len(expected) == 71


def test_r_export_has_stable_30_column_shape(client):
    response = client.get("/api/v1/exports/r-table")
    assert response.status_code == 200
    assert response.headers["content-disposition"] == 'attachment; filename="kuvth-zebrafish-lims-r-table.csv"'
    header = next(csv.reader(StringIO(response.content.decode("utf-8-sig"))))
    assert header[:4] == ["Sites", "Strain", "Replicate", "Strain_Rep"]
    assert len(header) == 30


def test_excel_export_is_read_only_valid_14_sheet_xlsx(client, store, write_headers):
    _batch, lot, _embryo, _activated = setup_embryo(client, write_headers)
    manual = client.post(
        "/api/v1/fish",
        headers=headers(write_headers, 450),
        json={
            "fishCode": "manual-export",
            "dob": datetime.now(BANGKOK).date().isoformat(),
            "donorCellLineId": lot["donorCellLineId"],
        },
    )
    assert manual.status_code == 201, manual.text
    idempotency_before_export = set(store.idempotency)

    response = client.post("/api/v1/exports/excel", json={"filters": {}})
    assert response.status_code == 200
    assert response.headers["content-disposition"] == 'attachment; filename="kuvth-zebrafish-lims-export.xlsx"'
    assert set(store.idempotency) == idempotency_before_export
    with ZipFile(BytesIO(response.content)) as archive:
        worksheet_names = [name for name in archive.namelist() if name.startswith("xl/worksheets/sheet")]
        workbook = archive.read("xl/workbook.xml").decode()
        metadata = archive.read("xl/worksheets/sheet1.xml").decode()
        batch_sheet = archive.read("xl/worksheets/sheet2.xml").decode()
        embryo_matrix = archive.read("xl/worksheets/sheet4.xml").decode()
        stage_counts = archive.read("xl/worksheets/sheet5.xml").decode()
        summary = worksheet_rows(archive.read("xl/worksheets/sheet12.xml"))
        r_table = archive.read("xl/worksheets/sheet13.xml").decode()
        timing = worksheet_rows(archive.read("xl/worksheets/sheet14.xml"))
    assert len(worksheet_names) == 14
    assert re.findall(r'<sheet name="([^"]+)"', workbook) == [
        "00_Metadata",
        "01_Batches",
        "02_Embryo_Observations",
        "03_Embryo_Matrix",
        "04_Stage_Counts",
        "05_Timing_Deviation",
        "06_Fish_Register",
        "07_Fish_Observations",
        "08_Fish_Matrix",
        "09_Control_Arms",
        "10_Specimens",
        "11_Summary",
        "12_R_Analysis_Table",
        "13_Stage_Timing_Reference",
    ]
    assert "00_Metadata" in workbook
    assert "13_Stage_Timing_Reference" in workbook
    assert "system_version" in metadata
    assert "timing_profile_version" in metadata
    assert "row_count.12_R_Analysis_Table" in metadata
    assert "row_count.00_Metadata" in metadata
    assert "mergeCells" not in workbook + metadata + batch_sheet + embryo_matrix + stage_counts + r_table
    assert '<row r="2">' in batch_sheet
    assert '<row r="2">' in embryo_matrix
    assert '<row r="2">' in r_table
    assert re.search(r'<c r="E2"><v>\d+</v></c>', stage_counts)
    assert re.search(r'<c r="E2"><v>\d+</v></c>', r_table)
    assert summary[1][6] == "0"
    assert timing[0] == [
        "stage_order",
        "stage_code",
        "stage_label",
        "expected_hpa",
        "phase",
        "stage_scope",
        "profile_version",
        "reference_temp_c",
        "source_note",
    ]


def test_excel_export_can_select_flat_sheets(client, write_headers, monkeypatch):
    def fail_if_called(*_args):
        raise AssertionError("unselected fish sheets were built")

    monkeypatch.setattr("chronofish.api.routes.exports._fish_rows", fail_if_called)
    headers = {**write_headers, "X-Idempotency-Key": "01900000-0000-7000-8000-000000000299"}
    response = client.post(
        "/api/v1/exports/excel",
        headers=headers,
        json={"filters": {}, "sheets": ["00_Metadata", "12_R_Analysis_Table"]},
    )
    assert response.status_code == 200
    with ZipFile(BytesIO(response.content)) as archive:
        workbook = archive.read("xl/workbook.xml").decode()
        metadata = archive.read("xl/worksheets/sheet1.xml").decode()
    assert re.findall(r'<sheet name="([^"]+)"', workbook) == ["00_Metadata", "12_R_Analysis_Table"]
    assert "row_count.12_R_Analysis_Table" in metadata


def test_excel_export_rejects_unknown_analytics_filters(client):
    response = client.post("/api/v1/exports/excel", json={"filters": {"status": "DEAD"}})
    assert response.status_code == 422


def test_xlsx_removes_invalid_xml_characters():
    workbook = build_xlsx([("Safe", ["notes"], [["copied\x0btext"]])])
    with ZipFile(BytesIO(workbook)) as archive:
        rows = worksheet_rows(archive.read("xl/worksheets/sheet1.xml"))
    assert rows == [["notes"], ["copiedtext"]]


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


def test_audit_entries_expose_complete_change_context(client, write_headers):
    created = client.post("/api/v1/sites", headers=write_headers, json={"code": "AUDIT", "name": "Audit lab"}).json()
    update_headers = {**write_headers, "X-Idempotency-Key": "01900000-0000-7000-8000-000000000201"}
    updated = client.patch(f"/api/v1/sites/{created['id']}", headers=update_headers, json={"name": "Updated lab"})
    assert updated.status_code == 200

    items = client.get(f"/api/v1/audit-log?recordId={created['id']}").json()["items"]
    assert [item["action"] for item in items] == ["UPDATE", "INSERT"]
    for item in items:
        assert item["operatorId"] == write_headers["X-Operator-Id"]
        assert item["deviceId"] == write_headers["X-Device-Id"]
        assert item["occurredAt"].endswith("Z")
        assert "oldValues" in item and "newValues" in item
    assert items[0]["oldValues"]["name"] == "Audit lab"
    assert items[0]["newValues"]["name"] == "Updated lab"


def test_audit_rejects_malformed_cursor_without_server_error(client):
    response = client.get("/api/v1/audit-log?cursor=not-a-valid-cursor")

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_query"


def test_audit_rejects_malformed_uuid_filters(client):
    response = client.get("/api/v1/audit-log?recordId=not-a-uuid&operatorId=also-not-a-uuid")

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_query"

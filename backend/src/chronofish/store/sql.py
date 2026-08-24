from __future__ import annotations

import base64
import copy
import json
import re
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

from fastapi import Request
from fastapi.responses import Response
from sqlalchemy import Connection, Engine, text
from sqlalchemy.exc import IntegrityError

from ..config import Config
from ..domain.state import State
from ..runtime.errors import APIError
from ..runtime.mutations import encode_result, request_fingerprint, validate_write_context
from ..runtime.values import uuid7
from .base import Mutation
from .database import create_database_engine
from .migrations import migrate

FISH_SEQUENCE_ID = "00000000-0000-7000-8000-000000000006"

RESOURCE_TABLE = {
    "sites": "site",
    "operators": "operator",
    "donor-cell-lines": "donor_cell_line",
    "recipient-egg-lots": "recipient_egg_lot",
    "csof-lots": "csof_lot",
    "treatment-groups": "treatment_group",
    "fish-boxes": "fish_box",
    "protocols": "protocol",
    "timing-profiles": "stage_timing_profile",
    "batches": "experiment_batch",
    "injection-lots": "injection_lot",
    "embryos": "embryo",
    "control-arm-counts": "control_arm_count",
    "fish": "clone_fish",
    "specimens": "specimen",
}


def _columns(value: str) -> frozenset[str]:
    return frozenset(value.split())


TABLE_COLUMNS = {
    "site": "id code name active created_at updated_at deleted_at",
    "operator": "id site_id name active created_at updated_at deleted_at",
    "donor_cell_line": "id strain preparation batch_code active created_at updated_at deleted_at",
    "recipient_egg_lot": "id breed lot_date label active created_at updated_at deleted_at",
    "csof_lot": "id lot_code active created_at updated_at deleted_at",
    "treatment_group": "id code name arm_type active created_at updated_at deleted_at",
    "fish_box": "id box_code site_id active created_at updated_at deleted_at",
    "protocol": "id name stage1_max_age_days active created_at updated_at deleted_at",
    "stage_timing_profile": """
        id protocol_id version name reference_temp_c auto_temp_adjust source_note is_current
        created_by_operator_id created_at updated_at deleted_at
    """,
    "experiment_batch": """
        id batch_code experiment_date day_no site_id operator_id protocol_id timing_profile_id
        treatment_group_id recipient_egg_lot_id csof_lot_id clutch_code replicate_no incubation_temp_c
        notes created_at updated_at deleted_at
    """,
    "injection_lot": """
        id batch_id lot_no donor_cell_line_id enu_power_pct enu_pulse_us enu_led enu_start_at
        enu_finish_at activated_at n_eggs n_activated notes created_at updated_at deleted_at
    """,
    "embryo": """
        id injection_lot_id seq_in_lot embryo_code well_position exit_stage_id exit_at exit_reason
        first_abnormal_observation_id created_at updated_at deleted_at
    """,
    "embryo_observation": """
        id client_uuid embryo_id stage_definition_id observed_at hpa_actual hpa_expected_snapshot
        deviation_h outcome biological_condition operator_id device_id is_backdated override_reason
        notes created_at updated_at deleted_at
    """,
    "control_arm_count": """
        id batch_id arm_type stage_definition_id n_normal n_abnormal created_at updated_at deleted_at
    """,
    "clone_fish": """
        id embryo_id fish_code running_no dob donor_cell_line_id site_id fish_box_id status
        biological_condition first_abnormal_on first_abnormal_age_days first_abnormal_stage_id sex
        fin_clipped exit_date exit_reason remarks created_at updated_at deleted_at
    """,
    "fish_observation": """
        id client_uuid clone_fish_id observed_on age_days outcome biological_condition operator_id
        device_id is_backdated notes created_at updated_at deleted_at
    """,
    "specimen": """
        id clone_fish_id specimen_code specimen_kind specimen_type collected_on frozen_on storage notes
        created_at updated_at deleted_at
    """,
}
TABLE_COLUMNS = {table: _columns(columns) for table, columns in TABLE_COLUMNS.items()}

DATE_COLUMNS = {
    "lot_date",
    "experiment_date",
    "dob",
    "observed_on",
    "first_abnormal_on",
    "exit_date",
    "collected_on",
    "frozen_on",
}


def _camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


def _snake(value: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", value).lower()


def _api_value(column: str, value: Any) -> Any:
    if isinstance(value, datetime):
        return value.replace(tzinfo=value.tzinfo or UTC).astimezone(UTC).isoformat().replace("+00:00", "Z")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, bytes):
        return value.decode()
    if column in {"active", "auto_temp_adjust", "is_current", "fin_clipped", "is_backdated"}:
        return bool(value)
    return value


def _database_value(column: str, value: Any) -> Any:
    if value in ("", None):
        return None
    if column in DATE_COLUMNS and isinstance(value, str):
        return date.fromisoformat(value[:10])
    if column.endswith("_at") and isinstance(value, str):
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=parsed.tzinfo or UTC).astimezone(UTC).replace(tzinfo=None)
    return value


def _decode_json(value: Any) -> Any:
    if value in (None, ""):
        return None
    if isinstance(value, (dict, list)):
        return value
    return json.loads(value)


class SQLStore:
    """Database-backed v1 store.

    ponytail: writes use one durable sequence-row lock; split locks by aggregate
    if measured write contention requires it.
    ponytail: snapshots hydrate the v1 dataset; replace report reads with bounded
    SQL projections before data exceeds memory.
    """

    def __init__(self, config: Config) -> None:
        migrate(config)
        self.engine: Engine = create_database_engine(config)

    def close(self) -> None:
        self.engine.dispose()

    def snapshot(self) -> State:
        with self.engine.connect() as connection:
            return self._load_state(connection)

    def _rows(self, connection: Connection, table: str) -> list[dict[str, Any]]:
        return [dict(row) for row in connection.execute(text(f"SELECT * FROM {table}")).mappings()]

    def _load_state(self, connection: Connection) -> State:
        state = State()
        stages = self._rows(connection, "stage_definition")
        stage_by_id = {str(row["id"]): str(row["code"]) for row in stages}
        for resource, table in RESOURCE_TABLE.items():
            records = {}
            for row in self._rows(connection, table):
                item = {
                    _camel(column): _api_value(column, value)
                    for column, value in row.items()
                    if column in TABLE_COLUMNS[table]
                }
                if "biologicalCondition" in item:
                    item["condition"] = item.pop("biologicalCondition")
                if resource == "embryos" and item.get("exitStageId"):
                    item["exitStageCode"] = stage_by_id.get(str(item["exitStageId"]))
                if resource == "control-arm-counts":
                    item["stageCode"] = stage_by_id.get(str(item.get("stageDefinitionId")))
                if resource == "fish" and item.get("firstAbnormalStageId"):
                    item["firstAbnormalStageCode"] = stage_by_id.get(str(item["firstAbnormalStageId"]))
                records[str(item["id"])] = item
            state.entities[resource] = records
        profiles = state.entities["timing-profiles"]
        for profile in profiles.values():
            profile["entries"] = []
        timing_rows = connection.execute(
            text(
                "SELECT st.*, sd.stage_order, sd.code, sd.label, sd.short_label, sd.phase, sd.stage_scope "
                "FROM stage_timing st JOIN stage_definition sd ON sd.id = st.stage_definition_id "
                "ORDER BY st.profile_id, sd.stage_order"
            )
        ).mappings()
        for row in timing_rows:
            profile = profiles.get(str(row["profile_id"]))
            if profile:
                profile["entries"].append(
                    {
                        "id": str(row["stage_definition_id"]),
                        "stageDefinitionId": str(row["stage_definition_id"]),
                        "stageOrder": int(row["stage_order"]),
                        "stageCode": str(row["code"]),
                        "code": str(row["code"]),
                        "stageLabel": str(row["label"]),
                        "label": str(row["label"]),
                        "shortLabel": str(row["short_label"]),
                        "phase": str(row["phase"]),
                        "stageScope": str(row["stage_scope"]),
                        "expectedHpa": _api_value("expected_hpa", row["expected_hpa"]),
                    }
                )
        state.observations = self._load_observations(connection, "embryo_observation", stage_by_id)
        state.fish_observations = self._load_observations(connection, "fish_observation", stage_by_id)
        self._hydrate_derived(state)
        state.next_fish_no = int(
            connection.execute(
                text("SELECT next_running_no FROM fish_running_sequence WHERE id = :id"),
                {"id": FISH_SEQUENCE_ID},
            ).scalar_one()
        )
        return state

    def _load_observations(
        self, connection: Connection, table: str, stage_by_id: dict[str, str]
    ) -> dict[str, dict[str, Any]]:
        result = {}
        for row in self._rows(connection, table):
            item = {_camel(column): _api_value(column, value) for column, value in row.items()}
            if "biologicalCondition" in item:
                item["condition"] = item.pop("biologicalCondition")
            if table == "embryo_observation":
                item["stageCode"] = stage_by_id.get(str(item.get("stageDefinitionId")))
            result[str(item["id"])] = item
        return result

    def _hydrate_derived(self, state: State) -> None:
        first_abnormal: dict[str, dict[str, Any]] = {}
        for observation in state.observations.values():
            embryo = state.entities["embryos"].get(str(observation.get("embryoId")))
            if embryo:
                observation["injectionLotId"] = embryo.get("injectionLotId")
            if observation.get("condition") != "ABNORMAL" or observation.get("deletedAt") is not None:
                continue
            embryo_id = str(observation.get("embryoId"))
            current = first_abnormal.get(embryo_id)
            key = (str(observation.get("observedAt")), str(observation.get("stageCode")))
            if current is None or key < (str(current.get("observedAt")), str(current.get("stageCode"))):
                first_abnormal[embryo_id] = observation
        for embryo in state.entities["embryos"].values():
            abnormal = first_abnormal.get(str(embryo["id"]))
            if abnormal:
                embryo["firstAbnormalObservationId"] = abnormal["id"]
                embryo["firstAbnormalStageCode"] = abnormal["stageCode"]

    def _stage_ids(self, connection: Connection) -> dict[str, str]:
        return {
            str(row["code"]): str(row["id"])
            for row in connection.execute(text("SELECT id, code FROM stage_definition")).mappings()
        }

    def _db_row(self, table: str, item: dict[str, Any], stage_ids: dict[str, str]) -> dict[str, Any]:
        values = {}
        for field, value in item.items():
            column = "biological_condition" if field == "condition" else _snake(field)
            if column in TABLE_COLUMNS[table]:
                values[column] = _database_value(column, value)
        if table in {"embryo_observation", "control_arm_count"}:
            values["stage_definition_id"] = item.get("stageDefinitionId") or stage_ids.get(str(item.get("stageCode")))
        if table == "embryo":
            values["exit_stage_id"] = item.get("exitStageId") or stage_ids.get(str(item.get("exitStageCode")))
            values["first_abnormal_observation_id"] = item.get("firstAbnormalObservationId")
        if table == "clone_fish":
            values["first_abnormal_stage_id"] = item.get("firstAbnormalStageId") or stage_ids.get(
                str(item.get("firstAbnormalStageCode"))
            )
        if "created_at" in TABLE_COLUMNS[table] and not values.get("created_at"):
            values["created_at"] = datetime.now(UTC).replace(tzinfo=None)
        if "updated_at" in TABLE_COLUMNS[table] and not values.get("updated_at"):
            values["updated_at"] = values.get("created_at") or datetime.now(UTC).replace(tzinfo=None)
        return values

    def _insert(self, connection: Connection, table: str, values: dict[str, Any]) -> None:
        columns = list(values)
        marks = ", ".join(f":{column}" for column in columns)
        connection.execute(text(f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({marks})"), values)

    def _update(self, connection: Connection, table: str, item_id: str, values: dict[str, Any]) -> None:
        values = {key: value for key, value in values.items() if key != "id"}
        assignments = ", ".join(f"{column} = :{column}" for column in values)
        if assignments:
            connection.execute(
                text(f"UPDATE {table} SET {assignments}, row_version = row_version + 1 WHERE id = :_id"),
                {**values, "_id": item_id},
            )

    def _sync_collection(
        self,
        connection: Connection,
        table: str,
        before: dict[str, dict[str, Any]],
        after: dict[str, dict[str, Any]],
        stage_ids: dict[str, str],
        inserts: bool,
    ) -> None:
        for item_id, item in after.items():
            previous = before.get(item_id)
            if inserts and previous is None:
                self._insert(connection, table, self._db_row(table, item, stage_ids))
            elif not inserts and previous is not None and previous != item:
                self._update(connection, table, item_id, self._db_row(table, item, stage_ids))

    def _sync_timing_entries(
        self, connection: Connection, before: State, after: State, stage_ids: dict[str, str]
    ) -> None:
        for profile_id, profile in after.entities["timing-profiles"].items():
            if profile_id in before.entities["timing-profiles"]:
                continue
            for entry in profile.get("entries", []):
                now = datetime.now(UTC).replace(tzinfo=None)
                self._insert(
                    connection,
                    "stage_timing",
                    {
                        "id": uuid7(),
                        "protocol_id": profile["protocolId"],
                        "profile_id": profile_id,
                        "stage_definition_id": stage_ids[str(entry["stageCode"])],
                        "expected_hpa": entry["expectedHpa"],
                        "created_at": now,
                        "updated_at": now,
                    },
                )

    def _persist(self, connection: Connection, before: State, after: State) -> None:
        stage_ids = self._stage_ids(connection)
        self._sync_collection(
            connection,
            "stage_timing_profile",
            before.entities["timing-profiles"],
            after.entities["timing-profiles"],
            stage_ids,
            False,
        )
        for resource, table in RESOURCE_TABLE.items():
            self._sync_collection(
                connection, table, before.entities[resource], after.entities[resource], stage_ids, True
            )
            if resource == "timing-profiles":
                self._sync_timing_entries(connection, before, after, stage_ids)
        self._sync_collection(
            connection, "embryo_observation", before.observations, after.observations, stage_ids, True
        )
        self._sync_collection(
            connection, "fish_observation", before.fish_observations, after.fish_observations, stage_ids, True
        )
        for resource, table in RESOURCE_TABLE.items():
            if resource != "timing-profiles":
                self._sync_collection(
                    connection, table, before.entities[resource], after.entities[resource], stage_ids, False
                )
        self._sync_collection(
            connection, "embryo_observation", before.observations, after.observations, stage_ids, False
        )
        self._sync_collection(
            connection, "fish_observation", before.fish_observations, after.fish_observations, stage_ids, False
        )
        for item in after.audits[len(before.audits) :]:
            self._insert(
                connection,
                "audit_log",
                {
                    "id": item["id"],
                    "table_name": item["tableName"],
                    "record_id": item["recordId"],
                    "action": item["action"],
                    "old_values": json.dumps(item.get("oldValues"), ensure_ascii=False, default=str)
                    if item.get("oldValues") is not None
                    else None,
                    "new_values": json.dumps(item.get("newValues"), ensure_ascii=False, default=str)
                    if item.get("newValues") is not None
                    else None,
                    "operator_id": item.get("operatorId"),
                    "device_id": item.get("deviceId"),
                    "occurred_at": _database_value("occurred_at", item["occurredAt"]),
                },
            )
        connection.execute(
            text("UPDATE fish_running_sequence SET next_running_no = :value WHERE id = :id"),
            {"value": after.next_fish_no, "id": FISH_SEQUENCE_ID},
        )

    def execute_mutation(self, request: Request, body: Any, operation: Mutation) -> Response:
        scope, request_hash = request_fingerprint(request, body)
        try:
            with self.engine.begin() as connection:
                connection.execute(
                    text("SELECT next_running_no FROM fish_running_sequence WHERE id = :id FOR UPDATE"),
                    {"id": FISH_SEQUENCE_ID},
                ).scalar_one()
                state = self._load_state(connection)
                operator_id, device_id, key = validate_write_context(request, state)
                previous = (
                    connection.execute(
                        text(
                            "SELECT request_hash, status_code, content_type, response_body, completed_at "
                            "FROM request_idempotency WHERE scope = :scope AND idempotency_key = :key"
                        ),
                        {"scope": scope, "key": key},
                    )
                    .mappings()
                    .first()
                )
                if previous:
                    if previous["request_hash"] != request_hash:
                        raise APIError(409, "idempotency_conflict", "X-Idempotency-Key was used by another request")
                    if previous["completed_at"] is None:
                        raise APIError(409, "request_in_progress", "the original request is still in progress")
                    stored = str(previous["response_body"])
                    content = (
                        base64.b64decode(stored.removeprefix("base64:"))
                        if stored.startswith("base64:")
                        else stored.encode()
                    )
                    return Response(content, int(previous["status_code"]), media_type=str(previous["content_type"]))
                before = copy.deepcopy(state)
                status, media_type, encoded = encode_result(operation(state))
                self._persist(connection, before, state)
                now = datetime.now(UTC).replace(tzinfo=None)
                self._insert(
                    connection,
                    "request_idempotency",
                    {
                        "scope": scope,
                        "idempotency_key": key,
                        "request_hash": request_hash,
                        "status_code": status,
                        "content_type": media_type,
                        "response_body": "base64:" + base64.b64encode(encoded).decode(),
                        "operator_id": operator_id,
                        "device_id": device_id,
                        "created_at": now,
                        "completed_at": now,
                        "lease_until": now + timedelta(seconds=30),
                        "lease_token": key,
                    },
                )
                return Response(encoded, status, media_type=media_type)
        except IntegrityError as error:
            raise APIError(409, "conflict", "the write conflicts with an existing record") from error

    def query_audits(
        self,
        *,
        table: str | None,
        record_id: str | None,
        operator_id: str | None,
        from_time: datetime | None,
        to_time: datetime | None,
        cursor: tuple[datetime, str] | None,
        limit: int,
    ) -> tuple[list[dict[str, Any]], bool]:
        where, values = ["1 = 1"], {"limit": limit + 1}
        for column, value in (("table_name", table), ("record_id", record_id), ("operator_id", operator_id)):
            if value:
                where.append(f"{column} = :{column}")
                values[column] = value
        if from_time:
            where.append("occurred_at >= :from_time")
            values["from_time"] = from_time.replace(tzinfo=None)
        if to_time:
            where.append("occurred_at <= :to_time")
            values["to_time"] = to_time.replace(tzinfo=None)
        if cursor:
            where.append("(occurred_at < :cursor_at OR (occurred_at = :cursor_at AND id < :cursor_id))")
            values.update(cursor_at=cursor[0].replace(tzinfo=None), cursor_id=cursor[1])
        query = (
            "SELECT id, table_name, record_id, action, old_values, new_values, operator_id, device_id, occurred_at "
            f"FROM audit_log WHERE {' AND '.join(where)} ORDER BY occurred_at DESC, id DESC LIMIT :limit"
        )
        with self.engine.connect() as connection:
            rows = list(connection.execute(text(query), values).mappings())
        items = [
            {
                "id": str(row["id"]),
                "tableName": row["table_name"],
                "recordId": str(row["record_id"]),
                "action": row["action"],
                "oldValues": _decode_json(row["old_values"]),
                "newValues": _decode_json(row["new_values"]),
                "operatorId": row["operator_id"],
                "deviceId": row["device_id"],
                "occurredAt": _api_value("occurred_at", row["occurred_at"]),
            }
            for row in rows[:limit]
        ]
        return items, len(rows) > limit

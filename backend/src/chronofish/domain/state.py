from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .rules import default_expected_hpa, stage_code, stage_label

JSON = dict[str, Any]
DEMO_OPERATOR_ID = "00000000-0000-7000-8000-000000000001"
PROTOCOL_ID = "01900000-0000-7000-8000-000000000001"
TIMING_PROFILE_ID = "01900000-0000-7000-8000-000000000002"
RESOURCES = (
    "sites",
    "operators",
    "donor-cell-lines",
    "recipient-egg-lots",
    "csof-lots",
    "treatment-groups",
    "fish-boxes",
    "protocols",
    "timing-profiles",
    "batches",
    "injection-lots",
    "embryos",
    "fish",
    "specimens",
    "control-arm-counts",
)


@dataclass(slots=True)
class State:
    entities: dict[str, dict[str, JSON]] = field(default_factory=lambda: {resource: {} for resource in RESOURCES})
    observations: dict[str, JSON] = field(default_factory=dict)
    fish_observations: dict[str, JSON] = field(default_factory=dict)
    audits: list[JSON] = field(default_factory=list)
    next_fish_no: int = 1

    @classmethod
    def seeded(cls) -> State:
        state = cls()
        now = "2026-01-01T00:00:00Z"
        state.entities["operators"][DEMO_OPERATOR_ID] = {
            "id": DEMO_OPERATOR_ID,
            "name": "Demo operator",
            "active": True,
            "createdAt": now,
            "updatedAt": now,
        }
        state.entities["protocols"][PROTOCOL_ID] = {
            "id": PROTOCOL_ID,
            "name": "SCNT standard",
            "stage1MaxAgeDays": 5,
            "active": True,
            "createdAt": now,
            "updatedAt": now,
        }
        entries = []
        for order in range(1, 37):
            code = stage_code(order)
            label = stage_label(order)
            entries.append(
                {
                    "id": f"01900001-0000-7000-8000-{order:012d}",
                    "protocolId": PROTOCOL_ID,
                    "stageOrder": order,
                    "code": code,
                    "label": label,
                    "stageCode": code,
                    "stageLabel": label,
                    "shortLabel": label,
                    "phase": "LARVAL",
                    "stageScope": "STAGE_1" if order <= 26 else "STAGE_2",
                    "expectedHpa": default_expected_hpa(code),
                }
            )
        state.entities["timing-profiles"][TIMING_PROFILE_ID] = {
            "id": TIMING_PROFILE_ID,
            "protocolId": PROTOCOL_ID,
            "version": 1,
            "name": "ZFIN 28.5C (default)",
            "isCurrent": True,
            "entries": entries,
            "createdAt": now,
            "updatedAt": now,
        }
        return state

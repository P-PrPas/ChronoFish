from __future__ import annotations

import math
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal

STAGE_SUFFIXES = (
    "1C",
    "2C",
    "4C",
    "8C",
    "16C",
    "32C",
    "64C",
    "128C",
    "256C",
    "512C",
    "1K",
    "HI",
    "OB",
    "SPH",
    "DO",
    "30EPI",
    "50EPI",
    "GR",
    "SH",
    "75EPI",
    "90EPI",
    "1D",
    "2D",
    "3D",
    "4D",
    "5D",
    "6D",
    "7D",
    "8D",
    "9D",
    "10D",
    "11D",
    "12D",
    "13D",
    "14D",
    "15D",
)
EXPECTED_HPA = (
    0,
    0.75,
    1,
    1.25,
    1.5,
    1.75,
    2,
    2.25,
    2.5,
    2.75,
    3,
    3.33,
    3.66,
    4,
    4.33,
    4.66,
    5.25,
    5.66,
    6,
    8,
    9,
    24,
    48,
    72,
    96,
    120,
    144,
    168,
    192,
    216,
    240,
    264,
    288,
    312,
    336,
    360,
)


def stage_number(code: str) -> int:
    if not code.startswith("stage_"):
        return 0
    try:
        result = int(code.removeprefix("stage_").split("_", 1)[0])
    except ValueError:
        return 0
    return result if result > 0 else 0


def stage_code(order: int) -> str:
    suffix = STAGE_SUFFIXES[order - 1] if 1 <= order <= len(STAGE_SUFFIXES) else ""
    return f"stage_{order:02d}_{suffix}".rstrip("_")


def stage_label(order: int) -> str:
    if order == 1:
        return "Activated (1-cell)"
    if 2 <= order <= 10:
        return f"{STAGE_SUFFIXES[order - 1][:-1]}-cell"
    if order == 11:
        return "1k-cell"
    if 12 <= order <= 21:
        return (
            "High",
            "Oblong",
            "Sphere",
            "Dome",
            "30% epiboly",
            "50% epiboly",
            "Germ ring",
            "Shield",
            "75% epiboly",
            "90% epiboly",
        )[order - 12]
    return f"Day {order - 21}"


def stage_short_label(order: int) -> str:
    return STAGE_SUFFIXES[order - 1] if 1 <= order <= len(STAGE_SUFFIXES) else ""


def stage_phase(order: int) -> str:
    if order <= 10:
        return "CLEAVAGE"
    if order <= 15:
        return "BLASTULA"
    if order <= 21:
        return "GASTRULA"
    return "LARVAL"


def default_expected_hpa(code: str) -> float:
    order = stage_number(code)
    return float(EXPECTED_HPA[order - 1]) if 1 <= order <= len(EXPECTED_HPA) else 0.0


def round4(value: float) -> float:
    return float(Decimal(str(value)).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP))


def enu_window(activated: datetime, start: datetime | None, finish: datetime | None) -> str | None:
    if start and finish and finish <= start:
        raise ValueError("enu finish must be after enu start")
    if finish and finish > activated:
        return "enuFinishAt is later than activatedAt; verify the ENU timing before analysis"
    return None


def is_backdated(observed: datetime, received: datetime) -> bool:
    return abs((received - observed).total_seconds()) > 15 * 60


def deviation_label(value: float) -> str:
    if math.isclose(value, 0.0, abs_tol=1 / 60):
        return "ตรงกับสากล"
    minutes = round(abs(value) * 60)
    direction = "เร็วกว่าสากล" if value < 0 else "ช้ากว่าสากล"
    return f"{direction} {minutes} นาที" if minutes < 60 else f"{direction} {minutes // 60} ชม. {minutes % 60} นาที"


def age_days_on(dob: date, observed: date) -> int:
    return (observed - dob).days


def promotion_eligible_at(has_exit: bool, latest_alive: bool, activated_at: datetime, now: datetime, days: int) -> bool:
    return not has_exit and latest_alive and days > 0 and now > activated_at + timedelta(days=days)


def fish_outcome_valid(value: str) -> bool:
    return value in {"ALIVE", "DEAD", "FROZEN", "DISCARDED", "NOT_OBSERVED"}


def condition_valid(value: str) -> bool:
    return value in {"NORMAL", "ABNORMAL", "UNDETERMINED"}

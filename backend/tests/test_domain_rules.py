from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest

from chronofish.domain.rules import (
    DAY5_STAGE_ORDER,
    EXPECTED_HPA,
    STAGE_SUFFIXES,
    age_days_on,
    condition_valid,
    default_expected_hpa,
    deviation_label,
    enu_window,
    fish_outcome_valid,
    is_backdated,
    promotion_eligible_at,
    round4,
    stage_code,
    stage_label,
    stage_number,
    stage_phase,
    stage_short_label,
)
from chronofish.domain.state import RESOURCES, State


def test_stage_code_covers_all_36_orders():
    codes = [stage_code(order) for order in range(1, 37)]

    assert len(set(codes)) == 36
    assert [code.removeprefix("stage_").split("_", 1)[1] for code in codes] == list(STAGE_SUFFIXES)


def test_stage_code_out_of_range_has_no_suffix():
    assert (stage_code(0), stage_code(37)) == ("stage_00", "stage_37")


@pytest.mark.parametrize(
    ("code", "expected"),
    (("stage_07_64C", 7), ("stage_xx", 0), ("", 0), ("stage_00_X", 0)),
)
def test_stage_number_parses_and_rejects(code, expected):
    assert stage_number(code) == expected


def test_stage_label_boundaries():
    assert [stage_label(order) for order in (1, 2, 10, 11, 12, 21, 22, 36)] == [
        "Activated (1-cell)",
        "2-cell",
        "512-cell",
        "1k-cell",
        "High",
        "90% epiboly",
        "Day 1",
        "Day 15",
    ]


def test_stage_phase_boundaries():
    assert [stage_phase(order) for order in (10, 11, 15, 16, 21, 22)] == [
        "CLEAVAGE",
        "BLASTULA",
        "BLASTULA",
        "GASTRULA",
        "GASTRULA",
        "LARVAL",
    ]


def test_stage_short_label_matches_suffix_table():
    assert [stage_short_label(order) for order in range(1, 37)] == list(STAGE_SUFFIXES)
    assert (stage_short_label(0), stage_short_label(37)) == ("", "")


def test_default_expected_hpa_matches_zfin_table():
    assert [default_expected_hpa(stage_code(order)) for order in range(1, 37)] == list(EXPECTED_HPA)
    assert default_expected_hpa("unknown") == 0.0


def test_day5_stage_order_closes_stage_one():
    assert (DAY5_STAGE_ORDER, stage_label(DAY5_STAGE_ORDER)) == (26, "Day 5")


def test_round4_uses_half_up_not_bankers():
    assert (round4(0.00005), round4(-0.00005), round4(2.34505)) == (0.0001, -0.0001, 2.3451)


def test_round4_keeps_four_decimals():
    assert round4(1 / 3) == 0.3333


def test_deviation_label_singular_minute_in_english():
    assert deviation_label(1 / 60 * 1.2, "en") == "1 minute slower than reference"


def test_is_backdated_at_the_fifteen_minute_boundary():
    now = datetime(2026, 1, 1, tzinfo=UTC)
    assert not is_backdated(now - timedelta(minutes=15), now)
    assert not is_backdated(now + timedelta(minutes=15), now)
    assert is_backdated(now - timedelta(minutes=15, seconds=1), now)
    assert is_backdated(now + timedelta(minutes=15, seconds=1), now)


def test_age_days_on_counts_calendar_days():
    assert age_days_on(date(2026, 1, 1), date(2026, 1, 2)) == 1


def test_age_days_on_is_negative_before_dob():
    assert age_days_on(date(2026, 1, 2), date(2026, 1, 1)) == -1


def test_enu_window_rejects_finish_before_start():
    activated = datetime(2026, 1, 1, tzinfo=UTC)
    with pytest.raises(ValueError, match="enu finish must be after enu start"):
        enu_window(activated, activated, activated)


def test_enu_window_warns_when_finish_is_after_activation():
    activated = datetime(2026, 1, 1, tzinfo=UTC)
    assert enu_window(activated, activated - timedelta(minutes=1), activated + timedelta(seconds=1))


def test_enu_window_returns_none_when_consistent():
    activated = datetime(2026, 1, 1, tzinfo=UTC)
    assert enu_window(activated, activated - timedelta(hours=2), activated - timedelta(hours=1)) is None


def test_promotion_eligible_requires_all_conditions():
    activated = datetime(2026, 1, 1, tzinfo=UTC)
    eligible = activated + timedelta(days=5, microseconds=1)
    assert promotion_eligible_at(False, True, activated, eligible, 5)
    assert not promotion_eligible_at(True, True, activated, eligible, 5)
    assert not promotion_eligible_at(False, False, activated, eligible, 5)
    assert not promotion_eligible_at(False, True, activated, eligible, 0)


def test_promotion_is_not_eligible_exactly_at_the_threshold():
    activated = datetime(2026, 1, 1, tzinfo=UTC)
    assert not promotion_eligible_at(False, True, activated, activated + timedelta(days=5), 5)


def test_fish_outcome_and_condition_enums():
    assert all(fish_outcome_valid(value) for value in {"ALIVE", "DEAD", "FROZEN", "DISCARDED", "NOT_OBSERVED"})
    assert all(condition_valid(value) for value in {"NORMAL", "ABNORMAL", "UNDETERMINED"})
    assert not fish_outcome_valid("alive")
    assert not condition_valid("unknown")


def test_seeded_state_contains_every_resource_bucket():
    assert set(State.seeded().entities) == set(RESOURCES)


def test_seeded_timing_profile_has_36_current_entries():
    profile = next(iter(State.seeded().entities["timing-profiles"].values()))

    assert profile["isCurrent"] is True
    assert [entry["stageOrder"] for entry in profile["entries"]] == list(range(1, 37))
    assert [entry["stageScope"] for entry in profile["entries"]] == ["STAGE_1"] * 26 + ["STAGE_2"] * 10


def test_seeded_protocol_default_stage1_max_age_is_five_days():
    protocol = next(iter(State.seeded().entities["protocols"].values()))
    assert protocol["stage1MaxAgeDays"] == 5

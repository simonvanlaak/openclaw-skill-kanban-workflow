import pytest

from clawban.models import Stage


@pytest.mark.parametrize(
    "value,expected",
    [
        ("stage:backlog", "stage:backlog"),
        ("BACKLOG", "stage:backlog"),
        ("in progress", "stage:in-progress"),
        ("stage:needs-clarification", "stage:needs-clarification"),
        ("needs_clarification", "stage:needs-clarification"),
        ("ready-to-implement", "stage:ready-to-implement"),
    ],
)
def test_stage_from_any_normalizes(value: str, expected: str) -> None:
    assert Stage.from_any(value).key == expected


def test_stage_from_any_rejects_unknown() -> None:
    with pytest.raises(ValueError):
        Stage.from_any("triage")

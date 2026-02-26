from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Mapping


_CANONICAL_STAGES: tuple[str, ...] = (
    "stage:backlog",
    "stage:queued",
    "stage:needs-clarification",
    "stage:ready-to-implement",
    "stage:in-progress",
    "stage:in-review",
    "stage:blocked",
)


def _slug(s: str) -> str:
    return (
        s.strip()
        .lower()
        .replace("stage:", "")
        .replace("stage/", "")
        .replace("_", "-")
        .replace(" ", "-")
    )


@dataclass(frozen=True, slots=True)
class Stage:
    """Canonical stage.

    Notes:
        The canonical form is always the full label (e.g. ``stage:in-progress``).
        Adapters may accept other platform-specific values and normalize via
        :meth:`from_any`.
    """

    key: str

    @classmethod
    def from_any(cls, value: str) -> "Stage":
        """Parse a stage from a canonical key or common shorthand.

        Args:
            value: Canonical stage key (``stage:...``) or a shorthand
                like ``in progress`` / ``in-progress`` / ``IN_PROGRESS``.

        Raises:
            ValueError: If the stage is not recognized.
        """

        normalized = _slug(value)

        # Accept already canonical.
        if value.strip().lower().startswith("stage:"):
            key = value.strip().lower()
        else:
            key = f"stage:{normalized}"

        if key not in _CANONICAL_STAGES:
            raise ValueError(f"Unknown stage: {value!r}")
        return cls(key=key)


@dataclass(frozen=True, slots=True)
class WorkItem:
    """A canonical, platform-agnostic work item."""

    id: str
    title: str
    stage: Stage
    url: str | None = None
    labels: tuple[str, ...] = ()
    updated_at: datetime | None = None
    raw: Mapping[str, Any] = field(default_factory=dict)

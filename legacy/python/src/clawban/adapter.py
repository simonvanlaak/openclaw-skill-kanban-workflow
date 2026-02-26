from __future__ import annotations

from collections.abc import Mapping
from typing import Protocol

from .models import WorkItem


class Adapter(Protocol):
    """Port interface for a platform adapter.

    Adapters are expected to use platform CLIs (gh, planka-cli, etc.) for auth.
    """

    def fetch_snapshot(self) -> Mapping[str, WorkItem]:
        """Return the current snapshot of tracked work items."""

    def name(self) -> str:
        """Human-readable adapter name (for logging/telemetry)."""

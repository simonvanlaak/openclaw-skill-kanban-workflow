from __future__ import annotations

from dataclasses import dataclass

from .adapter import Adapter
from .diff import diff_work_items
from .models import WorkItem


@dataclass(frozen=True, slots=True)
class TickResult:
    adapter_name: str
    snapshot: dict[str, WorkItem]
    events: list[object]


def tick(adapter: Adapter, previous_snapshot: dict[str, WorkItem] | None = None) -> TickResult:
    """Run one deterministic polling pass (poll → normalize → diff → events).

    This is the core, cron/webhook-friendly entrypoint. Higher-level workflow
    rules (e.g. auto-comment on needs-clarification) should layer on top.
    """

    prev = previous_snapshot or {}
    curr = dict(adapter.fetch_snapshot())
    events = diff_work_items(prev, curr)
    return TickResult(adapter_name=adapter.name(), snapshot=curr, events=events)

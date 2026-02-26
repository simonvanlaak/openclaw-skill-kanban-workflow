from __future__ import annotations

from dataclasses import dataclass

from .models import Stage, WorkItem


@dataclass(frozen=True, slots=True)
class WorkItemCreated:
    work_item: WorkItem


@dataclass(frozen=True, slots=True)
class WorkItemDeleted:
    work_item_id: str


@dataclass(frozen=True, slots=True)
class StageChanged:
    work_item_id: str
    old: Stage
    new: Stage


@dataclass(frozen=True, slots=True)
class WorkItemUpdated:
    """Non-stage update (e.g. title/labels).

    This is intentionally minimal for now; adapters may choose to ignore or expand
    it.
    """

    work_item_id: str

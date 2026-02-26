"""Clawban core (platform-agnostic).

This package defines the canonical stage model, core entities, and helper
utilities for adapter implementations.
"""

from .models import Stage, WorkItem
from .events import WorkItemCreated, WorkItemDeleted, WorkItemUpdated, StageChanged
from .diff import diff_work_items
from .runner import tick

__all__ = [
    "Stage",
    "WorkItem",
    "WorkItemCreated",
    "WorkItemDeleted",
    "WorkItemUpdated",
    "StageChanged",
    "diff_work_items",
    "tick",
]

from __future__ import annotations

from collections.abc import Mapping

from .events import StageChanged, WorkItemCreated, WorkItemDeleted, WorkItemUpdated
from .models import WorkItem


def diff_work_items(
    previous: Mapping[str, WorkItem],
    current: Mapping[str, WorkItem],
) -> list[object]:
    """Diff two work-item snapshots.

    Args:
        previous: Mapping of work item id -> WorkItem from the last snapshot.
        current: Mapping of work item id -> WorkItem from the new snapshot.

    Returns:
        A list of canonical events.

    Notes:
        The event model is intentionally tiny; it will expand as Clawban core
        grows.
    """

    events: list[object] = []

    prev_ids = set(previous)
    curr_ids = set(current)

    for wid in sorted(prev_ids - curr_ids):
        events.append(WorkItemDeleted(work_item_id=wid))

    for wid in sorted(curr_ids - prev_ids):
        events.append(WorkItemCreated(work_item=current[wid]))

    for wid in sorted(prev_ids & curr_ids):
        prev = previous[wid]
        curr = current[wid]

        if prev.stage != curr.stage:
            events.append(StageChanged(work_item_id=wid, old=prev.stage, new=curr.stage))
            continue

        if prev.title != curr.title or prev.labels != curr.labels:
            events.append(WorkItemUpdated(work_item_id=wid))

    return events

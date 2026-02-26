from __future__ import annotations

from clawban.diff import diff_work_items
from clawban.events import StageChanged, WorkItemCreated, WorkItemDeleted
from clawban.models import Stage, WorkItem


def test_diff_emits_created_and_deleted() -> None:
    prev = {
        "1": WorkItem(id="1", title="Old", stage=Stage.from_any("backlog")),
    }
    curr = {
        "2": WorkItem(id="2", title="New", stage=Stage.from_any("queued")),
    }

    events = diff_work_items(prev, curr)

    assert any(isinstance(e, WorkItemDeleted) and e.work_item_id == "1" for e in events)
    assert any(isinstance(e, WorkItemCreated) and e.work_item.id == "2" for e in events)


def test_diff_emits_stage_changed() -> None:
    prev = {
        "1": WorkItem(id="1", title="A", stage=Stage.from_any("backlog")),
    }
    curr = {
        "1": WorkItem(id="1", title="A", stage=Stage.from_any("in-progress")),
    }

    events = diff_work_items(prev, curr)

    stage_changes = [e for e in events if isinstance(e, StageChanged)]
    assert stage_changes == [
        StageChanged(work_item_id="1", old=Stage.from_any("backlog"), new=Stage.from_any("in-progress"))
    ]

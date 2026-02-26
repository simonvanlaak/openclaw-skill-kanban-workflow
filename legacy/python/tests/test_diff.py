from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from clawban.diff import diff_work_items  # noqa: E402
from clawban.events import StageChanged, WorkItemCreated, WorkItemDeleted  # noqa: E402
from clawban.models import Stage, WorkItem  # noqa: E402


class TestDiff(unittest.TestCase):
    def test_diff_emits_created_and_deleted(self) -> None:
        prev = {
            "1": WorkItem(id="1", title="Old", stage=Stage.from_any("backlog")),
        }
        curr = {
            "2": WorkItem(id="2", title="New", stage=Stage.from_any("queued")),
        }

        events = diff_work_items(prev, curr)

        self.assertTrue(any(isinstance(e, WorkItemDeleted) and e.work_item_id == "1" for e in events))
        self.assertTrue(any(isinstance(e, WorkItemCreated) and e.work_item.id == "2" for e in events))

    def test_diff_emits_stage_changed(self) -> None:
        prev = {
            "1": WorkItem(id="1", title="A", stage=Stage.from_any("backlog")),
        }
        curr = {
            "1": WorkItem(id="1", title="A", stage=Stage.from_any("in-progress")),
        }

        events = diff_work_items(prev, curr)

        stage_changes = [e for e in events if isinstance(e, StageChanged)]
        self.assertEqual(
            stage_changes,
            [StageChanged(work_item_id="1", old=Stage.from_any("backlog"), new=Stage.from_any("in-progress"))],
        )


if __name__ == "__main__":
    unittest.main()

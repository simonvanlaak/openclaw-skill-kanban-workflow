from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from clawban.models import Stage  # noqa: E402


class TestStage(unittest.TestCase):
    def test_stage_from_any_normalizes(self) -> None:
        cases = [
            ("stage:backlog", "stage:backlog"),
            ("BACKLOG", "stage:backlog"),
            ("in progress", "stage:in-progress"),
            ("stage:needs-clarification", "stage:needs-clarification"),
            ("needs_clarification", "stage:needs-clarification"),
            ("ready-to-implement", "stage:ready-to-implement"),
        ]
        for value, expected in cases:
            with self.subTest(value=value):
                self.assertEqual(Stage.from_any(value).key, expected)

    def test_stage_from_any_rejects_unknown(self) -> None:
        with self.assertRaises(ValueError):
            Stage.from_any("triage")


if __name__ == "__main__":
    unittest.main()

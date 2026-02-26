from __future__ import annotations

import json
import sys
import unittest
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from clawban.github_adapter import GhCli, GhCliError, GitHubAdapter  # noqa: E402


def _read_fixture(name: str) -> str:
    return (Path(__file__).parent / "fixtures" / name).read_text(encoding="utf-8")


@dataclass
class _Proc:
    returncode: int
    stdout: str = ""
    stderr: str = ""


class TestGitHubAdapter(unittest.TestCase):
    def test_list_open_issues_with_stage_labels_filters_stage_prefix(self) -> None:
        fixture = _read_fixture("issues_open.json")

        def fake_run(args: list[str], check: bool, capture_output: bool, text: bool) -> _Proc:  # type: ignore[override]
            self.assertEqual(args[:3], ["gh", "issue", "list"])
            return _Proc(returncode=0, stdout=fixture)

        with TemporaryDirectory() as td, patch("subprocess.run", new=fake_run):
            adapter = GitHubAdapter(repo="acme/repo", snapshot_path=Path(td) / "snap.json")
            issues = adapter.list_open_issues_with_stage_labels()

        self.assertEqual([i.number for i in issues], [101])
        self.assertTrue(any(lbl.startswith("stage:") for lbl in issues[0].labels))

    def test_add_comment_invokes_gh(self) -> None:
        called: list[list[str]] = []

        def fake_run(args: list[str], check: bool, capture_output: bool, text: bool) -> _Proc:  # type: ignore[override]
            called.append(args)
            return _Proc(returncode=0, stdout="")

        with TemporaryDirectory() as td, patch("subprocess.run", new=fake_run):
            adapter = GitHubAdapter(repo="acme/repo", snapshot_path=Path(td) / "snap.json")
            adapter.add_comment(issue_number=12, body="hello")

        self.assertEqual(
            called,
            [
                [
                    "gh",
                    "issue",
                    "comment",
                    "12",
                    "--repo",
                    "acme/repo",
                    "--body",
                    "hello",
                ]
            ],
        )

    def test_poll_events_since_uses_snapshot_for_dedupe_and_label_diff(self) -> None:
        open_fixture = json.loads(_read_fixture("issues_open.json"))
        updated_fixture = _read_fixture("issues_updated.json")

        def fake_run(args: list[str], check: bool, capture_output: bool, text: bool) -> _Proc:  # type: ignore[override]
            self.assertEqual(args[:3], ["gh", "issue", "list"])
            self.assertIn("--search", args)
            return _Proc(returncode=0, stdout=updated_fixture)

        with TemporaryDirectory() as td, patch("subprocess.run", new=fake_run):
            snap_path = Path(td) / "snap.json"
            snap_path.write_text(
                json.dumps(
                    {
                        "101": {
                            "updatedAt": open_fixture[0]["updatedAt"],
                            "labels": ["stage:queued", "bug"],
                            "title": "First",
                            "url": "https://github.com/acme/repo/issues/101",
                            "state": "OPEN",
                        }
                    }
                ),
                encoding="utf-8",
            )

            adapter = GitHubAdapter(repo="acme/repo", snapshot_path=snap_path)
            since = datetime(2026, 2, 26, 8, 6, 0, tzinfo=timezone.utc)
            events = adapter.poll_events_since(since=since)

            self.assertEqual([e.kind for e in events], ["labels_changed", "created"])
            self.assertEqual(events[0].issue_number, 101)
            self.assertEqual(events[0].details["added"], ["stage:in-progress"])
            self.assertEqual(events[0].details["removed"], ["stage:queued"])
            self.assertEqual(events[1].issue_number, 103)

            saved = json.loads(snap_path.read_text(encoding="utf-8"))

        self.assertEqual(saved["101"]["labels"], ["bug", "stage:in-progress"])
        self.assertEqual(saved["103"]["title"], "Third")
        self.assertEqual(saved["_meta"]["repo"], "acme/repo")


class TestGhCli(unittest.TestCase):
    def test_ghcli_raises_on_nonzero_return(self) -> None:
        def fake_run(args: list[str], check: bool, capture_output: bool, text: bool) -> _Proc:  # type: ignore[override]
            return _Proc(returncode=1, stdout="", stderr="nope")

        with patch("subprocess.run", new=fake_run):
            gh = GhCli()
            with self.assertRaises(GhCliError):
                gh.run(["gh", "status"])


if __name__ == "__main__":
    unittest.main()

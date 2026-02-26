from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest

from clawban.github_adapter import GhCli, GhCliError, GitHubAdapter


def _read_fixture(name: str) -> str:
    return (Path(__file__).parent / "fixtures" / name).read_text(encoding="utf-8")


@dataclass
class _Proc:
    returncode: int
    stdout: str = ""
    stderr: str = ""


def test_list_open_issues_with_stage_labels_filters_stage_prefix(monkeypatch: Any, tmp_path: Path) -> None:
    fixture = _read_fixture("issues_open.json")

    def fake_run(args: list[str], check: bool, capture_output: bool, text: bool) -> _Proc:  # type: ignore[override]
        assert args[:3] == ["gh", "issue", "list"]
        return _Proc(returncode=0, stdout=fixture)

    monkeypatch.setattr("subprocess.run", fake_run)

    adapter = GitHubAdapter(repo="acme/repo", snapshot_path=tmp_path / "snap.json")
    issues = adapter.list_open_issues_with_stage_labels()

    assert [i.number for i in issues] == [101]
    assert issues[0].labels[0].startswith("stage:")


def test_add_comment_invokes_gh(monkeypatch: Any, tmp_path: Path) -> None:
    called: list[list[str]] = []

    def fake_run(args: list[str], check: bool, capture_output: bool, text: bool) -> _Proc:  # type: ignore[override]
        called.append(args)
        return _Proc(returncode=0, stdout="")

    monkeypatch.setattr("subprocess.run", fake_run)

    adapter = GitHubAdapter(repo="acme/repo", snapshot_path=tmp_path / "snap.json")
    adapter.add_comment(issue_number=12, body="hello")

    assert called == [
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
    ]


def test_poll_events_since_uses_snapshot_for_dedupe_and_label_diff(monkeypatch: Any, tmp_path: Path) -> None:
    open_fixture = json.loads(_read_fixture("issues_open.json"))
    updated_fixture = _read_fixture("issues_updated.json")

    # Create a prior snapshot containing issue 101 (with stage:queued)
    snap_path = tmp_path / "snap.json"
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

    def fake_run(args: list[str], check: bool, capture_output: bool, text: bool) -> _Proc:  # type: ignore[override]
        # poll uses issue list with --search
        assert args[:3] == ["gh", "issue", "list"]
        assert "--search" in args
        return _Proc(returncode=0, stdout=updated_fixture)

    monkeypatch.setattr("subprocess.run", fake_run)

    adapter = GitHubAdapter(repo="acme/repo", snapshot_path=snap_path)
    since = datetime(2026, 2, 26, 8, 6, 0, tzinfo=timezone.utc)
    events = adapter.poll_events_since(since=since)

    # 101 changed labels, 103 is new
    assert [e.kind for e in events] == ["labels_changed", "created"]
    assert events[0].issue_number == 101
    assert events[0].details["added"] == ["stage:in-progress"]
    assert events[0].details["removed"] == ["stage:queued"]
    assert events[1].issue_number == 103

    # Snapshot should be updated with 103 and new label for 101.
    saved = json.loads(snap_path.read_text(encoding="utf-8"))
    assert saved["101"]["labels"] == ["bug", "stage:in-progress"]
    assert saved["103"]["title"] == "Third"
    assert saved["_meta"]["repo"] == "acme/repo"


def test_ghcli_raises_on_nonzero_return(monkeypatch: Any) -> None:
    def fake_run(args: list[str], check: bool, capture_output: bool, text: bool) -> _Proc:  # type: ignore[override]
        return _Proc(returncode=1, stdout="", stderr="nope")

    monkeypatch.setattr("subprocess.run", fake_run)

    gh = GhCli()
    with pytest.raises(GhCliError, match="gh command failed"):
        gh.run(["gh", "status"])

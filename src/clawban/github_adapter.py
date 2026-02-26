from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


class GhCliError(RuntimeError):
    """Raised when gh CLI invocation fails."""


def _parse_github_datetime(value: str) -> datetime:
    """Parse GitHub ISO datetimes like '2026-02-26T08:30:00Z'."""

    # GitHub uses Z suffix for UTC.
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _utc_now() -> datetime:
    return datetime.now(tz=timezone.utc)


@dataclass(frozen=True)
class GitHubIssue:
    number: int
    title: str
    url: str
    state: str
    updated_at: datetime
    labels: tuple[str, ...]

    @staticmethod
    def from_gh_json(obj: dict[str, Any]) -> "GitHubIssue":
        labels = tuple(sorted([lbl["name"] for lbl in obj.get("labels", [])]))
        return GitHubIssue(
            number=int(obj["number"]),
            title=str(obj.get("title", "")),
            url=str(obj.get("url", "")),
            state=str(obj.get("state", "")),
            updated_at=_parse_github_datetime(str(obj["updatedAt"])),
            labels=labels,
        )


@dataclass(frozen=True)
class GitHubIssueEvent:
    """A minimal synthesized event based on snapshot diffs."""

    kind: str  # created|updated|labels_changed
    issue_number: int
    updated_at: datetime
    details: dict[str, Any]


class GhCli:
    """Tiny wrapper around `gh` that is easy to mock in tests."""

    def run(self, args: list[str]) -> str:
        proc = subprocess.run(
            args,
            check=False,
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            raise GhCliError(
                f"gh command failed ({proc.returncode}): {' '.join(args)}\n{proc.stderr}".strip()
            )
        return proc.stdout


class GitHubAdapter:
    """Minimal GitHub adapter using `gh` only.

    Capabilities implemented:
    - list open issues with any `stage:*` label
    - add comment
    - add/remove labels
    - poll changes since timestamp with local snapshot diffing
    """

    def __init__(
        self,
        *,
        repo: str,
        snapshot_path: Path,
        gh: GhCli | None = None,
    ) -> None:
        self._repo = repo
        self._snapshot_path = snapshot_path
        self._gh = gh or GhCli()

    def list_open_issues_with_stage_labels(self, *, limit: int = 200) -> list[GitHubIssue]:
        issues = self._list_issues(state="open", limit=limit)
        out: list[GitHubIssue] = []
        for issue in issues:
            if not any(lbl.startswith("stage:") for lbl in issue.labels):
                continue

            # Present stage labels first for downstream stage parsing.
            stage_labels = sorted([l for l in issue.labels if l.startswith("stage:")])
            other_labels = sorted([l for l in issue.labels if not l.startswith("stage:")])
            out.append(
                GitHubIssue(
                    number=issue.number,
                    title=issue.title,
                    url=issue.url,
                    state=issue.state,
                    updated_at=issue.updated_at,
                    labels=tuple(stage_labels + other_labels),
                )
            )
        return out

    def add_comment(self, *, issue_number: int, body: str) -> None:
        self._gh.run(
            [
                "gh",
                "issue",
                "comment",
                str(issue_number),
                "--repo",
                self._repo,
                "--body",
                body,
            ]
        )

    def add_labels(self, *, issue_number: int, labels: Iterable[str]) -> None:
        labels_list = list(labels)
        if not labels_list:
            return
        self._gh.run(
            [
                "gh",
                "issue",
                "edit",
                str(issue_number),
                "--repo",
                self._repo,
                "--add-label",
                ",".join(labels_list),
            ]
        )

    def remove_labels(self, *, issue_number: int, labels: Iterable[str]) -> None:
        labels_list = list(labels)
        if not labels_list:
            return
        self._gh.run(
            [
                "gh",
                "issue",
                "edit",
                str(issue_number),
                "--repo",
                self._repo,
                "--remove-label",
                ",".join(labels_list),
            ]
        )

    def poll_events_since(self, *, since: datetime) -> list[GitHubIssueEvent]:
        """Return synthesized events for issues updated since `since`.

        Uses a local snapshot file for dedupe and to detect label changes.
        Snapshot format is private to this adapter.
        """

        snapshot = self._load_snapshot()

        # Ask GitHub for issues updated since (server-side filtering).
        search = f"is:issue updated:>={since.date().isoformat()}"  # day-granularity
        updated = self._list_issues(state="open", limit=200, search=search)

        events: list[GitHubIssueEvent] = []
        for issue in updated:
            if issue.updated_at < since:
                continue

            prev = snapshot.get(str(issue.number))
            if prev is None:
                events.append(
                    GitHubIssueEvent(
                        kind="created",
                        issue_number=issue.number,
                        updated_at=issue.updated_at,
                        details={"title": issue.title, "labels": list(issue.labels)},
                    )
                )
            else:
                prev_updated_at = _parse_github_datetime(prev["updatedAt"])
                prev_labels = set(prev.get("labels", []))
                curr_labels = set(issue.labels)

                if curr_labels != prev_labels:
                    events.append(
                        GitHubIssueEvent(
                            kind="labels_changed",
                            issue_number=issue.number,
                            updated_at=issue.updated_at,
                            details={
                                "added": sorted(list(curr_labels - prev_labels)),
                                "removed": sorted(list(prev_labels - curr_labels)),
                            },
                        )
                    )
                elif issue.updated_at > prev_updated_at:
                    events.append(
                        GitHubIssueEvent(
                            kind="updated",
                            issue_number=issue.number,
                            updated_at=issue.updated_at,
                            details={},
                        )
                    )

            # Update snapshot entry.
            snapshot[str(issue.number)] = {
                "updatedAt": issue.updated_at.isoformat().replace("+00:00", "Z"),
                "labels": list(issue.labels),
                "title": issue.title,
                "url": issue.url,
                "state": issue.state,
            }

        snapshot["_meta"] = {
            "repo": self._repo,
            "lastPolledAt": _utc_now().isoformat().replace("+00:00", "Z"),
        }
        self._save_snapshot(snapshot)
        return events

    def _list_issues(
        self,
        *,
        state: str,
        limit: int,
        search: str | None = None,
    ) -> list[GitHubIssue]:
        args = [
            "gh",
            "issue",
            "list",
            "--repo",
            self._repo,
            "--state",
            state,
            "--limit",
            str(limit),
            "--json",
            "number,title,url,state,updatedAt,labels",
        ]
        if search:
            args.extend(["--search", search])
        out = self._gh.run(args)
        raw = json.loads(out) if out.strip() else []
        return [GitHubIssue.from_gh_json(obj) for obj in raw]

    def _load_snapshot(self) -> dict[str, Any]:
        if not self._snapshot_path.exists():
            return {}
        return json.loads(self._snapshot_path.read_text(encoding="utf-8"))

    def _save_snapshot(self, snapshot: dict[str, Any]) -> None:
        self._snapshot_path.parent.mkdir(parents=True, exist_ok=True)
        self._snapshot_path.write_text(
            json.dumps(snapshot, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

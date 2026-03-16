#!/usr/bin/env python3
"""plane_webhook_kwf.py

Lightweight Plane webhook receiver.

Goal:
- Reduce the "comment -> ticket moved" latency from cron cadence (e.g. 10 min)
  to near-instant by triggering `kanban-workflow workflow-loop` on webhook POST.
- Trigger `reconcile-human-comment` directly on comment events so review/block
  tickets reopen immediately without depending on the hot workflow loop path.

Security:
- Requires a shared secret token by default (header X-Webhook-Token).
- Never prints secrets.

Operational:
- Returns 200 quickly.
- Uses background process + flock lock via kwf_workflow_loop_once.sh.
- Cron remains as backup.
"""

import json
import os
import re
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from pathlib import Path

LISTEN_HOST = os.getenv("PLANE_WEBHOOK_HOST", "127.0.0.1").strip() or "127.0.0.1"
LISTEN_PORT = int(os.getenv("PLANE_WEBHOOK_PORT", "8791"))
TOKEN = os.getenv("PLANE_WEBHOOK_TOKEN", "").strip()
# If Plane cannot send a custom token header, restrict by source IP instead.
# Comma-separated list of allowed client IPs, for example: "100.118.131.13,127.0.0.1".
ALLOWED_IPS = [
    ip.strip()
    for ip in os.getenv("PLANE_WEBHOOK_ALLOWED_IPS", "").split(",")
    if ip.strip()
]
PATH = os.getenv("PLANE_WEBHOOK_PATH", "/plane/webhook").strip() or "/plane/webhook"
TRIGGER_SCRIPT = os.getenv(
    "PLANE_WEBHOOK_TRIGGER_SCRIPT",
    "/root/.openclaw/workspace/scripts/kwf_workflow_loop_once.sh",
).strip()
RECONCILE_CMD = os.getenv(
    "PLANE_WEBHOOK_RECONCILE_COMMENT_CMD",
    "cd /root/.openclaw/workspace/skills/kanban-workflow && npm run -s kanban-workflow -- reconcile-human-comment --ticket-id '{ticket_id}' --comment-id '{comment_id}'",
).strip()
CACHE_EVENT_FILE = os.getenv(
    "PLANE_WEBHOOK_CACHE_EVENT_FILE",
    "/root/.openclaw/workspace/.tmp/kwf-plane-webhook-events.json",
).strip()
WEBHOOK_LOG_FILE = os.getenv(
    "PLANE_WEBHOOK_LOG_FILE",
    "/var/log/openclaw/plane-webhook-kwf.log",
).strip()
UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
)


def _log_line(message: str, **extra):
    try:
        Path(WEBHOOK_LOG_FILE).parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "message": message,
            **extra,
        }
        with open(WEBHOOK_LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _safe_json(raw: bytes):
    try:
        return json.loads(raw.decode("utf-8", errors="ignore") or "{}")
    except Exception:
        return {}


def _ok_to_trigger(payload: dict) -> bool:
    # We intentionally keep this permissive.
    # Plane webhook event names vary; the safe behavior is: any valid webhook triggers a workflow-loop run.
    # If later we want to narrow, we can check payload.get("event") or payload.get("action").
    return True


def _looks_like_uuid(value):
    if value is None:
        return False
    return bool(UUID_RE.match(str(value).strip()))


def _extract_project_ids(node, out=None):
    if out is None:
        out = set()
    if isinstance(node, dict):
        for key, value in node.items():
            key_l = str(key).lower()
            if key_l in {"project_id", "projectid"} and _looks_like_uuid(value):
                out.add(str(value).strip())
            elif key_l == "project" and isinstance(value, dict):
                project_id = value.get("id") or value.get("project_id") or value.get("projectId")
                if _looks_like_uuid(project_id):
                    out.add(str(project_id).strip())
            _extract_project_ids(value, out)
    elif isinstance(node, list):
        for value in node:
            _extract_project_ids(value, out)
    return out


def _extract_work_item_ids(node, out=None):
    if out is None:
        out = set()
    if isinstance(node, dict):
        for key, value in node.items():
            key_l = str(key).lower()
            if key_l in {"issue_id", "issueid", "work_item_id", "workitemid", "item_id", "itemid"} and _looks_like_uuid(value):
                out.add(str(value).strip())
            elif key_l in {"issue", "work_item", "workitem", "item"} and isinstance(value, dict):
                item_id = value.get("id") or value.get("issue_id") or value.get("work_item_id") or value.get("workItemId")
                if _looks_like_uuid(item_id):
                    out.add(str(item_id).strip())
            _extract_work_item_ids(value, out)
    elif isinstance(node, list):
        for value in node:
            _extract_work_item_ids(value, out)
    return out


def _extract_comment_ids(node, out=None):
    if out is None:
        out = set()
    if isinstance(node, dict):
        for key, value in node.items():
            key_l = str(key).lower()
            if key_l in {"comment_id", "commentid"} and _looks_like_uuid(value):
                out.add(str(value).strip())
            elif key_l in {"issue_comment", "comment"} and isinstance(value, dict):
                comment_id = value.get("id") or value.get("comment_id") or value.get("commentId")
                if _looks_like_uuid(comment_id):
                    out.add(str(comment_id).strip())
            _extract_comment_ids(value, out)
    elif isinstance(node, list):
        for value in node:
            _extract_comment_ids(value, out)
    return out


def _append_cache_events(payload: dict):
    project_ids = sorted(_extract_project_ids(payload))
    item_ids = sorted(_extract_work_item_ids(payload))
    if not project_ids or not item_ids:
        return

    os.makedirs(os.path.dirname(CACHE_EVENT_FILE), exist_ok=True)

    try:
        with open(CACHE_EVENT_FILE, "r", encoding="utf-8") as fh:
            existing = json.load(fh)
    except Exception:
        existing = {"version": 1, "events": []}

    events = existing.get("events") if isinstance(existing, dict) else []
    if not isinstance(events, list):
        events = []

    dedupe = {}
    for event in events:
        if not isinstance(event, dict):
            continue
        item_id = str(event.get("id") or "").strip()
        project_id = str(event.get("projectId") or event.get("project_id") or "").strip()
        if not item_id:
            continue
        dedupe[(project_id, item_id)] = {
            "id": item_id,
            "projectId": project_id or None,
            "seenAt": event.get("seenAt") or event.get("seen_at"),
        }

    seen_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    for project_id in project_ids:
        for item_id in item_ids:
            dedupe[(project_id, item_id)] = {
                "id": item_id,
                "projectId": project_id,
                "seenAt": seen_at,
            }

    temp_path = f"{CACHE_EVENT_FILE}.{os.getpid()}.tmp"
    with open(temp_path, "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "events": list(dedupe.values())}, fh)
        fh.write("\n")
    os.replace(temp_path, CACHE_EVENT_FILE)


def _spawn_reconcile_human_comment(payload: dict):
    work_item_ids = sorted(_extract_work_item_ids(payload))
    comment_ids = sorted(_extract_comment_ids(payload))
    if not work_item_ids or not comment_ids:
        _log_line(
            "webhook-comment-reconcile-skipped",
            ticket_ids=work_item_ids,
            comment_ids=comment_ids,
        )
        return

    for ticket_id in work_item_ids:
        for comment_id in comment_ids:
            cmd = RECONCILE_CMD.format(ticket_id=ticket_id, comment_id=comment_id)
            _log_line(
                "webhook-comment-reconcile-spawn",
                ticket_id=ticket_id,
                comment_id=comment_id,
            )
            subprocess.Popen(
                ["bash", "-lc", cmd],
                start_new_session=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=os.environ.copy(),
            )


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: str):
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))

    def do_POST(self):
        if self.path.split("?", 1)[0] != PATH:
            return self._send(404, "not found")

        client_ip = (self.client_address[0] or "").strip()

        # Auth:
        # - Prefer shared token (header or query param).
        # - If Plane UI cannot send a custom header, fall back to source-IP allowlist.
        got = (self.headers.get("X-Webhook-Token") or "").strip()
        if not got:
            q = parse_qs(urlparse(self.path).query)
            got = (q.get("token") or [""])[0].strip()

        ip_allowed = client_ip in ALLOWED_IPS

        # If a TOKEN is configured, require token OR (if configured) source IP allowlist match.
        if TOKEN:
            if got == TOKEN:
                pass
            elif ALLOWED_IPS and ip_allowed:
                pass
            else:
                return self._send(403, "forbidden")

        # If no TOKEN is configured but ALLOWED_IPS is, enforce IP allowlist.
        if (not TOKEN) and ALLOWED_IPS and (not ip_allowed):
            return self._send(403, "forbidden")

        n = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(n) if n > 0 else b""
        payload = _safe_json(raw)
        _log_line(
            "webhook-post",
            client_ip=client_ip,
            has_token=bool(got),
            content_length=n,
            project_ids=sorted(_extract_project_ids(payload)),
            ticket_ids=sorted(_extract_work_item_ids(payload)),
            comment_ids=sorted(_extract_comment_ids(payload)),
        )

        if not _ok_to_trigger(payload):
            return self._send(200, "ignored")

        try:
            _append_cache_events(payload)
        except Exception:
            # Best-effort cache hints only; cron and reconcile remain the backup.
            pass

        try:
            _spawn_reconcile_human_comment(payload)
        except Exception:
            # Best-effort only; fallback scan and manual reconcile remain available.
            pass

        try:
            subprocess.Popen(
                ["bash", "-lc", TRIGGER_SCRIPT],
                start_new_session=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=os.environ.copy(),
            )
            _log_line("webhook-workflow-trigger-spawned")
        except Exception as e:
            # Best-effort only, cron remains the backup.
            _log_line("webhook-workflow-trigger-failed", error=str(e)[:200])
            return self._send(500, f"trigger failed: {str(e)[:120]}")

        return self._send(200, "ok")

    def log_message(self, fmt: str, *args):
        # Keep default server logs quiet; rely on workflow-loop webhook log file.
        return


def main():
    srv = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    print(f"[plane-webhook-kwf] listening on {LISTEN_HOST}:{LISTEN_PORT}{PATH}")
    srv.serve_forever()


if __name__ == "__main__":
    main()

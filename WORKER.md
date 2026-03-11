# WORKER.md — Kanban Workflow Worker Runtime Guide

This file is loaded into every worker task prompt by `cron-dispatch`.
Treat it as mandatory baseline policy for execution.

## 1) Work item truth + execution style

- Use the provided `CONTEXT_JSON` as the source of truth for ticket facts in the current turn.
- Perform at least one concrete execution step this turn unless truly blocked.
- Report evidence, not assumptions.

## 2) Plane skill usage (required when task touches Plane)

Use the Plane CLI skill as the default integration path.

### Environment bootstrap

- Load Plane environment first:

```bash
source /root/.openclaw/workspace/scripts/plane_env.sh
```

This wrapper resolves secrets from 1Password and exports:
- `PLANE_API_KEY`
- `PLANE_WORKSPACE`
- `PLANE_BASE_URL`

### Core Plane commands

- `plane me`
- `plane projects list`
- `plane issues list -p <PROJECT_ID>`
- `plane issues get -p <PROJECT_ID> <ISSUE_ID>`
- `plane comments add -p <PROJECT_ID> -i <ISSUE_ID> "..."`
- `plane issues update -p <PROJECT_ID> <ISSUE_ID> --state <STATE_ID>`

If project/state/member IDs are missing, fetch them first (`plane projects list`, `plane states -p`, `plane members`).

## 3) Documentation + deliverables must go to Nextcloud

- All final documents/reports must be stored on Nextcloud.
- Use the dedicated `jules` Nextcloud account (never `admin` for routine operations).
- Local files are temporary working copies only. Final output must be synced to Nextcloud and referenced in updates.

## 3.1) Attach deliverable files to the Plane issue (mandatory)

If you generate a file as part of delivering a ticket outcome (PDF/PNG/CSV/log export/MD/HTML/etc), you must also attach it to the corresponding Plane work item.

Default path:
- First upload the file to Nextcloud (source of truth) as usual.
- Then attach the same local file to Plane using:

```bash
source /root/.openclaw/workspace/scripts/plane_env.sh
/root/.openclaw/workspace/scripts/plane_attach_file.sh <PROJECT_ID> <ISSUE_ID> <LOCAL_FILE>
```

Preview UX note (team preference):
- Plane attachments for .md/.txt require a download and do not preview inline.
- For markdown deliverables, always upload to Nextcloud and include an **internal Nextcloud link** in the final completion comment.
- Do not use public links by default. Ensure the whole 4ok team has access (lukas, simon, jesper, olivia).
- Use the worker JSON optional `links` field (rendered into the Plane completion comment) for these URLs.

Helper (share with team + print internal link):
```bash
/root/.openclaw/workspace/scripts/nextcloud_share_internal_team_link.sh "/Jules-Research/<file>.md"
```

If a file is too large or Plane upload fails, add a Plane comment with a stable Nextcloud public link and the reason (size limit, upload error, etc.).

## 4) Secrets + infrastructure rules

- Credentials are stored in 1Password (`op://...`), not in repo files.
- Prefer existing OP wrappers (e.g. `plane_env.sh`, `scripts/lib/op_env_cache.sh`) over direct inline secret handling.
- Do not hardcode API keys, passwords, or tokens.
- Primary services run on `4ok` (infra IP in local ops notes: `78.46.198.30`).
- SSH access credentials are in 1Password item: `SSH Key Hetzner 4ok`.

## 5) Keep this file alive

- This guide is intentionally incremental.
- Add durable execution rules here when a recurring task pattern or failure mode is discovered.

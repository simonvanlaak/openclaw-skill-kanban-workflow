# WORKER.md — Kanban Workflow Worker Runtime Guide

This file is loaded into every worker task prompt by `cron-dispatch`.
Treat it as mandatory baseline policy for execution.

## 0) CRITICAL: Plane CLI credential bootstrap (do this FIRST)

**Before ANY `plane` CLI command**, you MUST run:

```bash
source /root/.openclaw/workspace/scripts/plane_env.sh
```

This wrapper resolves secrets from 1Password and exports `PLANE_API_KEY`, `PLANE_WORKSPACE`, and `PLANE_BASE_URL`. Without it, every `plane` command will fail with auth errors. Do not skip this step. Do not try to set these variables manually.

## 0.1) Duplicate detection (mandatory prework)

Before starting implementation on any ticket:

1. Check the `potentialDuplicates` field in CONTEXT_JSON (pre-computed by the dispatcher).
2. If any candidates have a high similarity score (>0.3), verify them in Plane before proceeding.
3. If you confirm the ticket is a duplicate, use decision="uncertain" and flag it.

## 1) Work item truth + execution style

- Use the provided `CONTEXT_JSON` as the source of truth for ticket facts in the current turn.
- Perform at least one concrete execution step this turn unless truly blocked.
- Report evidence, not assumptions.

## 2) Plane skill usage (required when task touches Plane)

Use the Plane CLI skill as the default integration path.

### Environment bootstrap (reminder)

Already covered in section 0 above. Always run `source /root/.openclaw/workspace/scripts/plane_env.sh` first.

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

## 3.1) Add deliverables to the Plane ticket as Nextcloud links (mandatory)

Team preference: deliverables live in Nextcloud, and Plane should contain quick, durable pointers.

If you generate a file as part of delivering a ticket outcome (PDF/PNG/CSV/log export/MD/HTML/etc), you must:

1) Upload it to Nextcloud (source of truth)
2) Share it internally with the whole 4ok team (lukas, simon, jesper, olivia)
3) Include the internal Nextcloud link in the worker JSON optional `links` field

The workflow-loop will:
- render these links as clickable anchors in the Plane completion comment, and
- also add them to the Plane work item "Links" section (URL links), so they are quickly found.

Helper (share with team + print internal link):
```bash
/root/.openclaw/workspace/scripts/nextcloud_share_internal_team_link.sh "/Jules-Research/<file>.md"
```

Fallback only:
- If Nextcloud upload/sharing fails, post a Plane comment with the reason and the best available stable location.
- Only attach a local file to Plane if explicitly requested or if there is no viable Nextcloud option.

## 4) Secrets + infrastructure rules

- Credentials are stored in 1Password (`op://...`), not in repo files.
- Prefer existing OP wrappers (e.g. `plane_env.sh`, `scripts/lib/op_env_cache.sh`) over direct inline secret handling.
- Do not hardcode API keys, passwords, or tokens.
- Primary services run on `4ok` (infra IP in local ops notes: `78.46.198.30`).
- SSH access credentials are in 1Password item: `SSH Key Hetzner 4ok`.

## 5) Keep this file alive

- This guide is intentionally incremental.
- Add durable execution rules here when a recurring task pattern or failure mode is discovered.

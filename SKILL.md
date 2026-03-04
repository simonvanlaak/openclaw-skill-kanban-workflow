---
name: kanban-workflow
description: Plane-only workflow-loop automation for ticket execution using strict worker JSON outcomes and local CLI orchestration.

requirements:
  binaries:
    - node
    - npm
    - plane
  node:
    install: npm ci
  env:
    required: []
    optional:
      - PLANE_API_KEY
      - PLANE_WORKSPACE
      - PLANE_BASE_URL
---

# Kanban Workflow

## Goal

Run a Plane-only ticket workflow with:
- deterministic local loop orchestration (`workflow-loop`),
- one worker session per ticket,
- strict worker JSON decisions (`blocked | completed | uncertain`) with schema validation and deterministic fallback.

## Canonical Stages

- `stage:todo`
- `stage:blocked`
- `stage:in-progress`
- `stage:in-review`

Done/closed remains platform-specific.

## Architecture

- Workflow-loop (local CLI/script): selection, dispatch, mutation application, session-map persistence.
- Worker agent: executes ticket work and returns strict JSON output.
- Validator/action mapper: validates worker JSON and applies comment + stage mutation.

## Command Surface

- `setup`
- `workflow-loop`
- `show`
- `create`
- `help`

Removed from user CLI:
- `next`
- `start`
- `update`
- `ask`
- `complete`

## Setup Contract

`setup` requires:
- `--adapter plane`
- `--plane-workspace-slug <slug>`
- `--plane-scope all-projects`
- all four stage mapping flags

`create` requires:
- `--project-id <uuid>`

## Workflow-loop Rules

- Enforce whoami-aware assignee gating for actionable work.
- Merge backlog across Plane projects; sort by priority, then title alphabetical on ties.
- Poll-only behavior: if active ticket is unchanged, exit quietly.
- Worker output must be JSON-only and pass strict schema validation.
- Retry invalid worker JSON up to 2 times with all schema errors + schema contract in retry prompt.
- If still invalid on the 3rd total attempt, fallback defaults to `blocked`.
- Apply decision mutation and post a standardized structured comment.
- Reconcile dispatcher-owned queue-position comments for all queued backlog tickets (create/update/delete).

## Session Lifecycle

- Worker: one session per ticket, reused across unblocks.
- Blocked worker sessions archived after 7 days.

## Validation

Before changes/PRs:

```bash
npx tsc --noEmit
npm test
```

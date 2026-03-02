---
name: kanban-workflow
description: Plane-only workflow-loop automation for ticket execution using worker + decision agents, with local CLI orchestration.

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
- forced triage decisions (`continue | blocked | completed`) via a decision agent.

## Canonical Stages

- `stage:todo`
- `stage:blocked`
- `stage:in-progress`
- `stage:in-review`

Done/closed remains platform-specific.

## Architecture

- Workflow-loop (local CLI/script): selection, dispatch, mutation application, session-map persistence.
- Worker agent: executes ticket work and returns markdown evidence report.
- Decision agent: maps worker report to exactly one decision (`continue|blocked|completed`).

## Command Surface

- `setup`
- `workflow-loop`
- `show`
- `create`
- `help`

Removed from user CLI:
- `autopilot-tick`
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
- One retry when required worker-report facts are missing.
- Hard continue limit: max 2 continues per ticket, then only blocked/completed allowed.
- If decision output is unparsable, fallback defaults to `blocked`.
- Apply decision mutation and post a free-text summary comment.

## Session Lifecycle

- Worker: one session per ticket, reused across unblocks.
- Decision agent: rolling session, max 5 tickets, rotate early at 50% token usage.
- Blocked worker sessions archived after 7 days.

## Validation

Before changes/PRs:

```bash
npx tsc --noEmit
npm test
```

---
name: clawban
description: Core "Clawban" skill (TypeScript): a stage-based (stage:queued/needs-clarification/ready-to-implement/in-progress/in-review/blocked) project-management coworker architecture with CLI-auth adapters (gh, planka, openproject, etc.), runbooks/SOP assets, polling + snapshot-diff event synthesis, and cron/webhook-friendly entrypoints. Use when designing, implementing, or extending a pluggable PM integration layer for OpenClaw that avoids direct HTTP auth handling.
---

# Clawban (core)

## Goal

Provide a reusable core for a project-management “co-worker” that:

- Uses the existing `stage:*` lifecycle as the canonical state machine.
- Integrates with PM platforms via **CLI-managed auth** only (no direct HTTP auth handling).
- Centralizes workflow/rules/runbooks so GitHub/Planka/OpenProject implementations share logic.

## Canonical stage model

Treat these labels/states as canonical:

- `stage:backlog`
- `stage:queued`
- `stage:needs-clarification`
- `stage:ready-to-implement`
- `stage:in-progress`
- `stage:in-review`
- `stage:blocked`
- Done/closed (platform-specific)

Adapters map platform concepts (labels, lists, statuses, custom fields) to this set.

## Architecture (ports & adapters)

### Core (platform-agnostic)

- Canonical entities: `WorkItem`, `Project`, `Comment`, `Stage`.
- Canonical events: `WorkItemCreated`, `WorkItemUpdated`, `StageChanged`, `CommentAdded`, etc.
- Workflow engine: stage-based worker loop + clarification/comment templates.
- State: cursors + dedupe + snapshots for diffing.

### Adapters (platform-specific)

Adapters are “smart wrappers” that:

- Call existing CLIs (e.g. `gh`), relying on their auth/session.
- Compose multiple CLI calls to implement higher-level operations.
- Synthesize events by polling + snapshot diffing when webhooks or event types are missing.

## Entry points

- `clawban tick`: one deterministic pass (poll → normalize → apply rules → emit actions)
- `clawban webhook`: optional inbound webhook receiver *only where feasible without taking over auth*

## Recommended repo layout

- `scripts/`: deterministic helper scripts used by adapters or the core.
- `references/`: schemas and adapter notes (loaded on demand).
- `assets/`: runbooks/SOP templates.

## Repo status

- The **current core implementation is in TypeScript** under `src/`.

## Next implementation steps

1) Define/extend the internal adapter interface (TypeScript port) for each platform.
2) Implement a `github_adapter` that shells out to `gh` + local snapshot diffing.
3) Add adapter stubs for Planka and OpenProject (CLI-based).

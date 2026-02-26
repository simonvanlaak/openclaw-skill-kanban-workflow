# Clawban requirements (draft)

This document captures the initial Q&A requirements for Clawban’s verb-level workflow API.

## Design constraints

- **Canonical state machine:** use existing `stage:*` lifecycle.
- **CLI-auth only:** adapters must rely on platform CLIs for authentication/session. No direct HTTP auth handling in Clawban.
- **Cross-platform:** GitHub, Planka, Plane, Linear.

## Required verbs (MVP)

### 1) `next`

**Goal:** return the next work item the agent should work on.

- Primary need: *only* `next` for discovery/selection.
- Selection policy TBD (see open questions), but should be deterministic.

### 2) Task interaction verbs (3 outcomes)

For a selected task, the agent has exactly three user-facing actions:

- `update` — post a progress update (comment only)
- `complete` — mark task complete (and automatically move it to `stage:in-review`)
- `ask` — request clarification (and move to `stage:needs-clarification`)

### 3) `start`

- Required stage change verb: `start`.
- Behavior: transition task into `stage:in-progress`.

### 4) `create`

**Goal:** create a new task in `stage:queued` and automatically assign it to the agent itself.

- Must create work item in the target platform.
- Must apply/encode `stage:queued`.
- Must assign to the agent identity.

## Not required (explicitly)

- Assignment verbs (`assign`, `unassign`) are **not** needed beyond `create` auto-assign.
- Explicit `transition` to `stage:in-review` is **not** needed (happens automatically on `complete`).
- `sync-stages` is **not** needed.

## Automation rules

### Auto-reopen

Reopening should happen automatically when a human comments on a task that is:

- `stage:blocked`, or
- `stage:in-review`

(Exact target stage on reopen is TBD; likely `stage:in-progress` or `stage:queued` depending on context.)

## Open questions

1) **Definition of “next”:**
   - Which stage(s) are eligible? (`stage:ready-to-implement` only vs also `stage:queued`?)
   - Is it FIFO by created time, updated time, or explicit priority?
   - What is the scope input? (repo/project/workspace/team)

2) **Agent identity for auto-assign on `create`:**
   - For each platform (GitHub/Plane/Linear/Planka), what is the identifier for “assign to the agent itself”? (username/userId/service account)

3) **Auto-reopen policy details:**
   - On human comment, reopen to which stage?
   - Should the agent post an automatic acknowledgement comment?

## Implementation notes (for later)

- These verbs imply the adapter port must support idempotent writes:
  - post comment
  - create work item
  - set stage (platform state/labels/lists)
  - set assignee (create only)
- `next` + auto-reopen require polling/diffing event detection unless the platform webhook/CLI provides events.

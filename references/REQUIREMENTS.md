# Clawban requirements (draft)

This document captures the initial Q&A requirements for Clawban’s verb-level workflow API.

## Design constraints

- **Canonical state machine:** use existing `stage:*` lifecycle.
- **CLI-auth only:** adapters must rely on platform CLIs for authentication/session. No direct HTTP auth handling in Clawban.
- **Cross-platform:** GitHub, Planka, Plane, Linear.

## Canonical stage names

Clawban’s canonical stages are (and these are the **only** stages the agent should consider):

- `stage:backlog`
- `stage:blocked`
- `stage:in-progress`
- `stage:in-review`

Notes:
- “Done/closed” is platform-specific and not currently part of the canonical stage set.

## Required verbs (MVP)

### 0) `show`

**Goal:** show the content of a specific ticket/work item on demand (even if it is not the next item).

- Input: platform scope + work item identifier.
- Output: title, current stage, URL, **full body/description**, relevant metadata (assignees/labels/state), and the **last 10 comments** (most recent first), including **private/internal** comments where supported.
- Also include: titles of any linked/related tickets (e.g., blocks/blocked-by/duplicates) where supported.
- Use case: follow linked/blocked tickets during implementation.

### 1) `next`

**Goal:** return the next work item the agent should work on.

- Primary need: *only* `next` for discovery/selection.
- Selection policy TBD (see open questions), but should be deterministic.

### 2) Task interaction verbs (3 outcomes)

For a selected task, the agent has exactly three user-facing actions:

- `update` — post a progress update (comment only). **No enforced template**; post the provided text as-is.
- `complete` — post a **Completed** comment and mark task complete (automatically move it to `stage:in-review`)
- `ask` — post a clarification request comment and move the task to `stage:blocked`

### 3) `start`

- Required stage change verb: `start`.
- Behavior: transition task into `stage:in-progress`.

### 4) `create`

**Goal:** create a new task in `stage:backlog` and automatically assign it to the agent itself.

- Must create work item in the target platform.
- Must apply/encode `stage:backlog`.
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

Reopen target stage:
- On human comment, automatically move the task to `stage:backlog`.

## CLI identity discovery (“self”) requirement

For `create` (auto-assign to self) and any future ownership logic, Clawban must be able to discover the current authenticated user from the platform CLI.

- **GitHub:** use `gh api user` → `login`
- **Linear:** use `linear-cli whoami` (viewer)
- **Plane:** use `plane-cli` request `/api/v1/users/me/`
- **Planka:** `planka-cli status` shows the current user, but output is human-formatted.
  - **Recommended approach:** ship a small **wrapper script** (CLI-auth compliant) that returns `whoami` as **JSON** for Planka, rather than parsing formatted output.

## Open questions

1) **Definition of `next`:**
   - **Guard:** first check whether the agent already has a task in `stage:in-progress`. If yes, `next` must return an error (do not assign a second task).
   - **Eligible pool:** if there is nothing in progress, pull from `stage:backlog`.
   - **Empty behavior:** if `stage:backlog` is empty, return an **info** response indicating there is no work to do.
   - Scope input: repo/project/workspace/team.
   - **Ordering:** if the platform supports a human-defined priority/custom order, `next` must respect it.
     - **GitHub:** use **GitHub Project board ordering** as the explicit human-defined order.
     - **Plane:** use the **manual order in the UI**.
     - **Linear:** use the **manual order in a view**.
     - **Planka:** use **card position in the list**.
   - If no explicit order is available, fall back to **most recently updated first**.

2) **`create` payload + assignment details:**
   - `create` must accept: **title + description/body in Markdown**.
   - Do we require applying `stage:backlog` via label/state/list *in addition* to the platform’s default state?
   - For each platform, what identifier should be used for “assign to self”? (prefer CLI `whoami` JSON → stable user id)

3) **Auto-reopen policy details:**
   - On human comment, reopen to which stage? (likely `stage:in-progress` vs `stage:ready-to-implement`)
   - Should auto-reopen also un-block (i.e., remove `stage:blocked`) or just move stage?
   - Should the agent post an automatic acknowledgement comment?

4) **Message formats:**
   - Should `update/ask/complete` comments be plain Markdown, HTML, or platform-native?
   - Should Clawban standardize a small template (prefixes like "Update:" / "Clarification needed:" / "Completed:")?

## Implementation notes (for later)

- These verbs imply the adapter port must support idempotent writes:
  - post comment
  - create work item
  - set stage (platform state/labels/lists)
  - set assignee (create only)
- `next` + auto-reopen require polling/diffing event detection unless the platform webhook/CLI provides events.

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

## Setup

Clawban must provide a `setup` command to configure enabled adapters and scope/order mappings.

- Setup must be **flags-only / non-interactive** (scriptable).
- Setup currently supports configuring **exactly one** active adapter (GitHub *or* Plane *or* Linear *or* Planka).
- Setup must collect a **stage mapping** for the selected adapter: map platform-specific state/list names to the 4 canonical stages.
  - Mapping is required for **all 4** canonical stages (no partial mapping).- Setup must test that required CLIs are installed and authenticated and **fail hard** if the selected adapter check fails.
  - Setup must validate all **read-only verbs** for the selected adapter: `show` prerequisites (read body/description, list comments, list attachments where supported) and `next` prerequisites (list backlog + ordering inputs).
- Setup validations are **read-only** (no comments/transitions/creates during setup).
- Setup must configure the explicit human ordering source (e.g., GitHub Project selection) for the selected adapter.
- Config storage: store config in-repo (versionable) under `config/clawban.json`.
- Only **one** config file/profile is supported (no multiple profiles).
- `setup` must require an explicit `--force` to overwrite an existing `config/clawban.json`.

## Required verbs (MVP)

### 0) `show`

**Goal:** show the content of a specific ticket/work item on demand (even if it is not the next item).

- Input: platform scope + work item identifier.
- Output: title, current stage, URL, **full body/description**, relevant metadata (assignees/labels/state), **attachments (filename + URL) where supported**, and the **last 10 comments** (most recent first), including **private/internal** comments where supported.
- Also include: titles of any linked/related tickets (e.g., blocks/blocked-by/duplicates) where supported.
- Use case: follow linked/blocked tickets during implementation.

### 1) `next`

**Goal:** return the next work item the agent should work on.

- `next` returns **exactly one** ticket (no "up next" list).
- `next` must return the same payload shape as `show` (i.e., it should reuse the `show` implementation to display the selected ticket: full body/description, last 10 comments incl. private, and titles of linked/related tickets where supported).

- Primary need: *only* `next` for discovery/selection.
- Selection policy TBD (see open questions), but should be deterministic.

### 2) `update`

- Post a progress update comment on a task.
- **No enforced template**; post the provided text as-is.
- No stage change.

### 3) `complete`

- Requires a short completion **summary** string.
- Post a **Completed** comment including that summary.
- Move the task to `stage:in-review`.

### 4) `ask`

- Requires clarification request **text**.
- Post a clarification request comment including that text.
- Move the task to `stage:blocked`.

### 5) `start`

- Required stage change verb: `start`.
- Behavior: transition task into `stage:in-progress`.
- No comment is posted on `start`.

### 6) `create`

**Goal:** create a new task in `stage:backlog` and automatically assign it to the agent itself.

- Must create work item in the target platform.
- Must apply/encode `stage:backlog`.
- Must assign to the agent identity.
- Keep `create` minimal for now (no linked-ticket relationships created at creation time).
- `create` does **not** auto-start; it leaves the task in `stage:backlog`.

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
- Auto-reopen is silent (no automatic comment is posted).

## CLI identity discovery (“self”) requirement

For `create` (auto-assign to self) and any future ownership logic, Clawban must be able to discover the current authenticated user from the platform CLI.

- **GitHub:** use `gh api user` → `login`
- **Linear:** use `linear-cli whoami` (viewer)
- **Plane:** use `plane-cli` request `/api/v1/users/me/`
- **Planka:** `planka-cli status` shows the current user, but output is human-formatted.
  - **Recommended approach:** ship a small **wrapper script** (CLI-auth compliant) that returns `whoami` as **JSON** for Planka, rather than parsing formatted output.

## Open questions

1) **Definition of `next`:**
   - **Guard:** first check whether the agent already has task(s) in `stage:in-progress`.
     - If **exactly 1** task is in progress: `next` must return an error (do not assign a second task).
     - If **more than 1** task is in progress: `next` must return an error (inconsistent state; requires human intervention).
   - **Ignore in-review:** `next` ignores tickets in `stage:in-review`.
   - **Eligible pool:** if there is nothing in progress, pull from `stage:backlog`.
   - **Empty behavior:** if `stage:backlog` is empty, return an **info** response indicating there is no work to do.
   - Scope input: repo/project/workspace/team.
   - **Ordering:** if the platform supports a human-defined priority/custom order, `next` must respect it.
     - **GitHub:** use **GitHub Project board ordering** as the explicit human-defined order.
       - Configured during setup via **project number**.
     - **Plane:** prefer the **manual order in the UI** if it is available via API/CLI output.
       - If Plane manual order cannot be determined, fall back to **most recently updated first**.
     - **Linear:** prefer the **manual order in a view** (configured during setup via **view id**) if it is accessible via CLI output.
       - If Linear manual view order cannot be determined, fall back to **most recently updated first**.
     - **Planka:** use **card position in the list** (after mapping lists → canonical stages).
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
   - All user-provided text for `update/ask/complete` is **Markdown**.
   - Adapters may convert Markdown to platform-native formats if required, but Markdown is the canonical input.

## Documentation requirements

- When implementing or changing behavior, keep **README.md** and **SKILL.md** in sync with the current requirements and available commands.

## Implementation notes (for later)

- These verbs imply the adapter port must support idempotent writes:
  - post comment
  - create work item
  - set stage (platform state/labels/lists)
  - set assignee (create only)
- `next` + auto-reopen require polling/diffing event detection unless the platform webhook/CLI provides events.

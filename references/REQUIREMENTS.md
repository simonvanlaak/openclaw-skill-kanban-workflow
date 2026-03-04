# Kanban Workflow Requirements (active baseline)

Status: active
Scope: Plane-only
Last updated: 2026-03-02

This document is the authoritative requirements baseline moving forward.

## 1) Product direction

- Kanban Workflow is Plane-only.
- Remove/ignore GitHub, Linear, and Planka requirements for now.
- Workflow is autopilot-first.
- Direct manual CLI mutation commands are removed from user-facing flow.

## 2) Canonical stage model

Canonical stages (only stages considered by the workflow):

- `stage:todo`
- `stage:blocked`
- `stage:in-progress`
- `stage:in-review`

Done/closed remains platform-specific and outside the canonical set.

## 3) Setup

Setup is non-interactive and flags-only.

Command:
- `kanban-workflow setup --adapter plane ...`

Required flags:
- `--adapter plane`
- `--force` required to overwrite existing `config/kanban-workflow.json`
- `--map-backlog <plane-state-name>`
- `--map-blocked <plane-state-name>`
- `--map-in-progress <plane-state-name>`
- `--map-in-review <plane-state-name>`
- `--plane-workspace-slug <slug>`
- `--plane-scope all-projects`

Optional flags:
- `--plane-order-field <field>`
- `--autopilot-cron-expr <cron>`
- `--autopilot-cron-tz <tz>`
- `--autopilot-install-cron`
- `--autopilot-requeue-target-stage <stage key>`

Setup validations:
- Fail hard if Plane CLI/auth prerequisites fail.
- Validate read prerequisites for `show` and selection prerequisites for `workflow-loop`.
- Validations are read-only.

Config:
- Single config profile only.
- Stored at `config/kanban-workflow.json`.
- Plane scope is all projects; mapped state names must remain consistent across monitored projects.

## 4) Command surface (user-facing)

Supported user-facing commands:
- `setup`
- `show --id <ticket-id>`
- `create --project-id <uuid> --title "..." [--body "..."]`
- `workflow-loop [--dry-run]`

Not part of user-facing flow:
- Direct manual mutation commands (`start`, `update`, `ask`, `complete`) are removed.
- Any legacy human-invoked mutation aliases are out of scope.

## 5) Core behavior requirements

### 5.1 `show`

`show` returns full Plane ticket context for implementation work.

Required fields:
- id
- title
- URL (if available)
- canonical stage
- full description/body (best available full text)
- labels (if available)
- assignees
- updatedAt
- last 10 comments (newest first), including internal/private comments when available

Each comment entry includes:
- author (best available identity fields)
- timestamp
- content

Optional fields (when available from Plane surfaces):
- attachments
- linked/related ticket summaries

Behavior for optional fields:
- Missing optional fields are silent; do not error when attachment/link data is unavailable.

### 5.2 `create`

- Input: project id + title + Markdown body.
- `--project-id` is mandatory.
- Create in Plane backlog stage (`stage:todo`) via explicit stage enforcement.
- Must assign to the current authenticated user.
- Fail hard if self-resolution fails.
- Fail hard if assignment fails.
- Does not auto-start.
- Failure messages should be short and direct.

### 5.3 Comment/stage mutation semantics

Workflow-level mutation outcomes remain:
- clarification/block comment + move to `stage:blocked`
- completion comment + move to `stage:in-review`
- start/move to `stage:in-progress`

These are automation/engine actions, not direct user-facing CLI commands.

## 6) Workflow Loop

### 6.1 Autopilot-first operation

`workflow-loop` is the primary execution path.

Identity gating:
- All workflow-loop selection and work-permission checks are enforced by authenticated worker identity.
- Only tickets assigned to the authenticated worker (`whoami`) are actionable.

Worker execution model:
- Workflow-loop starts worker runs via local OpenClaw agent CLI calls (`openclaw agent`) using explicit `--agent` and per-ticket `--session-id`.
- Worker executes in isolated session and produces a final strict JSON work result.
- Workflow-loop consumes worker result (announce payload and/or transcript), evaluates forced-choice policy, then performs exactly one mutation action.
- Worker sessions are per-ticket and persistent across ticket pauses/requeues (e.g., blocked -> unblocked resume) so prior ticket-specific context is preserved.
- Worker session closes/archives when the ticket is completed.
- For blocked tickets, archive worker session after 7 days of inactivity.
- No additional session-summary persistence is required; ticket comments are the source of historical context.
- Workflow-loop enforces single active worker at a time.
- While a worker is active, workflow-loop must not select/start new ticket work; it performs housekeeping only:
  - worker completion/status checks
  - retry/fallback enforcement
  - auto-reopen processing
  - no-work detection when applicable

### 6.2 Auto-reopen

Trigger:
- Human comment on a ticket currently in `stage:blocked` or `stage:in-review`.

Action:
- Move ticket silently to `stage:todo`.
- No automatic reopen comment.

### 6.3 Continuous timed progress comments

- Disabled.
- Remove periodic 5-minute auto progress-comment behavior and implementation.

### 6.4 In-progress auto-heal

- Auto-heal behavior is enabled.
- If in-progress state drifts beyond allowed worker limits, automation deterministically keeps the newest in-progress ticket and moves older extra tickets back to `stage:todo` for the same authenticated worker.

### 6.5 Completion/blocked/uncertain decision policy

- Forced-choice decision policy is required.
- Decision source is validated worker JSON output (with deterministic fallback handling when invalid).
- Worker result format is strict JSON (single object), not Markdown.
- Required decision facts:
  - decision
  - completed steps
  - evidence links/details (`evidence`)
  - solution summary for completion
  - blocker resolve requests for blocked outcome
  - clarification questions for uncertain outcome
- Decision baseline:
  - `completed` requires non-empty `evidence`
  - `blocked` requires at least one `blocker_resolve_requests` item
  - `uncertain` requires at least one `clarification_questions` item
  - worker result must choose exactly one of: `blocked`, `completed`, `uncertain`
- No-decision prevention:
  - there must never be a no-decision outcome
  - if decision output is missing/invalid/ambiguous, default to `blocked`
- Workflow-loop applies one mutation per decision and adds a corresponding ticket comment when mutating.
- If worker JSON is invalid/unparseable, workflow-loop performs repair retries according to section 10.4.
- If retry output is still invalid/unparseable, workflow-loop applies forced fallback decision `blocked`.
- Worker dispatch metadata must include correlation fields: `ticketId` and `dispatchRunId`.
- Workflow-loop retry prompt must include all schema errors from the failed payload plus the strict JSON schema contract (field/type/constraint definitions), and should not echo full prior payload content.
- No separate per-run decision artifact file is required; decision context is retained in workflow-loop session history.
- On failed retry fallback, workflow-loop immediately applies `blocked` when decision output is missing/invalid/ambiguous.
- If required decision signals remain missing after retry (decision, completed steps, and decision-specific required fields), workflow-loop must coerce any non-`blocked` decision to `blocked`.
- `completed` must be coerced to `blocked` unless `evidence` is present.

## 7) Scope exclusions

Out of scope for this baseline:
- GitHub adapter
- Linear adapter
- Planka adapter
- Plane-only helper command `needs-my-attention`
- Legacy command `autopilot-tick` (must be removed from CLI, docs, tests, and runtime flow)

## 8) Documentation sync

When behavior changes, keep these in sync:
- `references/REQUIREMENTS.md` (authoritative)
- `README.md`
- `SKILL.md`

## 9) Notes to revisit later

## 10) Worker result JSON contract and action mapping (finalized, 2026-03-04)

Status: active

### 10.1 Worker response envelope

- Worker final response must be JSON-only.
- Response must be a single JSON object (no Markdown wrapper, no fenced code block).
- Backward compatibility mode for legacy Markdown reports is out of scope; hard switch to JSON-only.

### 10.2 Schema and validation

- Validation must be strict:
  - unknown fields are rejected
  - missing required fields are rejected
  - wrong types are rejected
- Validation happens before any decision-to-action application.
- Required top-level fields:
  - `decision`: `blocked` | `completed` | `uncertain`
  - `completed_steps`: array of strings (always required; minimum 1 item)
  - `clarification_questions`: array of strings (required when `decision` is `uncertain`; otherwise must be empty)
  - `blocker_resolve_requests`: array of strings (required when `decision` is `blocked`; otherwise must be empty)
  - `solution_summary`: string (required when `decision` is `completed`; disallowed for `blocked`/`uncertain`)
  - `evidence`: array of strings (required when `decision` is `completed`; otherwise must be empty)
  - all string entries must be at least 20 characters
  - every array field has a maximum of 5 items

### 10.3 Conditional validity rules

- For `decision: blocked`:
  - `blocker_resolve_requests` must contain at least one non-empty item
  - `clarification_questions` must be empty
  - `solution_summary` is disallowed
  - `evidence` must be empty
- For `decision: uncertain`, clarification prompts are required:
  - `clarification_questions` must contain at least one non-empty question for human response
  - `blocker_resolve_requests` must be empty
  - `solution_summary` is disallowed
  - `evidence` must be empty
- For `decision: completed`, completion guardrails remain:
  - must include non-empty `solution_summary`
  - must include non-empty `evidence`
  - `clarification_questions` must be empty
  - `blocker_resolve_requests` must be empty
  - otherwise coerce decision to `blocked`

### 10.4 Invalid JSON retry policy

- On invalid JSON/schema output, workflow-loop retries up to 2 times.
- Each retry prompt must include detailed reasons the previous output was invalid.
- Validation feedback must include all schema errors from the failed payload, not only the first error.
- Each retry prompt must include the strict JSON schema contract (field/type/constraint definitions), not a filled example payload.
- If output is still invalid after the third total attempt (initial + 2 retries), force `blocked`.

### 10.5 Decision-to-action mapping

- `blocked`:
  - post derived comment
  - move ticket to `stage:blocked`
- `completed`:
  - post derived comment
  - move ticket to `stage:in-review`
- `uncertain`:
  - post derived comment that prominently includes clarification questions
  - move ticket to `stage:blocked`

### 10.6 Comment generation

- Workflow-loop must transform valid worker JSON into a standardized ticket comment format.
- Raw JSON should not be posted directly as the primary comment payload.
- Comment formatter is responsible for presenting:
  - decision
  - completed steps
  - solution summary (when present)
  - evidence (when present)
  - blocker resolve requests (when present)
  - clarification questions

### 10.7 Audit/logging

- Persist validation and decision details to runtime logs only.
- Do not write separate local artifact files for worker decision payloads.

## 11) Queue position dispatcher comments (active, 2026-03-04)

Problem:
- Users need visibility into when a queued ticket is likely to be picked up.

Requirement:
- After backlog prioritization/queue building in `workflow-loop`, dispatcher must maintain a queue-position comment per queued ticket.

Scope:
- Apply to all queued tickets in `stage:todo` assigned to the authenticated worker.
- Do not keep a queue-position comment on the active `stage:in-progress` ticket.

Comment ownership and identity:
- Queue-position comments are dispatcher-owned and must include a stable internal marker so they can be found and updated deterministically.
- Marker must be unique to this automation (for example, `kwf:queue-position` in hidden metadata or comment body marker).

Message text (exact template):
- `There are XX tickets with higher priority that I need to complete (<Nh) before this ticket can be started. If this is urgent, change the priority.`

Semantics:
- `XX` is the exact count of higher-priority tickets ahead of this ticket in the current queue order.
- Position must be represented exactly (not bucketed as `10+`).
- Applies to all queued tickets, regardless of queue depth.

Update behavior:
- If no dispatcher queue-position comment exists for a queued ticket: create one.
- If a dispatcher queue-position comment exists and `XX` changed: update the existing comment (do not create a new one).
- If a dispatcher queue-position comment exists and `XX` is unchanged: no-op.
- If a ticket is no longer in queue scope: delete the dispatcher queue-position comment.

Operational behavior:
- Dispatcher is the sole writer of queue-position comments.
- Never mutate or delete human-authored comments.
- Queue-comment update failures are non-blocking; log errors and continue workflow-loop execution.

API/adapter requirement:
- Implement comment create/update/delete support in Plane adapter using supported comment endpoints.
- Prefer Plane `work-items` comment endpoints (not legacy/deprecated `issues` endpoints) for forward compatibility.

## 12) Queue ETA estimate in dispatcher comments (active, 2026-03-04)

Problem:
- Users need a rough time estimate, not only queue position.

Requirement:
- Queue-position comment must include an ETA estimate derived from recent worker completion throughput.

ETA model:
- Use a rolling average of the last 3 completed tickets.
- Per-ticket duration for averaging is measured as actual worker runtime:
  - start: when ticket work begins in `stage:in-progress`
  - end: when ticket reaches `stage:in-review`
  - blocked time should not inflate ETA; estimate should represent active worker execution time.
- If fewer than 3 completed-ticket samples are available, use default average duration of 20 minutes.

ETA formula:
- For a queued ticket with `XX` higher-priority tickets ahead:
  - estimate completion horizon as `(XX + 1) * avg_duration`
  - this represents rough time until that queued ticket is completed (not just started).

Display formatting:
- Convert estimate to hours and round using ceiling.
- If estimate is below 1 hour, display `<1h`.
- Queue comment message template must be:
  - `There are XX tickets with higher priority that I need to complete (<Nh) before this ticket can be started. If this is urgent, change the priority.`
- For estimates below one hour, replace `<Nh` with `<1h`.

Operational notes:
- ETA is advisory and approximate.
- ETA must be recalculated during each queue-comment reconciliation pass.

Potential future re-expansion topics (not active now):
- Re-introducing multi-adapter support
- Re-introducing direct manual mutation CLI commands
- Enriching Plane attachment/link extraction if API/CLI supports it reliably

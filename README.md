# Kanban Workflow

Plane-only workflow automation with a local `workflow-loop` runner and LLM worker turns.

## Scope

- Adapter support: **Plane only**.
- Orchestration: `workflow-loop` (poll/select/delegate/apply).
- Legacy multi-adapter surface is removed.

## Commands

- `kanban-workflow setup --adapter plane --plane-workspace-slug <slug> --plane-scope all-projects --map-backlog <name> --map-blocked <name> --map-in-progress <name> --map-in-review <name> [--force] [--autopilot-cron-expr "*/5 * * * *"] [--autopilot-cron-tz <tz>] [--autopilot-install-cron] [--autopilot-requeue-target-stage <stage>]`
- `kanban-workflow workflow-loop [--dry-run]`
- `kanban-workflow show --id <ticket-id>`
- `kanban-workflow create --project-id <uuid> --title "..." [--body "..."]`
- `kanban-workflow help`

## Behavior Summary

- Setup requires Plane and enforces `--plane-scope all-projects`.
- Backlog selection is global across configured Plane projects, ordered by priority and then title.
- Only tickets assigned to `whoami` are eligible for active work.
- `workflow-loop` is local CLI/script orchestration; it is not a continuously running agent.
- If the currently active ticket is unchanged, `workflow-loop` exits quietly (poll-only behavior).

## Worker + Decision Flow

Per workflow-loop work action:

1. Worker agent runs in the ticket-bound session and produces a strict JSON result object.
2. JSON is validated in strict mode (unknown fields rejected, required fields/types enforced, conditional rules per decision).
3. If JSON is invalid, workflow-loop issues up to 2 retry prompts that include all schema errors plus the strict schema contract.
4. If still invalid on the 3rd total attempt, workflow-loop forces `blocked`.
5. Valid decisions are exactly: `blocked` | `completed` | `uncertain`.
6. Dispatcher converts JSON into a standardized ticket comment and applies Plane mutation:
   - `blocked` -> comment + move to `stage:blocked`
   - `uncertain` -> comment (with clarification questions) + move to `stage:blocked`
   - `completed` -> comment + move to `stage:in-review`
7. Dispatcher reconciles queue-position comments on all queued `stage:todo` tickets:
   - create if missing
   - update same comment only when queue count changes
   - delete when ticket leaves queue

Session behavior:
- One worker session per ticket, reused while ticket remains active/open.
- Blocked tickets keep session context for human unblock and resume.
- Blocked ticket sessions are archived after 7 days.

## Development

Install and validate:

```bash
npm ci
npx tsc --noEmit
npm test
```

Run CLI:

```bash
npm run kanban-workflow -- <command>
```

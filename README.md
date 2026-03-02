# Kanban Workflow

Plane-only workflow automation with a local `workflow-loop` runner and LLM worker turns.

## Scope

- Adapter support: **Plane only**.
- Orchestration: `workflow-loop` (poll/select/delegate/apply).
- Legacy multi-adapter surface is removed.
- Legacy user command `autopilot-tick` is removed.

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

1. Worker agent runs in the ticket-bound session and produces a markdown report.
2. Report must include verification evidence, blockers status, uncertainties, and confidence (0.0..1.0).
3. If report facts are missing, one retry prompt is issued.
4. Decision agent chooses exactly one: `continue` | `blocked` | `completed`.
5. If the decision cannot be parsed, default is `blocked`.
6. Per ticket continue cap is hard-limited to 2; after that only `blocked` or `completed` can be applied.
7. Dispatcher applies Plane mutation and posts a free-text comment summary.

Session behavior:
- One worker session per ticket, reused while ticket remains active/open.
- Blocked tickets keep session context for human unblock and resume.
- Decision-agent session rotates every 5 tickets or when token usage reaches 50%.
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

# Kanban Workflow

A TypeScript-first core skill for a stage-based “agentic co-worker” that integrates project-management platforms via **CLI-first adapters** (external CLIs or wrapper scripts; some use API keys via env vars). It also includes an `autopilot-tick` command intended to be run on a schedule (e.g. OpenClaw cron). Setup can optionally install that cron job.

`autopilot-tick` is now an execution orchestrator, not just a detector: each run decides and executes one path (continue/start, blocked, completed).

## What it is

Kanban Workflow standardizes a canonical workflow state machine using an existing `stage:*` lifecycle:

- `stage:todo`
- `stage:blocked`
- `stage:in-progress`
- `stage:in-review`

Notes:
- Done/closed is platform-specific and intentionally **not** part of the canonical stage set.

It provides:
- Canonical models + event types
- Snapshot diffing to synthesize events (polling-friendly)
- A deterministic `tick()` runner
- Adapters that call existing CLIs using the user’s authenticated session

Currently supported adapters:
- **GitHub** via `gh` (in-repo adapter)
- **Planka** via `planka-cli` (voydz/planka-cli)
- **Plane** via ClawHub skill `plane` (owner: `vaguilera-jinko`)
- **Linear** via ClawHub skill `linear` (ManuelHettich) + this repo’s `scripts/linear_json.sh` compatibility wrapper

See `src/adapters/README.md` for links and notes.

## Repo layout

- `SKILL.md` — OpenClaw skill entrypoint
- `src/` — core library + adapters
- `tests/` — vitest tests
- `references/` — technical plan and notes

## CLI UX: "What next" tips

Every `kanban-workflow <verb>` execution prints a `What next:` tip line to guide the next step in the workflow.

If setup is not completed (missing/invalid `config/kanban-workflow.json`), **all commands** will fail with a clear error and instruct you to run `kanban-workflow setup`.

### Setup

Setup is flags-only (non-interactive) and writes `config/kanban-workflow.json`.

Common flags:
- `--adapter <github|plane|linear|planka>`
- `--force` (required to overwrite an existing config)

Stage mapping (required; map *platform stage/list/status name* → canonical stage):
- `--map-backlog <platform-name>`
- `--map-blocked <platform-name>`
- `--map-in-progress <platform-name>`
- `--map-in-review <platform-name>`

Adapter flags:
- GitHub: `--github-repo <owner/repo>`, optional `--github-project-number <number>`
- Plane: `--plane-workspace-slug <slug>`, `--plane-project-id <uuid>`, optional `--plane-order-field <field>`
- Linear: scope `--linear-team-id <id>` **or** `--linear-project-id <id>`, optional ordering `--linear-view-id <id>`
- Planka: `--planka-board-id <id>`, `--planka-backlog-list-id <id>`

### Autopilot decision model (single command)

`autopilot-tick` decides and executes one of three outcomes per run:

- **continue/start**
  - if no active work exists and next backlog item is assigned to self, it starts it and returns current payload.
- **blocked**
  - if active work is stale and blocker evidence exists, it moves the ticket to Blocked (`ask`) and automatically loads `next`.
- **completed**
  - if strong completion proof marker exists, it completes the ticket (`complete` -> In Review) and automatically loads `next`.

Supported flags:

- `--dry-run` -> evaluate decision without mutating ticket state

### Cron dispatcher (session-per-ticket)

Use `kanban-workflow cron-dispatch` for scheduled runs. It wraps `autopilot-tick` and adds session routing:

- dispatcher responsibilities
  - persist ticket->session state in `.tmp/kwf-session-map.json`
  - reuse the same OpenClaw session while the same ticket stays `in_progress`
  - dispatch a **do-work-now** payload with full context (`id`, `title`, `body`, latest `comments`, `attachments`, linked tickets/URLs)
  - enforce strict worker contract before any mutation is applied
  - emit machine-readable execution records (`applied` | `parse_error` | `mutation_error`) for observability
- worker responsibilities
  - perform concrete work during the turn unless truly blocked
  - include an `EVIDENCE` section (what was executed, key output, changed files)
  - end with exactly one terminal command on the final non-empty line:
    - `kanban-workflow continue --text ...`
    - `kanban-workflow blocked --text ...`
    - `kanban-workflow completed --result ...`
  - avoid boilerplate progress spam
- strict contracts
  - parser requires exactly one terminal command, valid flags, and final-line placement
  - continue proof-gate: `continue` is rejected unless EVIDENCE contains concrete execution proof
- lifecycle handling
  - on `blocked`/`completed`, finalize old ticket session and start/reuse mapped session for next ticket
  - no-work ticks emit no dispatch actions (silent/no-op)
  - restart-safe map loading (invalid/missing map falls back to empty state)

`setup --autopilot-install-cron` now installs a minimal cron trigger message:

- `kanban-workflow cron-dispatch`

### Completion proof gate

Auto-complete only fires on strong markers in recent comments to reduce false positives, e.g.:

- `Completed:`
- `[done-proof]`
- `proof:`

### Continuous status updates

Autopilot tick no longer posts boilerplate "continuing work" comments. To reduce noise, status updates are emitted only through explicit worker terminal actions:

- `kanban-workflow continue --text "update + next steps"`
- `kanban-workflow blocked --text "block reason + concrete ask"`
- `kanban-workflow completed --result "what was done"`

(Advanced helper remains available: `runProgressAutoUpdates()` in `src/automation/progress_updates.ts`, but it is not part of the default cron-dispatch loop.)

## Security model

Kanban Workflow **does not** run interactive OAuth flows or persist secrets. Authentication is handled by the adapter’s CLI/script (often via an existing CLI session or an API key environment variable).

Instead, it shells out to a platform-specific CLI (e.g. `gh`, `plane`, `scripts/linear_json.sh`, `planka-cli`) and therefore acts with the **same privileges as that CLI session** on the host machine.

Implications:
- Anything the authenticated CLI can read/write, this skill can read/write.
- Keep your CLI sessions scoped appropriately (least privilege), and treat `config/kanban-workflow.json` as sensitive metadata (it contains IDs, not secrets).

See `SECURITY.md` for more detail.

## Development / install

Prereqs:
- Node.js + npm
- Adapter CLI(s) for the platform you plan to use:
  - GitHub: `gh`
  - Planka: `planka-cli`
  - Plane: ClawHub skill `plane` (binary `plane`; requires `PLANE_API_KEY` + `PLANE_WORKSPACE`)
  - Linear: `curl` + `jq` + `LINEAR_API_KEY` (via ClawHub skill `linear`); Kanban Workflow calls `scripts/linear_json.sh`

Install dependencies:
```bash
npm ci
```

Run tests:
```bash
npm test
```

Build:
```bash
npm run build
```

## Adapters

Adapters live in `src/adapters/`.

- GitHub: uses **GitHub CLI** (`gh`, incl. `gh api`)
- Planka: uses **planka-cli** (https://github.com/voydz/planka-cli)
- Plane: uses ClawHub skill **`plane`** (owner: `vaguilera-jinko`) (binary `plane`; env: `PLANE_API_KEY`, `PLANE_WORKSPACE`).
- Linear: uses ClawHub skill **`linear`** (ManuelHettich) auth convention (`LINEAR_API_KEY`) via this repo’s `scripts/linear_json.sh` wrapper.

Notes:
- Kanban Workflow itself does **not** manage platform auth flows.

## Status

Early scaffolding / prototype. Interfaces and CLI surface are expected to change.

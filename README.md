# Kanban Workflow

A TypeScript-first core skill for a stage-based “agentic co-worker” that integrates project-management platforms via **CLI-auth adapters** (no direct HTTP auth handling).

## What it is

Kanban Workflow standardizes a canonical workflow state machine using an existing `stage:*` lifecycle:

- `stage:backlog`
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
- **Plane** via `plane-cli` (simonvanlaak/plane-cli; a2c workspace)
- **Linear** via `linear-cli` (simonvanlaak/linear-cli; a2c workspace)

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

### Continuous status updates

While an item is in `stage:in-progress`, Kanban Workflow can post an **automatic progress update comment every 5 minutes**. The helper is exported as:

- `runProgressAutoUpdates()` (see `src/automation/progress_updates.ts`)

## Security model

Kanban Workflow **does not** handle platform HTTP auth tokens directly.

Instead, it shells out to a platform-specific CLI (e.g. `gh`, `plane`, `linear`, `planka-cli`) and therefore acts with the **same privileges as that CLI session** on the host machine.

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
  - Plane: `plane` (plane-cli wrapper) and/or `a2c`
  - Linear: `linear` (linear-cli wrapper) and/or `a2c`

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
- Plane: uses **plane-cli** (https://github.com/simonvanlaak/plane-cli)
- Linear: uses **linear-cli** (https://github.com/simonvanlaak/linear-cli)

Notes:
- Kanban Workflow itself does **not** handle HTTP auth tokens. Authenticate via the CLI you use.
- For Plane/Linear, the CLI is an **Api2Cli (a2c)** workspace + wrapper.

## Status

Early scaffolding / prototype. Interfaces and CLI surface are expected to change.

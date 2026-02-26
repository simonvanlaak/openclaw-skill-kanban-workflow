# Clawban

A TypeScript-first core skill for a stage-based “agentic co-worker” that integrates project-management platforms via **CLI-auth adapters** (no direct HTTP auth handling).

## What it is

Clawban standardizes a canonical workflow state machine using your existing `stage:*` lifecycle:

- `stage:backlog`
- `stage:queued`
- `stage:needs-clarification`
- `stage:ready-to-implement`
- `stage:in-progress`
- `stage:in-review`
- `stage:blocked`
- done/closed (platform-specific)

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

## Development

Prereqs:
- Node.js

Install:
```bash
npm install
```

Run tests:
```bash
npm test
```

Build (optional):
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
- Clawban itself does **not** handle HTTP auth tokens. Authenticate via the CLI you use.
- For Plane/Linear, the CLI is an **Api2Cli (a2c)** workspace + wrapper.

## Status

Early scaffolding / prototype. Interfaces and CLI surface are expected to change.

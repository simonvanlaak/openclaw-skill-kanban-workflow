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
- Adapters that call existing CLIs (e.g. `gh`) using the user’s authenticated session

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

## GitHub adapter

The GitHub adapter uses the GitHub CLI (`gh`) only (including `gh api`). Ensure:

```bash
gh auth status
```

Then use the adapter from your own scripts/app (API is still evolving).

## Status

Early scaffolding / prototype. Interfaces and CLI surface are expected to change.

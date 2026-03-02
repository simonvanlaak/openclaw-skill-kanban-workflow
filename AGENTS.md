# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains production TypeScript code.
- `src/adapters/` hosts the Plane integration (`plane`) and adapter docs.
- `src/automation/` contains cron/autopilot orchestration logic.
- `src/verbs/` implements user-facing workflow actions.
- `tests/` contains Vitest suites; test files follow `*.test.ts` (for example, `tests/plane_adapter.test.ts`).
- `scripts/` contains shell/Node helper scripts used by adapters and cron dispatch.
- `config/` stores local runtime config (for example `config/kanban-workflow.json`); do not commit secrets.
- `references/` stores design notes and plans, not runtime code.

## Build, Test, and Development Commands
- `npm ci` installs pinned dependencies.
- `npm test` runs the full Vitest suite once (`vitest run`).
- `npm run test:watch` runs tests in watch mode during development.
- `npm run kanban-workflow -- <verb> ...` runs the CLI via `tsx src/cli.ts`.
- `npx tsc --noEmit` performs a strict type check (use before opening a PR).

## Coding Style & Naming Conventions
- Language: TypeScript ESM (`"type": "module"`), target `ES2022`, strict mode enabled.
- Use 2-space indentation and semicolons, matching existing files.
- File names use snake_case for multiword modules (for example `next_selection.ts`, `session_dispatcher.ts`).
- Keep modules focused: shared contracts in `src/core/ports.ts`, platform-specific logic in `src/adapters/*`.

## Testing Guidelines
- Framework: Vitest (`vitest.config.ts` includes `tests/**/*.test.ts` under Node environment).
- Add or update tests for behavior changes, especially state transitions and adapter parsing.
- Prefer deterministic tests with explicit fixtures; avoid external network calls.
- Run `npm test` and `npx tsc --noEmit` before submitting.

## Commit & Pull Request Guidelines
- Follow the repository’s commit style: concise imperative subjects with prefixes like `fix:`, `feat(scope):`, or area prefixes like `dispatcher:`.
- Keep commits scoped to a single logical change.
- PRs should include:
  - what changed and why
  - linked issue/ticket
  - test evidence (commands run and results)
  - sample CLI output when UX/automation behavior changes

## Security & Configuration Tips
- This project inherits permissions from the local `plane` CLI. Use least-privilege auth.
- Never hardcode tokens; use environment variables and local CLI auth state.
- Treat `config/kanban-workflow.json` as sensitive metadata.

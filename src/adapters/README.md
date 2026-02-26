# Clawban adapters

Adapters are **CLI-auth** integrations. Clawban does not manage HTTP auth tokens; each adapter relies on a locally configured CLI session.

## GitHub

- CLI: **GitHub CLI (`gh`)**
- Link: https://cli.github.com/
- Auth: `gh auth login` / `gh auth status`

## Linear

- CLI: **Linear CLI**
- Link: https://github.com/linear/linear

> Note: Linear’s official tooling and community CLIs vary. If you use a different CLI/wrapper, update `LinearAdapter` to match its JSON output.

## Planka

- CLI: **planka-cli**
- Link: https://github.com/voydz/planka-cli
- Planka project: https://github.com/plankanban/planka

The adapter defaults to calling `planka-cli cards list --json`. If your installed version differs, pass custom `listArgs`.

## Plane

- Project: https://github.com/makeplane/plane
- Canonical CLI: **plane-cli** (a2c-based)
  - https://github.com/simonvanlaak/plane-cli

The adapter defaults to calling a `plane` wrapper on your `PATH` (recommended), as provided by `plane-cli`.

If you prefer calling Api2Cli directly, configure:

- `bin: "a2c"`
- `baseArgs: ["--config", "<path-to-plane-cli>/a2c", "--workspace", "plane"]`

## Contributing a new adapter

1) Pick/define a CLI that can list work items as JSON.
2) Implement `fetchSnapshot()` mapping to canonical `WorkItem` + `Stage`.
3) Add vitest coverage with mocked CLI output.

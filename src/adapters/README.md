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

- API/Project: https://github.com/plankanban/planka

> Note: There is no single canonical Planka CLI. The `PlankaAdapter` assumes you provide a `planka` CLI (or wrapper) that can output JSON.

## Plane

- Project: https://github.com/makeplane/plane

> Note: Plane’s CLI options vary by deployment. The `PlaneAdapter` assumes you provide a `plane` CLI (or wrapper) that can output JSON.

## Contributing a new adapter

1) Pick/define a CLI that can list work items as JSON.
2) Implement `fetchSnapshot()` mapping to canonical `WorkItem` + `Stage`.
3) Add vitest coverage with mocked CLI output.

# Kanban Workflow adapters

## Supported adapter

- Plane only (`src/adapters/plane.ts`)

## Plane CLI

- Binary: `plane`
- Auth is inherited from local environment/CLI context.
- Common env vars:
  - `PLANE_API_KEY`
  - `PLANE_WORKSPACE`
  - `PLANE_BASE_URL` (optional)

Kanban Workflow does not run OAuth flows or store platform secrets.

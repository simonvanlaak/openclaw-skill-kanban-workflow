# `maxConcurrentWorkers` Impact Analysis

## Status

This is an analysis document only.

It does **not** change current behavior.
Current KWF is still single-active-ticket.

## Executive Summary

Adding a configurable `maxConcurrentWorkers` is **not** mainly a config change.

The config variable itself is easy.
The real work is replacing the current **single-slot architecture** with a **slot/capacity model**.

The important conclusion is:

- making concurrency configurable is a **medium-sized architecture change**
- making the value dynamic (`1`, `2`, `3`, not hardcoded `2`) is **small incremental cost** once the slot model exists

So the complexity is not:

- "add one env var"

It is:

- "replace singular active-ticket assumptions across selection, lifecycle, housekeeping, reconciliation, and tests"

## Bottom-Line Estimate

### Minimum realistic scope

Guaranteed code impact based on the current codebase:

- `11` production modules definitely affected
- `13` test files definitely affected

These are only the files with direct single-active assumptions I verified locally.

### Practical implementation estimate

For a robust implementation with migration safety:

- production code: about `1,000` to `1,600` lines touched
- tests/docs: about `500` to `900` lines touched
- total touch surface: about `1,500` to `2,500` lines

### Effort estimate

Assuming the same TDD + atomic-commit discipline used so far:

- design + state-shape migration: `0.5` to `1` day
- implementation core path: `1.5` to `3` days
- side effects + test hardening + migration cleanup: `1` to `2` days

Rough total:

- `3` to `6` focused engineering days

That estimate is for **bounded concurrency done properly**, not a shortcut.

## Key Insight

The additional cost of making the concurrency value **variable** instead of hardcoded to `2` is small.

Once the system is slot-based, the difference between:

- `2`
- `N`

is mostly:

- config parsing
- slot id generation
- test matrix breadth
- queue/status wording

So the real question is not:

- "can we make it configurable?"

It is:

- "can we remove the single-active model safely?"

## Current Architectural Constraint

KWF currently models active work as a single pointer:

- [`src/automation/session_dispatcher.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/automation/session_dispatcher.ts)
  - `SessionMap.active?: { ticketId, sessionId }`
- [`src/workflow/workflow_state.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/workflow/workflow_state.ts)
  - `currentActiveSession(map)`
- [`src/workflow/workflow_loop_selection.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/workflow/workflow_loop_selection.ts)
  - chooses one in-progress ticket, requeues extras

That means a variable like `maxConcurrentWorkers=3` cannot be layered on top of current code safely.

## What Must Change

### 1. Runtime state model

This is the foundational change.

Current shape:

```ts
type SessionMap = {
  version: 1;
  active?: { ticketId: string; sessionId: string };
  sessionsByTicket: Record<string, SessionEntry>;
};
```

Needed shape:

```ts
type ActiveSlot = {
  slotId: string;
  ticketId: string;
  sessionId: string;
  acquiredAt: string;
};

type SessionMap = {
  version: 2;
  maxConcurrentWorkers?: number;
  activeSlots?: ActiveSlot[];
  sessionsByTicket: Record<string, SessionEntry>;
};
```

Recommended additional ticket-level field:

```ts
assignedSlotId?: string;
```

Primary files:

- [`src/automation/session_dispatcher.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/automation/session_dispatcher.ts)
- [`src/workflow/workflow_state.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/workflow/workflow_state.ts)
- [`src/workflow/ticket_runtime.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/workflow/ticket_runtime.ts)

Estimated change size:

- `200` to `350` lines

Risk:

- high, because almost every later workflow assumption depends on this state

### 2. Selection logic

Current selection semantics are explicitly single-slot:

- keep newest self-assigned `In Progress`
- move extra `In Progress` tickets back to `Todo`
- otherwise start one backlog ticket

That behavior is invalid under bounded concurrency.

Needed behavior:

1. discover all self-assigned `In Progress` tickets
2. adopt up to `maxConcurrentWorkers`
3. if free slots remain, reserve top `Todo` tickets until capacity is filled
4. if `In Progress` count exceeds capacity, treat it as drift, not as something to silently demote

Primary file:

- [`src/workflow/workflow_loop_selection.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/workflow/workflow_loop_selection.ts)

Also affected:

- [`src/workflow/workflow_loop_ports.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/workflow/workflow_loop_ports.ts)

Estimated change size:

- `250` to `450` lines

Risk:

- high, because this is the main place where the current "one active ticket" policy is enforced

### 3. Controller / dispatch / immediate handoff

Current controller logic assumes:

- one active ticket
- one action path to dispatch
- one completion frees the system globally

Needed behavior:

- dispatch multiple work actions in one pass up to free capacity
- allow one slot to complete while others remain active
- immediate handoff should fill only free slots, not assume global idleness

Primary file:

- [`src/workflow/workflow_loop_controller.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/workflow/workflow_loop_controller.ts)

Related files:

- [`src/workflow/delegation_reconciler.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/workflow/delegation_reconciler.ts)
- [`src/workflow/subagent_completion_reconciler.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/workflow/subagent_completion_reconciler.ts)
- [`src/workflow/active_run_watchdog.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/workflow/active_run_watchdog.ts)

Estimated change size:

- `250` to `400` lines

Risk:

- medium-high, because worker-start and worker-completion are already durable and should not be regressed

### 4. Derived state and compatibility surfaces

Current derived state is singular:

- one `activeTicketId`
- one `activeSessionId`
- one `activeSessionLabel`

Needed shape:

- `activeTicketIds`
- `activeSessions[]`
- `activeCount`
- maybe a primary/representative active ticket for legacy output compatibility

Primary files:

- [`src/workflow/workflow_loop_derived_state.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/workflow/workflow_loop_derived_state.ts)
- [`src/workflow/workflow_loop_ports.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/workflow/workflow_loop_ports.ts)

Estimated change size:

- `100` to `200` lines

Risk:

- medium

### 5. Queue comments

This is one of the most awkward parts to parallelize.

Current semantics assume:

- zero or one active ticket
- `activeOffset = 0 | 1`
- queue message says the ticket must wait until earlier tickets complete

Under parallel WIP, queue semantics are different.

Example:

- "There are X higher-priority tickets ahead, with Y currently in progress."

This is not just a count change. It is a user-facing meaning change.

Primary file:

- [`src/workflow/queue_position_comments.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/workflow/queue_position_comments.ts)

Estimated change size:

- `150` to `250` lines

Risk:

- medium

Recommendation:

- disable queue comments when `maxConcurrentWorkers > 1` for the first rollout

That meaningfully reduces scope.

### 6. Rocket.Chat status

Current status assumes one active ticket:

- "working on JULES-249: ..."

Parallel-safe alternatives:

- "working on 2 tickets"
- "working on JULES-249 and JULES-296"
- "working on JULES-249 (+1 more)"

Primary file:

- [`src/workflow/rocketchat_status.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/workflow/rocketchat_status.ts)

Estimated change size:

- `50` to `120` lines

Risk:

- low

### 7. Housekeeping mutation guard

Current housekeeping guard protects one active lifecycle entry.

That needs to become:

- compare `activeSlots`
- compare all corresponding active session entries

Primary file:

- [`src/workflow/workflow_loop_housekeeping.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/workflow/workflow_loop_housekeeping.ts)

Estimated change size:

- `40` to `90` lines

Risk:

- low-medium

### 8. Tests

This change is test-heavy because the current test suite encodes single-active assumptions everywhere.

Verified affected test files:

- [`tests/session_dispatcher.test.ts`](/root/.openclaw/workspace/skills/kanban-workflow/tests/session_dispatcher.test.ts)
- [`tests/workflow_loop_selection.test.ts`](/root/.openclaw/workspace/skills/kanban-workflow/tests/workflow_loop_selection.test.ts)
- [`tests/workflow_loop_controller.test.ts`](/root/.openclaw/workspace/skills/kanban-workflow/tests/workflow_loop_controller.test.ts)
- [`tests/workflow_loop_housekeeping.test.ts`](/root/.openclaw/workspace/skills/kanban-workflow/tests/workflow_loop_housekeeping.test.ts)
- [`tests/workflow_loop_derived_state.test.ts`](/root/.openclaw/workspace/skills/kanban-workflow/tests/workflow_loop_derived_state.test.ts)
- [`tests/queue_position_comments.test.ts`](/root/.openclaw/workspace/skills/kanban-workflow/tests/queue_position_comments.test.ts)
- [`tests/rocketchat_status.test.ts`](/root/.openclaw/workspace/skills/kanban-workflow/tests/rocketchat_status.test.ts)
- [`tests/delegation_reconciler.test.ts`](/root/.openclaw/workspace/skills/kanban-workflow/tests/delegation_reconciler.test.ts)
- [`tests/worker_output_applier.test.ts`](/root/.openclaw/workspace/skills/kanban-workflow/tests/worker_output_applier.test.ts)
- [`tests/workflow_state.test.ts`](/root/.openclaw/workspace/skills/kanban-workflow/tests/workflow_state.test.ts)
- [`tests/workflow_ticket_runtime.test.ts`](/root/.openclaw/workspace/skills/kanban-workflow/tests/workflow_ticket_runtime.test.ts)
- [`tests/worker_decision_recovery.test.ts`](/root/.openclaw/workspace/skills/kanban-workflow/tests/worker_decision_recovery.test.ts)
- [`tests/next_selection.test.ts`](/root/.openclaw/workspace/skills/kanban-workflow/tests/next_selection.test.ts)

Expected new tests:

- fills `N` slots from backlog
- adopts existing in-progress tickets up to capacity
- does not silently demote excess in-progress tickets when capacity is exceeded
- completion frees one slot while another active slot remains untouched
- human reopen does not overwrite slot ownership of unrelated active tickets
- watchdog reconciles one active run without disturbing other active runs
- housekeeping does not mutate any active slot ownership
- status rendering works for `0`, `1`, `N` active tickets

Estimated change size:

- `500` to `900` lines

Risk:

- medium

## Production Files Likely To Change

These are the most likely production files for the first real implementation pass:

- [`src/automation/session_dispatcher.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/automation/session_dispatcher.ts)
- [`src/workflow/workflow_state.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/workflow/workflow_state.ts)
- [`src/workflow/workflow_loop_selection.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/workflow/workflow_loop_selection.ts)
- [`src/workflow/workflow_loop_controller.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/workflow/workflow_loop_controller.ts)
- [`src/workflow/workflow_loop_ports.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/workflow/workflow_loop_ports.ts)
- [`src/workflow/workflow_loop_derived_state.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/workflow/workflow_loop_derived_state.ts)
- [`src/workflow/workflow_loop_housekeeping.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/workflow/workflow_loop_housekeeping.ts)
- [`src/workflow/queue_position_comments.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/workflow/queue_position_comments.ts)
- [`src/workflow/rocketchat_status.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/workflow/rocketchat_status.ts)
- [`src/workflow/delegation_reconciler.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/workflow/delegation_reconciler.ts)
- [`src/workflow/subagent_completion_reconciler.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/workflow/subagent_completion_reconciler.ts)
- [`src/workflow/active_run_watchdog.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/workflow/active_run_watchdog.ts)
- [`src/workflow/ticket_runtime.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/workflow/ticket_runtime.ts)
- [`src/cli.ts`](/root/.openclaw/workspace/skills/kanban-workflow/src/cli.ts)

## Where The Config Variable Belongs

If implemented, `maxConcurrentWorkers` should be sourced from one place and propagated outward.

Recommended order of precedence:

1. CLI flag for experiments
2. env var for runtime automation
3. persisted session-map metadata only as an informational echo, not as authoritative config

Good initial shape:

```ts
type WorkflowCapacityConfig = {
  maxConcurrentWorkers: number;
};
```

Recommended parsing rules:

- default to `1`
- minimum `1`
- cap upper bound defensively, e.g. `8`
- reject `0`, negative, NaN, and absurdly large values

Important:

- `maxConcurrentWorkers` should **not** be inferred from current active slots
- it should come from config, not runtime drift

## Why A Flexible Variable Is Not Much Harder Than Hardcoded 2

Once you adopt slot ids and free-slot discovery, the implementation naturally becomes capacity-based:

- `slot-1 ... slot-N`
- `freeSlotIds(map, maxConcurrentWorkers)`
- `fill up to freeSlots.length`

At that point:

- `2` is just one value of `N`

The incremental work to support arbitrary `N` instead of literal `2` is mostly:

- slot id generation
- test parametrization
- status formatting
- queue wording if queue comments remain enabled

Estimated incremental cost beyond a hardcoded-2 implementation:

- `5%` to `15%`

So there is little reason to hardcode `2` if the refactor is being done at all.

## Recommended Migration Strategy

### Phase 1: Add capacity config but keep effective limit at 1

Goal:

- introduce config plumbing without behavior change

Changes:

- parse `maxConcurrentWorkers`
- add helper functions for slot math
- keep single-slot wrappers delegating to slot `0`

Risk:

- low

### Phase 2: Migrate session map to slot-based model with compatibility wrapper

Goal:

- make state model ready

Changes:

- add `activeSlots`
- derive legacy `active` for compatibility temporarily

Risk:

- medium

### Phase 3: Selection/controller become capacity-aware

Goal:

- real multi-slot behavior

Changes:

- fill free slots
- stop requeueing extra `In Progress` tickets
- keep worker dispatch/reconcile independent per ticket

Risk:

- high

### Phase 4: Side effects

Goal:

- make queue/status/housekeeping parallel-safe

Changes:

- queue comment redesign or disablement
- Rocket.Chat multi-ticket status
- housekeeping guard across all active slots

Risk:

- medium

### Phase 5: Remove legacy single-active compatibility

Goal:

- clean architecture

Changes:

- remove `map.active`
- remove singular helper wrappers

Risk:

- medium

## Recommendation

If this feature is pursued, do **not** implement it as:

- `if (maxConcurrentWorkers > 1) start another ticket`

That would create a fragile hybrid and reintroduce the same partial-truth problems already fixed elsewhere.

The right implementation is:

- capacity model first
- config-driven slot count second

## Recommended Scope Decision

If the goal is flexibility and future growth, the best implementation target is:

- fully configurable `maxConcurrentWorkers`
- default `1`
- first operational rollout at `2`

That avoids doing the hard part twice.

## Related Document

- [`references/PARALLEL_WIP_SPEC.md`](/root/.openclaw/workspace/skills/kanban-workflow/references/PARALLEL_WIP_SPEC.md)

# Robust workflow architecture

## Core model

Plane is the human-facing source of truth for ticket stage and collaboration.
KWF is the workflow controller plus worker runtime that must keep Plane current
without losing execution context or wedging tickets during partial failures.

## Invariants

1. At most one ticket may be active for the agent at a time.
2. If the assigned `todo` queue is non-empty, KWF should try to keep exactly one
   ticket selected for work.
3. Once a ticket is selected, it is immediately moved to `stage:in-progress` in
   Plane and is no longer affected by later `todo` reprioritization.
4. Local runtime state must distinguish:
   - `reserved`: ticket selected and moved to Plane `in-progress`, but worker
     execution is not yet durably confirmed
   - `in_progress`: worker execution is durably confirmed
   - `blocked`
   - `completed`
5. Queue comments, no-work handling, reopen behavior, and status updates must
   operate from the local workflow state machine, not from optimistic guesses.

## Failure model

The dangerous failure is partial success:
- Plane ticket moved to `in-progress`
- local session not persisted
- worker dispatch fails or times out

To avoid that, KWF must persist `reserved` state before attempting worker
dispatch. That makes the selected ticket recoverable on the next workflow loop.

## Handoff rule

Promotion from `reserved` to `in_progress` requires durable proof that worker
execution exists for the selected session. Examples:
- background delegation metadata exists
- existing background delegation is still running
- a worker reply is returned for the expected session

## Implication for future refactors

The workflow controller should evolve into an explicit state machine whose
outputs drive:
- Plane stage mutations
- worker dispatch/recovery
- queue-position comments
- human-comment reopen behavior
- chat/status notifications

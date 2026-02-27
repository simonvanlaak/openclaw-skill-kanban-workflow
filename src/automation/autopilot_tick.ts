import type { Actor } from '../core/ports.js';
import type { StageKey } from '../stage.js';

export type AutopilotTickResult =
  | { kind: 'no_work' }
  | { kind: 'in_progress'; id: string; inProgressIds: string[] }
  | { kind: 'started'; id: string };

export type AutopilotTickPort = {
  whoami(): Promise<Actor>;
  listIdsByStage(stage: StageKey): Promise<string[]>;
  listBacklogIdsInOrder(): Promise<string[]>;
  getWorkItem(id: string): Promise<{ assignees?: Actor[] }>;
  setStage(id: string, stage: StageKey): Promise<void>;
  addComment(id: string, body: string): Promise<void>;
};

// Verb adapters already satisfy this shape; keep export for clarity.

export type AutopilotLockPort = {
  tryAcquireLock(path: string, now: Date, ttlMs: number): Promise<{ release: () => Promise<void> }>;
};

function actorKeys(actor?: Actor): string[] {
  if (!actor) return [];
  return [actor.id, actor.username, actor.name]
    .filter((x): x is string => Boolean(x && String(x).trim().length > 0))
    .map((x) => String(x).trim().toLowerCase());
}

function isAssignedToSelf(assignees: readonly Actor[] | undefined, me: Actor): boolean {
  if (!assignees || assignees.length === 0) return false;

  const meKeys = new Set(actorKeys(me));
  if (meKeys.size === 0) return false;

  return assignees.some((a) => actorKeys(a).some((k) => meKeys.has(k)));
}

export async function runAutopilotTick(opts: {
  adapter: AutopilotTickPort;
  lock: AutopilotLockPort;
  now: Date;
  lockPath?: string;
  lockTtlMs?: number;
}): Promise<AutopilotTickResult> {
  const lockPath = opts.lockPath ?? '.tmp/kanban_autopilot.lock';
  const ttlMs = opts.lockTtlMs ?? 2 * 60 * 60 * 1000;

  const acquired = await opts.lock.tryAcquireLock(lockPath, opts.now, ttlMs);
  try {
    const me = await opts.adapter.whoami();
    const inProgressIds = await opts.adapter.listIdsByStage('stage:in-progress');

    // WIP gating is personal: only in-progress items explicitly assigned to me
    // count against my limit. Unassigned / other-user in-progress items are ignored.
    const ownInProgressIds: string[] = [];
    for (const id of inProgressIds) {
      const item = await opts.adapter.getWorkItem(id);
      if (isAssignedToSelf(item.assignees, me)) ownInProgressIds.push(id);
    }

    if (ownInProgressIds.length > 1) {
      // Auto-heal only my own WIP drift, keep deterministic primary item (first in adapter order).
      const keepId = ownInProgressIds[0]!;
      for (const id of ownInProgressIds.slice(1)) {
        await opts.adapter.setStage(id, 'stage:backlog');
        try {
          await opts.adapter.addComment(
            id,
            'Moved back to Backlog automatically: per-user WIP limit allows only one active ticket for this worker.',
          );
        } catch {
          // Do not fail tick when comment posting fails.
        }
      }
      return {
        kind: 'in_progress',
        id: keepId,
        inProgressIds: [keepId],
      };
    }

    if (ownInProgressIds.length > 0) {
      return {
        kind: 'in_progress',
        id: ownInProgressIds[0]!,
        inProgressIds: ownInProgressIds,
      };
    }

    const backlogOrderedIds = await opts.adapter.listBacklogIdsInOrder();
    const nextId = backlogOrderedIds[0];
    if (!nextId) return { kind: 'no_work' };

    await opts.adapter.setStage(nextId, 'stage:in-progress');
    return { kind: 'started', id: nextId };
  } finally {
    await acquired.release();
  }
}

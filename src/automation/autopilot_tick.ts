import type { Actor } from '../core/ports.js';
import type { StageKey } from '../stage.js';

export type AutopilotEvidence = {
  updatedAt?: string;
  minutesStale?: number;
  matchedSignal?: string;
};

export type AutopilotTickResult =
  | { kind: 'no_work'; reasonCode?: string; evidence?: AutopilotEvidence }
  | { kind: 'in_progress'; id: string; inProgressIds: string[]; reasonCode?: string; evidence?: AutopilotEvidence }
  | { kind: 'started'; id: string; reasonCode?: string; evidence?: AutopilotEvidence }
  | { kind: 'blocked'; id: string; minutesStale: number; reason: string; reasonCode: string; evidence?: AutopilotEvidence }
  | { kind: 'completed'; id: string; reason: string; reasonCode: string; evidence?: AutopilotEvidence };
export type AutopilotTickPort = {
  whoami(): Promise<Actor>;
  listIdsByStage(stage: StageKey): Promise<string[]>;
  listBacklogIdsInOrder(): Promise<string[]>;
  getWorkItem(id: string): Promise<{ title?: string; assignees?: Actor[]; updatedAt?: Date }>;
  listComments?(
    id: string,
    opts: { limit: number; newestFirst: boolean; includeInternal: boolean },
  ): Promise<Array<{ body: string; createdAt?: Date }>>;
  setStage(id: string, stage: StageKey): Promise<void>;
  addComment(id: string, body: string): Promise<void>;
  reconcileAssignments?(): Promise<void>;
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

const STALE_MINUTES_FOR_BLOCK = 10;
const BLOCKER_KEYWORDS = [
  'permission denied',
  'access denied',
  'connection refused',
  'timed out',
  'timeout',
  'lookup failed',
  'dns',
  'missing credential',
  'waiting on',
  'blocked',
  'cannot proceed',
];

function isStale(updatedAt: Date | undefined, now: Date, thresholdMinutes: number): number {
  if (!updatedAt) return 0;
  const minutes = Math.floor((now.getTime() - updatedAt.getTime()) / 60000);
  return minutes >= thresholdMinutes ? minutes : 0;
}

function hasBlockerSignal(text: string): boolean {
  const v = text.toLowerCase();
  return BLOCKER_KEYWORDS.some((k) => v.includes(k));
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
    if (typeof opts.adapter.reconcileAssignments === 'function') {
      await opts.adapter.reconcileAssignments();
    }

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
        // Defensive re-check right before mutating state.
        const latest = await opts.adapter.getWorkItem(id);
        if (!isAssignedToSelf(latest.assignees, me)) {
          continue;
        }

        await opts.adapter.setStage(id, 'stage:todo');
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
      const activeId = ownInProgressIds[0]!;
      const active = await opts.adapter.getWorkItem(activeId);
      const minutesStale = isStale(active.updatedAt, opts.now, STALE_MINUTES_FOR_BLOCK);

      if (typeof opts.adapter.listComments === 'function') {
        const recentComments = await opts.adapter.listComments(activeId, {
          limit: 5,
          newestFirst: true,
          includeInternal: true,
        });

        // Completion decision: if recent updates include a clear completion signal,
        // advance to In Review and stop active execution.
        // Blocked decision: stale ticket + blocker signal in recent comments.
        if (minutesStale > 0) {
          const blocker = recentComments.find((c) => hasBlockerSignal(c.body ?? ''));
          if (blocker) {
            const reason = 'Auto-blocked: stale in-progress item with blocker signal in recent updates.';
            return {
              kind: 'blocked',
              id: activeId,
              minutesStale,
              reason,
              reasonCode: 'stale_with_blocker_signal',
              evidence: {
                updatedAt: active.updatedAt?.toISOString(),
                minutesStale,
                matchedSignal: BLOCKER_KEYWORDS.find((k) => (blocker.body ?? '').toLowerCase().includes(k)),
              },
            };
          }
        }
      }

      return {
        kind: 'in_progress',
        id: activeId,
        inProgressIds: ownInProgressIds,
      };
    }

    const backlogOrderedIds = await opts.adapter.listBacklogIdsInOrder();
    const nextId = backlogOrderedIds[0];
    if (!nextId) return { kind: 'no_work', reasonCode: 'no_backlog_assigned' };

    // Hard assignment gate: never start work on tickets not explicitly assigned to me.
    const nextItem = await opts.adapter.getWorkItem(nextId);
    if (!isAssignedToSelf(nextItem.assignees, me)) {
      return { kind: 'no_work', reasonCode: 'next_not_assigned_to_me' };
    }

    return {
      kind: 'started',
      id: nextId,
      reasonCode: 'start_next_assigned_backlog',
      evidence: { updatedAt: nextItem.updatedAt?.toISOString() },
    };
  } finally {
    await acquired.release();
  }
}

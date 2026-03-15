import { runAutoReopenOnHumanComment } from '../automation/auto_reopen.js';
import type { SessionMap } from '../automation/session_dispatcher.js';
import type { StageKey } from '../stage.js';
import { currentActiveSession } from './workflow_state.js';
import {
  loadWorkerDelegationState,
  type WorkerRuntimeOptions,
} from './worker_runtime.js';
import { show, start } from '../verbs/verbs.js';

function actorKeys(actor: { id?: string; username?: string; name?: string } | undefined): string[] {
  if (!actor) return [];
  return [actor.id, actor.username, actor.name]
    .filter((x): x is string => Boolean(x && String(x).trim().length > 0))
    .map((x) => String(x).trim().toLowerCase());
}

function isAssignedToSelf(
  assignees: readonly { id?: string; username?: string; name?: string }[] | undefined,
  me: { id?: string; username?: string; name?: string },
): boolean {
  if (!assignees || assignees.length === 0) return false;
  const meKeys = new Set(actorKeys(me));
  if (meKeys.size === 0) return false;
  return assignees.some((a) => actorKeys(a).some((k) => meKeys.has(k)));
}

function tokenize(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/);
  return new Set(words.filter((w) => w.length >= 3));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const tok of a) {
    if (b.has(tok)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

async function findPotentialDuplicates(
  adapter: any,
  selectedTicketId: string,
  selectedTitle: string,
  maxResults = 10,
): Promise<Array<{ id: string; identifier?: string; title: string; url?: string; stage?: string; score: number }>> {
  const selectedTokens = tokenize(selectedTitle);
  if (selectedTokens.size === 0) return [];

  const stageKeys: StageKey[] = ['stage:todo', 'stage:blocked', 'stage:in-progress', 'stage:in-review'];
  const candidateIds = new Set<string>();
  for (const stage of stageKeys) {
    try {
      const ids: string[] = await adapter.listIdsByStage(stage);
      for (const id of ids) {
        if (id !== selectedTicketId) candidateIds.add(id);
      }
    } catch {
      // best-effort only
    }
  }

  try {
    const backlogIds: string[] = await adapter.listBacklogIdsInOrder();
    for (const id of backlogIds) {
      if (id !== selectedTicketId) candidateIds.add(id);
    }
  } catch {
    // best-effort only
  }

  const scored: Array<{ id: string; identifier?: string; title: string; url?: string; stage?: string; score: number }> = [];
  for (const id of candidateIds) {
    try {
      const item = await adapter.getWorkItem(id);
      const title = String(item?.title ?? '');
      const tokens = tokenize(title);
      const score = jaccardSimilarity(selectedTokens, tokens);
      if (score > 0.15) {
        scored.push({
          id,
          identifier: item?.identifier,
          title,
          url: item?.url,
          stage: item?.stage,
          score: Math.round(score * 1000) / 1000,
        });
      }
    } catch {
      // Skip items that fail to load.
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults);
}

export async function runWorkflowLoopSelection(params: {
  adapter: any;
  map: SessionMap;
  dryRun: boolean;
  requeueTargetStage?: StageKey;
  workerRuntimeOptions?: WorkerRuntimeOptions;
}): Promise<any> {
  const requeueTargetStage = params.requeueTargetStage ?? 'stage:todo';
  const autoReopen = await runAutoReopenOnHumanComment({
    adapter: params.adapter,
    map: params.map,
    dryRun: params.dryRun,
    requeueTargetStage,
  });
  const me = await params.adapter.whoami();
  const inProgressIds: string[] = await params.adapter.listIdsByStage('stage:in-progress');

  const ownInProgress: Array<{ id: string; updatedAt?: Date }> = [];
  for (const id of inProgressIds) {
    const item = await params.adapter.getWorkItem(id);
    if (isAssignedToSelf(item.assignees, me)) {
      ownInProgress.push({ id, updatedAt: item.updatedAt });
    }
  }

  if (ownInProgress.length > 0) {
    ownInProgress.sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
    const keep = ownInProgress[0]!;
    const active = currentActiveSession(params.map);
    if (!params.dryRun && active?.ticketId === keep.id && params.workerRuntimeOptions) {
      const delegationState = await loadWorkerDelegationState(
        active.sessionId,
        keep.id,
        params.workerRuntimeOptions,
      );
      if (delegationState.kind === 'running' || delegationState.kind === 'completed') {
        const item = await params.adapter.getWorkItem(keep.id);
        return {
          tick: { kind: 'in_progress', id: keep.id, inProgressIds: [keep.id] },
          nextTicket: {
            adapter: typeof params.adapter.name === 'function' ? params.adapter.name() : 'plane',
            item,
            comments: [],
          },
          autoReopen,
          dryRun: params.dryRun,
        };
      }
    }

    if (!params.dryRun) {
      for (const extra of ownInProgress.slice(1)) {
        await params.adapter.setStage(extra.id, 'stage:todo');
      }
    }
    const payload = await show(params.adapter, keep.id);
    const potentialDuplicates = await findPotentialDuplicates(
      params.adapter, keep.id, String(payload?.item?.title ?? ''),
    );
    return {
      tick: { kind: 'in_progress', id: keep.id, inProgressIds: [keep.id] },
      nextTicket: { ...payload, potentialDuplicates },
      autoReopen,
      dryRun: params.dryRun,
    };
  }

  const backlogIds: string[] = await params.adapter.listBacklogIdsInOrder();
  for (const id of backlogIds) {
    const item = await params.adapter.getWorkItem(id);
    if (!isAssignedToSelf(item.assignees, me)) continue;
    if (!params.dryRun) {
      await start(params.adapter, id);
    }
    const payload = await show(params.adapter, id);
    const potentialDuplicates = await findPotentialDuplicates(
      params.adapter, id, String(payload?.item?.title ?? ''),
    );
    return {
      tick: { kind: 'started', id, reasonCode: 'start_next_assigned_backlog' },
      nextTicket: { ...payload, potentialDuplicates },
      autoReopen,
      dryRun: params.dryRun,
    };
  }

  return {
    tick: { kind: 'no_work', reasonCode: 'no_backlog_assigned' },
    autoReopen,
    dryRun: params.dryRun,
  };
}

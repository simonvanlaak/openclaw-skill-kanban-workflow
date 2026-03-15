import { runAutoReopenOnHumanComment } from '../automation/auto_reopen.js';
import {
  ensureSessionForTicket,
  markSessionInProgress,
  type SessionMap,
} from '../automation/session_dispatcher.js';
import type { StageKey } from '../stage.js';
import { currentActiveSession } from './workflow_state.js';
import {
  loadWorkerDelegationState,
  type WorkerRuntimeOptions,
} from './worker_runtime.js';
import type { WorkflowLoopSelectionOutput } from './workflow_loop_ports.js';
import type { ShowPayload, WorkItemAttachment, WorkItemDetails, WorkItemLink } from '../verbs/types.js';

type WorkflowLoopSelectionAdapter = {
  name(): string;
  whoami(): Promise<{ id?: string; username?: string; name?: string }>;
  listIdsByStage(stage: StageKey): Promise<string[]>;
  listBacklogIdsInOrder(): Promise<string[]>;
  getWorkItem(id: string): Promise<WorkItemDetails>;
  listComments(
    id: string,
    opts: { limit?: number; newestFirst: boolean; includeInternal: boolean },
  ): Promise<ShowPayload['comments']>;
  listAttachments(id: string): Promise<WorkItemAttachment[]>;
  listLinkedWorkItems(id: string): Promise<WorkItemLink[]>;
  setStage(id: string, stage: StageKey): Promise<void>;
};

function minimalTicketPayload(
  adapter: WorkflowLoopSelectionAdapter,
  item: WorkItemDetails,
): ShowPayload {
  return {
    adapter: adapter.name(),
    item,
    comments: [],
  };
}

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

async function reserveBacklogTicket(params: {
  adapter: Pick<WorkflowLoopSelectionAdapter, 'setStage'>;
  map: SessionMap;
  ticketId: string;
  ticketTitle?: string;
  identifier?: string;
  persistMap?: (map: SessionMap) => Promise<void>;
}): Promise<void> {
  const nowIso = new Date().toISOString();
  ensureSessionForTicket(
    params.map,
    params.ticketId,
    nowIso,
    params.ticketTitle,
    params.identifier,
  );

  const entry = params.map.sessionsByTicket[params.ticketId];
  const pending = entry?.pendingMutation;
  const reusePending = pending?.kind === 'ticket_reservation' && pending.targetStage === 'stage:in-progress';
  if (entry && !reusePending) {
    entry.pendingMutation = {
      kind: 'ticket_reservation',
      targetStage: 'stage:in-progress',
      createdAt: nowIso,
    };
    await params.persistMap?.(params.map);
  }

  const currentPending = params.map.sessionsByTicket[params.ticketId]?.pendingMutation;
  if (currentPending?.kind === 'ticket_reservation' && !currentPending.stageAppliedAt) {
    await params.adapter.setStage(params.ticketId, 'stage:in-progress');
    currentPending.stageAppliedAt = new Date().toISOString();
    await params.persistMap?.(params.map);
  } else if (!currentPending || currentPending.kind !== 'ticket_reservation') {
    await params.adapter.setStage(params.ticketId, 'stage:in-progress');
  }
}

export async function runWorkflowLoopSelection(params: {
  adapter: WorkflowLoopSelectionAdapter;
  map: SessionMap;
  dryRun: boolean;
  requeueTargetStage?: StageKey;
  workerRuntimeOptions?: WorkerRuntimeOptions;
  persistMap?(map: SessionMap): Promise<void>;
}): Promise<WorkflowLoopSelectionOutput> {
  const requeueTargetStage = params.requeueTargetStage ?? 'stage:todo';
  const autoReopen = await runAutoReopenOnHumanComment({
    adapter: params.adapter,
    map: params.map,
    dryRun: params.dryRun,
    requeueTargetStage,
    persistMap: params.persistMap,
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
    const keepEntry = params.map.sessionsByTicket[keep.id];
    if (
      !params.dryRun &&
      keepEntry?.pendingMutation?.kind === 'ticket_reservation' &&
      keepEntry.pendingMutation.stageAppliedAt
    ) {
      markSessionInProgress(params.map, keep.id, new Date());
      await params.persistMap?.(params.map);
    }
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
          nextTicket: minimalTicketPayload(params.adapter, item),
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
    return {
      tick: { kind: 'in_progress', id: keep.id, inProgressIds: [keep.id] },
      nextTicket: minimalTicketPayload(params.adapter, await params.adapter.getWorkItem(keep.id)),
      autoReopen,
      dryRun: params.dryRun,
    };
  }

  const backlogIds: string[] = await params.adapter.listBacklogIdsInOrder();
  for (const id of backlogIds) {
    const item = await params.adapter.getWorkItem(id);
    if (!isAssignedToSelf(item.assignees, me)) continue;
    if (!params.dryRun) {
      await reserveBacklogTicket({
        adapter: params.adapter,
        map: params.map,
        ticketId: id,
        ticketTitle: item.title,
        identifier: item.identifier,
        persistMap: params.persistMap,
      });
    }
    return {
      tick: { kind: 'started', id, reasonCode: 'start_next_assigned_backlog' },
      nextTicket: minimalTicketPayload(params.adapter, item),
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

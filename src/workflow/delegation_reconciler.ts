import {
  loadSessionMap,
  saveSessionMap,
  type SessionMap,
} from '../automation/session_dispatcher.js';
import type { StageKey } from '../stage.js';
import {
  loadWorkerDelegationState,
  type WorkerRuntimeOptions,
} from './worker_runtime.js';
import { applyWorkerOutputToTicket, type WorkerExecutionOutcome } from './worker_output_applier.js';
import { runWorkflowLoopSelection } from './workflow_loop_selection.js';
import { runWorkflowLoopController, type WorkflowLoopControllerResult } from './workflow_loop_controller.js';
import type { WorkflowLifecycleAdapter } from './workflow_loop_ports.js';

export type DelegationReconcileResult =
  | {
      quiet: true;
      exitCode: number;
      reason: 'none' | 'running';
    }
  | {
      quiet: false;
      exitCode: number;
    payload: {
      delegationReconcile: {
        ticketId: string;
        sessionId: string;
        execution: WorkerExecutionOutcome;
        handoff: WorkflowLoopControllerResult | null;
        mapPath: string;
      };
    };
  };

type AdapterLike = WorkflowLifecycleAdapter & {
  getWorkItem?(ticketId: string): Promise<any>;
};

function cloneMap(map: SessionMap): SessionMap {
  return JSON.parse(JSON.stringify(map)) as SessionMap;
}

function shouldAttemptImmediateHandoff(execution: WorkerExecutionOutcome, map: SessionMap): boolean {
  if (execution.outcome !== 'applied') return false;
  if (!execution.parsed) return false;
  if (map.active) return false;
  return execution.parsed.kind === 'completed' || execution.parsed.kind === 'blocked' || execution.parsed.kind === 'uncertain';
}

function ensureActiveDelegationSession(map: SessionMap, ticketId: string, sessionId: string, nowIso: string): void {
  if (!map.sessionsByTicket) {
    map.sessionsByTicket = {};
  }
  const previous = map.sessionsByTicket[ticketId];
  map.sessionsByTicket[ticketId] = {
    sessionId,
    lastState: 'in_progress',
    lastSeenAt: nowIso,
    workStartedAt: previous?.workStartedAt ?? nowIso,
    continueCount: previous?.continueCount,
    sessionLabel: previous?.sessionLabel,
  };
  map.active = { ticketId, sessionId };
}

function recordCompletedWorkDuration(map: SessionMap, ticketId: string, completedAt: Date): void {
  const entry = map.sessionsByTicket?.[ticketId];
  const startedAtIso = entry?.workStartedAt;
  if (!startedAtIso) return;
  const startedMs = Date.parse(startedAtIso);
  const endedMs = completedAt.getTime();
  if (!Number.isFinite(startedMs) || endedMs <= startedMs) return;
  const durationMs = endedMs - startedMs;
  const queueState =
    map.queuePosition ??
    (map.queuePosition = {
      commentsByTicket: {},
      recentCompletionDurationsMs: [],
    });
  const samples = Array.isArray(queueState.recentCompletionDurationsMs)
    ? queueState.recentCompletionDurationsMs
    : [];
  queueState.recentCompletionDurationsMs = [...samples, durationMs].slice(-3);
}

export async function runDelegationReconciler(params: {
  adapter: AdapterLike;
  ticketId: string;
  sessionId: string;
  dispatchRunId: string;
  workerAgentId: string;
  workerRuntimeOptions: WorkerRuntimeOptions;
  requeueTargetStage?: StageKey;
  mapPath?: string;
}): Promise<DelegationReconcileResult> {
  const delegationState = await loadWorkerDelegationState(
    params.sessionId,
    params.ticketId,
    params.workerRuntimeOptions,
  );

  if (delegationState.kind === 'none') {
    return { quiet: true, exitCode: 0, reason: 'none' };
  }
  if (delegationState.kind === 'running') {
    return { quiet: true, exitCode: 0, reason: 'running' };
  }

  const previousMap = await loadSessionMap(params.mapPath);
  const map = cloneMap(previousMap);
  const nowIso = new Date().toISOString();
  ensureActiveDelegationSession(map, params.ticketId, params.sessionId, nowIso);

  const item = typeof params.adapter.getWorkItem === 'function'
    ? await params.adapter.getWorkItem(params.ticketId)
    : undefined;

  const execution = await applyWorkerOutputToTicket({
    adapter: params.adapter,
    map,
    action: {
      sessionId: params.sessionId,
      ticketId: params.ticketId,
      projectId: item?.projectId ? String(item.projectId) : item?.project_id ? String(item.project_id) : undefined,
    },
    workerOutput: delegationState.workerOutput,
    dispatchRunId: params.dispatchRunId,
    workerAgentId: params.workerAgentId,
    workerRuntimeOptions: params.workerRuntimeOptions,
    detailPrefix: 'source=background-delegation-event',
    routing: delegationState.routing,
    onCompleted: (ticketId, completedAt) => recordCompletedWorkDuration(map, ticketId, completedAt),
    persistMap: async (nextMap) => saveSessionMap(nextMap, params.mapPath),
  });

  let handoff: WorkflowLoopControllerResult | null = null;
  if (shouldAttemptImmediateHandoff(execution, map)) {
    const handoffPreviousMap = cloneMap(map);
    const handoffOutput = await runWorkflowLoopSelection({
      adapter: params.adapter as any,
      map,
      dryRun: false,
      requeueTargetStage: params.requeueTargetStage,
      workerRuntimeOptions: params.workerRuntimeOptions,
      persistMap: async (nextMap) => saveSessionMap(nextMap, params.mapPath),
    });

    handoff = await runWorkflowLoopController({
      adapter: params.adapter as any,
      output: handoffOutput,
      previousMap: handoffPreviousMap,
      dryRun: false,
      dispatchRunId: `${params.dispatchRunId}:handoff`,
      workerAgentId: params.workerAgentId,
      workerRuntimeOptions: params.workerRuntimeOptions,
      mapPath: params.mapPath,
    });
  }

  return {
    quiet: false,
    exitCode: 0,
    payload: {
      delegationReconcile: {
        ticketId: params.ticketId,
        sessionId: params.sessionId,
        execution,
        handoff,
        mapPath: params.mapPath ?? '.tmp/kwf-session-map.json',
      },
    },
  };
}

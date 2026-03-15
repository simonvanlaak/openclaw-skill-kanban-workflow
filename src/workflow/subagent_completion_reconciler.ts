import {
  loadSessionMap,
} from '../automation/session_dispatcher.js';
import type { StageKey } from '../stage.js';
import type { WorkerRuntimeOptions } from './worker_runtime.js';
import { runDelegationReconciler, type DelegationReconcileResult } from './delegation_reconciler.js';
import type { WorkflowLifecycleAdapter } from './workflow_loop_ports.js';

export type SubagentCompletionReconcileResult =
  | {
      quiet: true;
      exitCode: number;
      reason: 'not_found' | 'not_worker_subagent';
    }
  | {
      quiet: false;
      exitCode: number;
      payload: {
        subagentCompletionReconcile: {
          childSessionKey: string;
          ticketId: string;
          sessionId: string;
          delegation: DelegationReconcileResult;
        };
      };
    };

function isWorkerSubagentSessionKey(sessionKey: string, workerAgentId: string): boolean {
  return sessionKey.trim().startsWith(`agent:${workerAgentId}:subagent:`);
}

export function findTicketByChildSessionKey(
  map: Awaited<ReturnType<typeof loadSessionMap>>,
  childSessionKey: string,
): { ticketId: string; sessionId: string } | null {
  for (const [ticketId, entry] of Object.entries(map.sessionsByTicket ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.activeRun?.status !== 'started') continue;
    if (String(entry.activeRun.sessionKey ?? '').trim() !== childSessionKey.trim()) continue;
    const sessionId = String(entry.sessionId ?? '').trim();
    if (!sessionId) continue;
    return { ticketId, sessionId };
  }
  return null;
}

export async function runSubagentCompletionReconciler(params: {
  adapter: WorkflowLifecycleAdapter & { getWorkItem?(ticketId: string): Promise<any> };
  childSessionKey: string;
  dispatchRunId: string;
  workerAgentId: string;
  workerRuntimeOptions: WorkerRuntimeOptions;
  requeueTargetStage?: StageKey;
  mapPath?: string;
}): Promise<SubagentCompletionReconcileResult> {
  if (!isWorkerSubagentSessionKey(params.childSessionKey, params.workerAgentId)) {
    return { quiet: true, exitCode: 0, reason: 'not_worker_subagent' };
  }

  const map = await loadSessionMap(params.mapPath);
  const match = findTicketByChildSessionKey(map, params.childSessionKey);
  if (!match) {
    return { quiet: true, exitCode: 0, reason: 'not_found' };
  }

  const delegation = await runDelegationReconciler({
    adapter: params.adapter,
    ticketId: match.ticketId,
    sessionId: match.sessionId,
    dispatchRunId: params.dispatchRunId,
    workerAgentId: params.workerAgentId,
    workerRuntimeOptions: params.workerRuntimeOptions,
    requeueTargetStage: params.requeueTargetStage,
    mapPath: params.mapPath,
  });

  return {
    quiet: false,
    exitCode: delegation.exitCode,
    payload: {
      subagentCompletionReconcile: {
        childSessionKey: params.childSessionKey,
        ticketId: match.ticketId,
        sessionId: match.sessionId,
        delegation,
      },
    },
  };
}

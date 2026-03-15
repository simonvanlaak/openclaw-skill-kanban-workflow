import {
  buildWorkflowLoopPlan,
  markSessionInProgress,
  saveSessionMap,
  type SessionEntry,
  type SessionMap,
  type WorkerCommandResult,
} from '../automation/session_dispatcher.js';
import { shouldQuietPollAfterCarryForward } from './decision_policy.js';
import {
  runWorkflowLoopHousekeeping,
} from './workflow_loop_housekeeping.js';
import {
  dispatchWorkerTurn,
  loadWorkerDelegationState,
  type WorkerRuntimeOptions,
} from './worker_runtime.js';
import { recoverWorkerDecisionFromComments } from './worker_decision_recovery.js';
import { applyWorkerOutputToTicket, type WorkerExecutionOutcome } from './worker_output_applier.js';
import type {
  WorkflowLoopControllerAdapter,
  WorkflowLoopSelectionOutput,
} from './workflow_loop_ports.js';

export type WorkflowLoopExecution = WorkerExecutionOutcome | {
  sessionId: string;
  ticketId: string;
  parsed: WorkerCommandResult | null;
  workerOutput: string;
  outcome: 'delegated_running';
  detail?: string;
};

export type WorkflowLoopControllerResult =
  | { quiet: true; exitCode: number }
  | {
      quiet: false;
      exitCode: number;
      payload: {
        workflowLoop: {
          dryRun: boolean;
          dispatchRunId: string;
          actions: import('../automation/session_dispatcher.js').DispatchAction[];
          execution: WorkflowLoopExecution[];
          noWorkAlert: import('./no_work_alert.js').NoWorkAlertResult | null;
          queuePositionUpdate: import('./queue_position_comments.js').QueuePositionReconcileResult | null;
          rocketChatStatusUpdate: import('./rocketchat_status.js').RocketChatStatusUpdate | null;
          activeTicketId: string | null;
          mapPath: string;
        };
        autopilot: WorkflowLoopSelectionOutput;
      };
    };

export async function runWorkflowLoopController(params: {
  adapter: WorkflowLoopControllerAdapter;
  output: WorkflowLoopSelectionOutput;
  previousMap: SessionMap;
  dryRun: boolean;
  dispatchRunId: string;
  workerAgentId: string;
  workerRuntimeOptions: WorkerRuntimeOptions;
  mapPath?: string;
}): Promise<WorkflowLoopControllerResult> {
  const { adapter, output, previousMap, dryRun, dispatchRunId, workerAgentId, workerRuntimeOptions } = params;
  const plan = buildWorkflowLoopPlan({ autopilotOutput: output, previousMap, now: new Date() });

  const activeCarryForward = Boolean(
    !dryRun &&
      output?.tick?.kind === 'in_progress' &&
      previousMap.active?.ticketId &&
      previousMap.active.ticketId === plan.activeTicketId
  );

  const execution: WorkflowLoopExecution[] = [];

  const ensureSessionEntry = (ticketId: string, sessionId: string): SessionEntry => {
    const existing = plan.map.sessionsByTicket?.[ticketId];
    if (existing) return existing;
    const nowIso = new Date().toISOString();
    const created: SessionEntry = {
      sessionId,
      lastState: 'in_progress',
      lastSeenAt: nowIso,
      workStartedAt: nowIso,
    };
    plan.map.sessionsByTicket[ticketId] = created;
    return created;
  };

  const recordCompletedWorkDuration = (ticketId: string, completedAt: Date): void => {
    const entry = plan.map.sessionsByTicket?.[ticketId];
    const startedAtIso = entry?.workStartedAt;
    if (!startedAtIso) return;
    const startedMs = Date.parse(startedAtIso);
    const endedMs = completedAt.getTime();
    if (!Number.isFinite(startedMs) || endedMs <= startedMs) return;
    const durationMs = endedMs - startedMs;
    const queueState =
      plan.map.queuePosition ??
      (plan.map.queuePosition = {
        commentsByTicket: {},
        recentCompletionDurationsMs: [],
      });
    const samples = Array.isArray(queueState.recentCompletionDurationsMs)
      ? queueState.recentCompletionDurationsMs
      : [];
    queueState.recentCompletionDurationsMs = [...samples, durationMs].slice(-3);
  };

  if (!dryRun) {
    if (plan.actions.some((action) => action.kind === 'work')) {
      await saveSessionMap(plan.map);
    }

    for (const action of plan.actions) {
      if (action.kind === 'work') {
        const recoveredExecution = await recoverWorkerDecisionFromComments({
          adapter,
          map: plan.map,
          output,
          action,
          onCompleted: recordCompletedWorkDuration,
        });
        if (recoveredExecution) {
          execution.push(recoveredExecution);
          continue;
        }

        const delegationState = await loadWorkerDelegationState(action.sessionId, action.ticketId, workerRuntimeOptions);
        if (delegationState.kind === 'running') {
          markSessionInProgress(plan.map, action.ticketId, new Date());
          execution.push({
            sessionId: action.sessionId,
            ticketId: action.ticketId,
            parsed: null,
            workerOutput: '',
            outcome: 'delegated_running',
            detail: `background_started_at=${delegationState.meta.startedAt}`,
          });
          continue;
        }

        if (delegationState.kind === 'completed') {
          execution.push(await applyWorkerOutputToTicket({
            adapter,
            map: plan.map,
            action,
            workerOutput: delegationState.workerOutput,
            dispatchRunId,
            workerAgentId,
            workerRuntimeOptions,
            detailPrefix: 'source=background-delegation',
            routing: delegationState.routing,
            onCompleted: recordCompletedWorkDuration,
            persistMap: async (nextMap) => saveSessionMap(nextMap, params.mapPath),
          }));
          continue;
        }
      }

      const dispatched = await dispatchWorkerTurn({
        ticketId: action.ticketId,
        projectId: action.projectId,
        dispatchRunId,
        agentId: workerAgentId,
        sessionId: action.sessionId,
        text: action.text,
        thinking: 'high',
      }, workerRuntimeOptions);

      if (action.kind !== 'work') continue;

      if (dispatched.kind === 'delegated') {
        const entry = ensureSessionEntry(action.ticketId, action.sessionId);
        entry.activeRun = {
          runId: dispatched.runId,
          status: 'started',
          sentAt: dispatched.startedAt,
          waitTimeoutSeconds: dispatched.waitTimeoutSeconds,
          sessionKey: dispatched.sessionKey,
        };
        markSessionInProgress(plan.map, action.ticketId, new Date());
        execution.push({
          sessionId: action.sessionId,
          ticketId: action.ticketId,
          parsed: null,
          workerOutput: dispatched.notice,
          outcome: 'delegated_started',
          detail: 'source=sync-timeout; ticket_notified=false',
        });
        continue;
      }

      execution.push(await applyWorkerOutputToTicket({
        adapter,
        map: plan.map,
        action,
        workerOutput: dispatched.workerOutput,
        dispatchRunId,
        workerAgentId,
        workerRuntimeOptions,
        routing: dispatched.routing,
        onCompleted: recordCompletedWorkDuration,
        persistMap: async (nextMap) => saveSessionMap(nextMap, params.mapPath),
      }));
    }
  }

  const housekeeping = await runWorkflowLoopHousekeeping({
    adapter,
    output,
    previousMap,
    map: plan.map,
    dryRun,
  });

  if (!dryRun) {
    await saveSessionMap(plan.map);

    if (
      shouldQuietPollAfterCarryForward({
        activeCarryForward,
        executionOutcomes: execution.map((x) => x.outcome),
      })
    ) {
      return { quiet: true, exitCode: 0 };
    }
  }

  return {
    quiet: false,
    exitCode: 0,
    payload: {
      workflowLoop: {
        dryRun,
        dispatchRunId,
        actions: plan.actions,
        execution,
        noWorkAlert: housekeeping.noWorkAlert,
        queuePositionUpdate: housekeeping.queuePositionUpdate,
        rocketChatStatusUpdate: housekeeping.rocketChatStatusUpdate,
        activeTicketId: plan.activeTicketId,
        mapPath: params.mapPath ?? '.tmp/kwf-session-map.json',
      },
      autopilot: output,
    },
  };
}

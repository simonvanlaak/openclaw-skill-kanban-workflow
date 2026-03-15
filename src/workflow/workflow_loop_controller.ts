import {
  applyWorkerCommandToSessionMap,
  buildWorkflowLoopPlan,
  markSessionInProgress,
  saveSessionMap,
  type SessionMap,
  type WorkerCommandResult,
} from '../automation/session_dispatcher.js';
import { shouldQuietPollAfterCarryForward } from './decision_policy.js';
import {
  maybeSendNoWorkFirstHitAlert,
  type NoWorkAlertResult,
} from './no_work_alert.js';
import {
  maybeUpdateRocketChatStatusFromWorkflowLoop,
  type RocketChatStatusUpdate,
} from './rocketchat_status.js';
import {
  reconcileQueuePositionComments,
  type QueuePositionReconcileResult,
} from './queue_position_comments.js';
import { buildRetryPrompt } from './ticket_runtime.js';
import {
  dispatchWorkerTurn,
  loadWorkerDelegationState,
  type WorkerRuntimeOptions,
} from './worker_runtime.js';
import { applyWorkerOutputToTicket, type WorkerExecutionOutcome } from './worker_output_applier.js';

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
          actions: any[];
          execution: WorkflowLoopExecution[];
          noWorkAlert: NoWorkAlertResult | null;
          queuePositionUpdate: QueuePositionReconcileResult | null;
          rocketChatStatusUpdate: RocketChatStatusUpdate | null;
          activeTicketId: string | null;
          mapPath: string;
        };
        autopilot: any;
      };
    };

export async function runWorkflowLoopController(params: {
  adapter: any;
  output: any;
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
  let noWorkAlert: NoWorkAlertResult | null = null;
  let rocketChatStatusUpdate: RocketChatStatusUpdate | null = null;
  let queuePositionUpdate: QueuePositionReconcileResult | null = null;

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
      }));
    }
  }

  noWorkAlert = await maybeSendNoWorkFirstHitAlert({
    output,
    previousMap,
    map: plan.map,
    dryRun,
  });

  try {
    queuePositionUpdate = await reconcileQueuePositionComments({
      adapter,
      map: plan.map,
      dryRun,
    });
  } catch (err: any) {
    queuePositionUpdate = {
      outcome: 'error',
      queuedTickets: 0,
      activeOffset: 0,
      created: 0,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      errors: [err?.message ?? String(err)],
    };
  }

  rocketChatStatusUpdate = await maybeUpdateRocketChatStatusFromWorkflowLoop({
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
        noWorkAlert,
        queuePositionUpdate,
        rocketChatStatusUpdate,
        activeTicketId: plan.activeTicketId,
        mapPath: params.mapPath ?? '.tmp/kwf-session-map.json',
      },
      autopilot: output,
    },
  };
}

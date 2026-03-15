import type { SessionMap } from '../automation/session_dispatcher.js';
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
import type {
  WorkflowHousekeepingAdapter,
  WorkflowLoopSelectionOutput,
} from './workflow_loop_ports.js';
import { deriveWorkflowLoopState } from './workflow_loop_derived_state.js';

export type WorkflowLoopHousekeepingResult = {
  noWorkAlert: NoWorkAlertResult | null;
  queuePositionUpdate: QueuePositionReconcileResult | null;
  rocketChatStatusUpdate: RocketChatStatusUpdate | null;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function captureActiveLifecycleState(map: SessionMap): { active?: SessionMap['active']; activeEntry?: unknown } {
  const active = map.active ? clone(map.active) : undefined;
  const activeEntry = active?.ticketId ? clone(map.sessionsByTicket?.[active.ticketId]) : undefined;
  return { active, activeEntry };
}

function assertActiveLifecycleUnchanged(params: {
  before: { active?: SessionMap['active']; activeEntry?: unknown };
  after: SessionMap;
}): void {
  const afterActive = params.after.active ? clone(params.after.active) : undefined;
  const afterEntry = afterActive?.ticketId ? clone(params.after.sessionsByTicket?.[afterActive.ticketId]) : undefined;
  if (JSON.stringify(params.before.active) !== JSON.stringify(afterActive)) {
    throw new Error('housekeeping mutated active ticket routing state');
  }
  if (JSON.stringify(params.before.activeEntry) !== JSON.stringify(afterEntry)) {
    throw new Error('housekeeping mutated active ticket lifecycle entry');
  }
}

export async function runWorkflowLoopHousekeeping(params: {
  adapter: WorkflowHousekeepingAdapter;
  output: WorkflowLoopSelectionOutput;
  previousMap: SessionMap;
  map: SessionMap;
  dryRun: boolean;
}): Promise<WorkflowLoopHousekeepingResult> {
  const lifecycleBefore = captureActiveLifecycleState(params.map);
  const derivedState = deriveWorkflowLoopState({
    output: params.output,
    map: params.map,
  });

  const noWorkAlert = await maybeSendNoWorkFirstHitAlert({
    derivedState,
    previousMap: params.previousMap,
    map: params.map,
    dryRun: params.dryRun,
  });

  let queuePositionUpdate: QueuePositionReconcileResult | null = null;
  try {
    queuePositionUpdate = await reconcileQueuePositionComments({
      adapter: params.adapter,
      map: params.map,
      dryRun: params.dryRun,
      activeTicketId: derivedState.activeTicketId,
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

  const rocketChatStatusUpdate = await maybeUpdateRocketChatStatusFromWorkflowLoop({
    derivedState,
    previousMap: params.previousMap,
    map: params.map,
    dryRun: params.dryRun,
  });

  assertActiveLifecycleUnchanged({ before: lifecycleBefore, after: params.map });

  return {
    noWorkAlert,
    queuePositionUpdate,
    rocketChatStatusUpdate,
  };
}

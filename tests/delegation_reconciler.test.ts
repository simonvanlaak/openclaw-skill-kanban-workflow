import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  loadSessionMap,
  saveSessionMap,
  loadTrackedWorkerRunState,
  runWorkflowLoopSelection,
  runWorkflowLoopController,
} = vi.hoisted(() => ({
  loadSessionMap: vi.fn(async () => ({
    version: 1 as const,
    active: { ticketId: 'A1', sessionId: 'jules-281' },
    sessionsByTicket: {
      A1: {
        sessionId: 'jules-281',
        lastState: 'in_progress' as const,
        lastSeenAt: '2026-03-15T15:53:37.000Z',
        workStartedAt: '2026-03-15T15:53:37.000Z',
      },
    },
  })),
  saveSessionMap: vi.fn(async () => undefined),
  loadTrackedWorkerRunState: vi.fn(async () => ({
    kind: 'completed',
    workerOutput: JSON.stringify({
      decision: 'completed',
      completed_steps: ['Implemented the fix and verified the workflow behavior.'],
      clarification_questions: [],
      blocker_resolve_requests: [],
      solution_summary: 'The background worker completed successfully and the ticket is ready for review.',
      evidence: ['npm test passed for the relevant workflow suites.'],
    }),
    raw: '{}',
    meta: {
      ticketId: 'A1',
      dispatchRunId: 'dispatch-1',
      sessionId: 'jules-281',
      agentId: 'kanban-workflow-worker',
      thinking: 'high',
      startedAt: '2026-03-15T15:53:37.000Z',
      runId: 'run-281',
      sessionKey: 'agent:kanban-workflow-worker:jules-281',
      runTimeoutSeconds: 3600,
    },
    routing: { sessionKey: 'agent:kanban-workflow-worker:jules-281', sessionId: 'jules-281' },
  })),
  runWorkflowLoopSelection: vi.fn(async () => ({
    tick: { kind: 'started' as const, id: 'B1', reasonCode: 'start_next_assigned_backlog' },
    nextTicket: {
      item: {
        id: 'B1',
        title: 'Next ticket',
      },
      comments: [],
    },
    dryRun: false,
  })),
  runWorkflowLoopController: vi.fn(async () => ({
    quiet: false as const,
    exitCode: 0,
    payload: {
      workflowLoop: {
        dryRun: false,
        dispatchRunId: 'dispatch-2:handoff',
        actions: [],
        execution: [],
        noWorkAlert: null,
        queuePositionUpdate: null,
        rocketChatStatusUpdate: null,
        activeTicketId: 'B1',
        mapPath: '.tmp/kwf-session-map.json',
      },
      autopilot: {
        tick: { kind: 'started' as const, id: 'B1', reasonCode: 'start_next_assigned_backlog' },
        nextTicket: {
          item: { id: 'B1', title: 'Next ticket' },
          comments: [],
        },
        dryRun: false,
      },
    },
  })),
}));

vi.mock('../src/automation/session_dispatcher.js', async () => {
  const actual = await vi.importActual<typeof import('../src/automation/session_dispatcher.js')>('../src/automation/session_dispatcher.js');
  return {
    ...actual,
    loadSessionMap,
    saveSessionMap,
  };
});

vi.mock('../src/workflow/worker_runtime.js', async () => {
  const actual = await vi.importActual<typeof import('../src/workflow/worker_runtime.js')>('../src/workflow/worker_runtime.js');
  return {
    ...actual,
    loadTrackedWorkerRunState,
  };
});

vi.mock('../src/workflow/workflow_loop_selection.js', () => ({
  runWorkflowLoopSelection,
}));

vi.mock('../src/workflow/workflow_loop_controller.js', () => ({
  runWorkflowLoopController,
}));

import { runDelegationReconciler } from '../src/workflow/delegation_reconciler.js';

describe('delegation_reconciler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies a completed delegation immediately, persists the completed session state, and starts the next ticket handoff', async () => {
    const adapter = {
      getWorkItem: vi.fn(async () => ({ id: 'A1', projectId: 'P1' })),
      addComment: vi.fn(async () => undefined),
      setStage: vi.fn(async () => undefined),
    };

    const result = await runDelegationReconciler({
      adapter,
      ticketId: 'A1',
      sessionId: 'jules-281',
      dispatchRunId: 'dispatch-2',
      workerAgentId: 'kanban-workflow-worker',
      workerRuntimeOptions: {
        delegationDir: '.tmp/test-delegations',
        defaultSyncTimeoutMs: 30_000,
        defaultBackgroundTimeoutMs: 60_000,
        isBackgroundDelegationAllowed: () => false,
      },
    });

    expect(result.quiet).toBe(false);
    if (result.quiet) return;
    expect(adapter.addComment).toHaveBeenCalledOnce();
    const addCommentCalls = adapter.addComment.mock.calls as unknown as Array<[string, string]>;
    expect(addCommentCalls[0]?.[1]).toContain('Worker decision: completed');
    expect(adapter.setStage).toHaveBeenCalledWith('A1', 'stage:in-review');
    expect(saveSessionMap.mock.calls.length).toBeGreaterThanOrEqual(1);
    const persistedMap = ((saveSessionMap.mock.calls as unknown as Array<[any]>).at(-1)?.[0]);
    expect(persistedMap).toBeTruthy();
    expect(persistedMap.active).toBeUndefined();
    expect(persistedMap.sessionsByTicket.A1.lastState).toBe('completed');
    expect(result.payload.delegationReconcile.execution.detail).toContain('source=background-delegation-event');
    expect(runWorkflowLoopSelection).toHaveBeenCalledTimes(1);
    expect(runWorkflowLoopController).toHaveBeenCalledTimes(1);
    expect(result.payload.delegationReconcile.handoff).not.toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  loadSessionMap,
  saveSessionMap,
  loadWorkerDelegationState,
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
  loadWorkerDelegationState: vi.fn(async () => ({
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
      syncTimeoutMs: 30000,
      backgroundTimeoutMs: 60000,
    },
    routing: { sessionKey: 'agent:kanban-workflow-worker:jules-281', sessionId: 'jules-281' },
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
    loadWorkerDelegationState,
  };
});

import { runDelegationReconciler } from '../src/workflow/delegation_reconciler.js';

describe('delegation_reconciler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies a completed delegation immediately and persists the completed session state', async () => {
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
    expect(saveSessionMap).toHaveBeenCalledOnce();
    const persistedMap = ((saveSessionMap.mock.calls as unknown as Array<[any]>)[0]?.[0]);
    expect(persistedMap).toBeTruthy();
    expect(persistedMap.active).toBeUndefined();
    expect(persistedMap.sessionsByTicket.A1.lastState).toBe('completed');
    expect(result.payload.delegationReconcile.execution.detail).toContain('source=background-delegation-event');
  });
});

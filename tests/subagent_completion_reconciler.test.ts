import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  loadSessionMap,
  runDelegationReconciler,
} = vi.hoisted(() => ({
  loadSessionMap: vi.fn(async () => ({
    version: 1 as const,
    sessionsByTicket: {
      A1: {
        sessionId: 'jules-296',
        lastState: 'in_progress' as const,
        lastSeenAt: '2026-03-15T20:00:00.000Z',
        activeRun: {
          runId: 'run-296',
          status: 'started' as const,
          sentAt: '2026-03-15T20:00:00.000Z',
          waitTimeoutSeconds: 3600,
          sessionKey: 'agent:kanban-workflow-worker:subagent:child-296',
        },
      },
    },
  })),
  runDelegationReconciler: vi.fn(async () => ({
    quiet: false as const,
    exitCode: 0,
    payload: {
      delegationReconcile: {
        ticketId: 'A1',
        sessionId: 'jules-296',
        execution: {
          sessionId: 'jules-296',
          ticketId: 'A1',
          parsed: { kind: 'completed', result: 'ok' },
          workerOutput: '{}',
          outcome: 'applied',
        },
        handoff: null,
        mapPath: '.tmp/kwf-session-map.json',
      },
    },
  })),
}));

vi.mock('../src/automation/session_dispatcher.js', async () => {
  const actual = await vi.importActual<typeof import('../src/automation/session_dispatcher.js')>('../src/automation/session_dispatcher.js');
  return {
    ...actual,
    loadSessionMap,
  };
});

vi.mock('../src/workflow/delegation_reconciler.js', () => ({
  runDelegationReconciler,
}));

import { findTicketByChildSessionKey, runSubagentCompletionReconciler } from '../src/workflow/subagent_completion_reconciler.js';

describe('subagent_completion_reconciler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('finds the active ticket that owns a child session key', async () => {
    const map = await loadSessionMap();
    expect(findTicketByChildSessionKey(map, 'agent:kanban-workflow-worker:subagent:child-296')).toEqual({
      ticketId: 'A1',
      sessionId: 'jules-296',
    });
  });

  it('routes worker child-session completions into delegation reconciliation', async () => {
    const adapter = { setStage: vi.fn(), addComment: vi.fn() };
    const result = await runSubagentCompletionReconciler({
      adapter: adapter as any,
      childSessionKey: 'agent:kanban-workflow-worker:subagent:child-296',
      dispatchRunId: 'dispatch-296',
      workerAgentId: 'kanban-workflow-worker',
      workerRuntimeOptions: {
        delegationDir: '.tmp/test-delegations',
        defaultSyncTimeoutMs: 30_000,
        defaultBackgroundTimeoutMs: 60_000,
        requesterSessionKey: 'agent:kanban-workflow-workflow-loop:main',
        isBackgroundDelegationAllowed: () => false,
      },
    });

    expect(result.quiet).toBe(false);
    expect(runDelegationReconciler).toHaveBeenCalledOnce();
    expect((runDelegationReconciler.mock.calls as unknown as Array<[any]>)[0]?.[0]).toMatchObject({
      ticketId: 'A1',
      sessionId: 'jules-296',
      workerAgentId: 'kanban-workflow-worker',
    });
  });

  it('ignores unrelated non-worker subagent sessions', async () => {
    const result = await runSubagentCompletionReconciler({
      adapter: {} as any,
      childSessionKey: 'agent:main:subagent:child-1',
      dispatchRunId: 'dispatch-x',
      workerAgentId: 'kanban-workflow-worker',
      workerRuntimeOptions: {
        delegationDir: '.tmp/test-delegations',
        defaultSyncTimeoutMs: 30_000,
        defaultBackgroundTimeoutMs: 60_000,
        requesterSessionKey: 'agent:kanban-workflow-workflow-loop:main',
        isBackgroundDelegationAllowed: () => false,
      },
    });

    expect(result).toEqual({ quiet: true, exitCode: 0, reason: 'not_worker_subagent' });
    expect(runDelegationReconciler).not.toHaveBeenCalled();
  });
});

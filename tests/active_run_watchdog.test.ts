import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  loadSessionMap,
  saveSessionMap,
} = vi.hoisted(() => ({
  loadSessionMap: vi.fn(),
  saveSessionMap: vi.fn(),
}));

const {
  loadTrackedWorkerRunState,
} = vi.hoisted(() => ({
  loadTrackedWorkerRunState: vi.fn(),
}));

const {
  runDelegationReconciler,
} = vi.hoisted(() => ({
  runDelegationReconciler: vi.fn(),
}));

const {
  maybeSendFakeWipAlert,
} = vi.hoisted(() => ({
  maybeSendFakeWipAlert: vi.fn(async () => ({ sent: false, message: 'disabled' })),
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

vi.mock('../src/workflow/delegation_reconciler.js', () => ({
  runDelegationReconciler,
}));

vi.mock('../src/workflow/fake_wip_alert.js', () => ({
  maybeSendFakeWipAlert,
}));

import { runActiveRunWatchdog } from '../src/workflow/active_run_watchdog.js';

describe('active_run_watchdog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reconciles completed started runs when the completion hook was missed', async () => {
    loadSessionMap.mockResolvedValue({
      version: 1 as const,
      sessionsByTicket: {
        A1: {
          sessionId: 'jules-300',
          lastState: 'in_progress' as const,
          lastSeenAt: '2026-03-15T21:00:00.000Z',
          activeRun: {
            requestId: 'req-300',
            runId: 'run-300',
            status: 'started' as const,
            sentAt: '2026-03-15T21:00:00.000Z',
            waitTimeoutSeconds: 3600,
            sessionKey: 'agent:main:subagent:child-300',
          },
        },
      },
    });
    loadTrackedWorkerRunState.mockResolvedValue({
      kind: 'completed',
      meta: {
        ticketId: 'A1',
        dispatchRunId: 'spawn',
        sessionId: 'jules-300',
        agentId: 'main',
        thinking: 'high',
        startedAt: '2026-03-15T21:00:00.000Z',
        runId: 'run-300',
        sessionKey: 'agent:main:subagent:child-300',
        runTimeoutSeconds: 3600,
      },
      workerOutput: '{"decision":"completed"}',
      raw: '{"decision":"completed"}',
      routing: {
        sessionKey: 'agent:main:subagent:child-300',
      },
    });
    runDelegationReconciler.mockResolvedValue({
      quiet: false,
      exitCode: 0,
      payload: { delegationReconcile: { ticketId: 'A1', sessionId: 'jules-300' } },
    });

    const result = await runActiveRunWatchdog({
      adapter: {} as any,
      dispatchRunId: 'dispatch-watchdog',
      workerAgentId: 'main',
      workerRuntimeOptions: {
        delegationDir: '.tmp/test-delegations',
        defaultSyncTimeoutMs: 30_000,
        defaultBackgroundTimeoutMs: 60_000,
        requesterSessionKey: 'agent:kanban-workflow-workflow-loop:kwf-control',
        isBackgroundDelegationAllowed: () => false,
      },
    });

    expect(result.scanned).toBe(1);
    expect(result.reconciled).toHaveLength(1);
    expect(runDelegationReconciler).toHaveBeenCalledOnce();
  });

  it('flags stale spawn requests and stale started runs', async () => {
    loadSessionMap.mockResolvedValue({
      version: 1 as const,
      sessionsByTicket: {
        A1: {
          sessionId: 'jules-301',
          lastState: 'in_progress' as const,
          lastSeenAt: '2026-03-15T20:00:00.000Z',
          activeRun: {
            requestId: 'req-301',
            status: 'spawn_requested' as const,
            sentAt: '2026-03-15T20:00:00.000Z',
            waitTimeoutSeconds: 3600,
          },
        },
        A2: {
          sessionId: 'jules-302',
          lastState: 'in_progress' as const,
          lastSeenAt: '2026-03-15T19:00:00.000Z',
          activeRun: {
            requestId: 'req-302',
            runId: 'run-302',
            status: 'started' as const,
            sentAt: '2026-03-15T19:00:00.000Z',
            waitTimeoutSeconds: 3600,
            sessionKey: 'agent:main:subagent:child-302',
          },
        },
      },
    });
    loadTrackedWorkerRunState.mockResolvedValue({
      kind: 'running',
      meta: {
        ticketId: 'A2',
        dispatchRunId: 'spawn',
        sessionId: 'jules-302',
        agentId: 'main',
        thinking: 'high',
        startedAt: '2026-03-15T19:00:00.000Z',
        runId: 'run-302',
        sessionKey: 'agent:main:subagent:child-302',
        runTimeoutSeconds: 3600,
      },
    });

    const result = await runActiveRunWatchdog({
      adapter: {} as any,
      dispatchRunId: 'dispatch-watchdog',
      workerAgentId: 'main',
      workerRuntimeOptions: {
        delegationDir: '.tmp/test-delegations',
        defaultSyncTimeoutMs: 30_000,
        defaultBackgroundTimeoutMs: 60_000,
        requesterSessionKey: 'agent:kanban-workflow-workflow-loop:kwf-control',
        isBackgroundDelegationAllowed: () => false,
      },
      now: new Date('2026-03-15T21:30:00.000Z'),
      requestedStaleAfterSeconds: 60,
      runningStaleGraceSeconds: 60,
      remediateStaleRequested: false,
      remediateStaleRunning: false,
    });

    expect(result.staleRequested).toEqual([
      expect.objectContaining({ ticketId: 'A1', sessionId: 'jules-301', requestId: 'req-301', remediated: false }),
    ]);
    expect(result.staleRunning).toEqual([
      expect.objectContaining({ ticketId: 'A2', sessionId: 'jules-302', runId: 'run-302' }),
    ]);
  });

  it('remediates stale spawn requests by requeueing and clearing local active state', async () => {
    loadSessionMap.mockResolvedValue({
      version: 1 as const,
      active: {
        ticketId: 'A1',
        sessionId: 'jules-301',
      },
      sessionsByTicket: {
        A1: {
          sessionId: 'jules-301',
          lastState: 'reserved' as const,
          lastSeenAt: '2026-03-15T20:00:00.000Z',
          activeRun: {
            requestId: 'req-301',
            status: 'spawn_requested' as const,
            sentAt: '2026-03-15T20:00:00.000Z',
            waitTimeoutSeconds: 3600,
          },
        },
      },
    });

    const adapter = {
      getWorkItem: vi.fn(async () => ({ stage: 'stage:in-progress' })),
      setStage: vi.fn(async () => undefined),
    };

    const result = await runActiveRunWatchdog({
      adapter: adapter as any,
      dispatchRunId: 'dispatch-watchdog',
      workerAgentId: 'main',
      workerRuntimeOptions: {
        delegationDir: '.tmp/test-delegations',
        defaultSyncTimeoutMs: 30_000,
        defaultBackgroundTimeoutMs: 60_000,
        requesterSessionKey: 'agent:kanban-workflow-workflow-loop:kwf-control',
        isBackgroundDelegationAllowed: () => false,
      },
      now: new Date('2026-03-15T21:30:00.000Z'),
      requestedStaleAfterSeconds: 60,
    });

    expect(adapter.setStage).toHaveBeenCalledWith('A1', 'stage:todo');
    expect(saveSessionMap).toHaveBeenCalledOnce();
    expect(result.staleRequested).toEqual([
      expect.objectContaining({
        ticketId: 'A1',
        requestId: 'req-301',
        remediated: true,
        stageBefore: 'stage:in-progress',
        stageAfter: 'stage:todo',
      }),
    ]);
  });

  it('remediates stale started runs by requeueing in-progress tickets and clearing local active state', async () => {
    loadSessionMap.mockResolvedValue({
      version: 1 as const,
      active: {
        ticketId: 'A2',
        sessionId: 'jules-302',
      },
      sessionsByTicket: {
        A2: {
          sessionId: 'jules-302',
          lastState: 'in_progress' as const,
          lastSeenAt: '2026-03-15T19:00:00.000Z',
          workStartedAt: '2026-03-15T19:00:00.000Z',
          activeRun: {
            requestId: 'req-302',
            runId: 'run-302',
            status: 'started' as const,
            sentAt: '2026-03-15T19:00:00.000Z',
            waitTimeoutSeconds: 3600,
            sessionKey: 'agent:main:subagent:child-302',
          },
        },
      },
    });
    loadTrackedWorkerRunState.mockResolvedValue({
      kind: 'running',
      meta: {
        ticketId: 'A2',
        dispatchRunId: 'spawn',
        sessionId: 'jules-302',
        agentId: 'main',
        thinking: 'high',
        startedAt: '2026-03-15T19:00:00.000Z',
        runId: 'run-302',
        sessionKey: 'agent:main:subagent:child-302',
        runTimeoutSeconds: 3600,
      },
    });

    const adapter = {
      getWorkItem: vi.fn(async () => ({ stage: 'stage:in-progress' })),
      setStage: vi.fn(async () => undefined),
    };

    const result = await runActiveRunWatchdog({
      adapter: adapter as any,
      dispatchRunId: 'dispatch-watchdog',
      workerAgentId: 'main',
      workerRuntimeOptions: {
        delegationDir: '.tmp/test-delegations',
        defaultSyncTimeoutMs: 30_000,
        defaultBackgroundTimeoutMs: 60_000,
        requesterSessionKey: 'agent:kanban-workflow-workflow-loop:kwf-control',
        isBackgroundDelegationAllowed: () => false,
      },
      now: new Date('2026-03-15T20:03:00.000Z'),
      runningStaleGraceSeconds: 60,
    });

    expect(adapter.setStage).toHaveBeenCalledWith('A2', 'stage:todo');
    expect(saveSessionMap).toHaveBeenCalledOnce();
    expect(result.staleRunning).toEqual([
      expect.objectContaining({
        ticketId: 'A2',
        sessionId: 'jules-302',
        runId: 'run-302',
        remediated: true,
        stageBefore: 'stage:in-progress',
        stageAfter: 'stage:todo',
      }),
    ]);
  });

  it('remediates orphaned started runs when no backing run/session can be found', async () => {
    loadSessionMap.mockResolvedValue({
      version: 1 as const,
      active: {
        ticketId: 'A9',
        sessionId: 'jules-309',
      },
      sessionsByTicket: {
        A9: {
          sessionId: 'jules-309',
          lastState: 'in_progress' as const,
          lastSeenAt: '2026-03-15T19:00:00.000Z',
          workStartedAt: '2026-03-15T19:00:00.000Z',
          activeRun: {
            requestId: 'req-309',
            runId: 'run-309',
            status: 'started' as const,
            sentAt: '2026-03-15T19:00:00.000Z',
            waitTimeoutSeconds: 3600,
            sessionKey: 'agent:main:subagent:child-309',
          },
        },
      },
    });
    loadTrackedWorkerRunState.mockResolvedValue({ kind: 'none' });

    const adapter = {
      getWorkItem: vi.fn(async () => ({ stage: 'stage:in-progress' })),
      setStage: vi.fn(async () => undefined),
    };

    const result = await runActiveRunWatchdog({
      adapter: adapter as any,
      dispatchRunId: 'dispatch-watchdog',
      workerAgentId: 'main',
      workerRuntimeOptions: {
        delegationDir: '.tmp/test-delegations',
        defaultSyncTimeoutMs: 30_000,
        defaultBackgroundTimeoutMs: 60_000,
        requesterSessionKey: 'agent:kanban-workflow-workflow-loop:kwf-control',
        isBackgroundDelegationAllowed: () => false,
      },
    });

    expect(adapter.setStage).toHaveBeenCalledWith('A9', 'stage:todo');
    expect(saveSessionMap).toHaveBeenCalledOnce();
    expect(result.orphanedRuns).toEqual([
      expect.objectContaining({
        ticketId: 'A9',
        sessionId: 'jules-309',
        runId: 'run-309',
        remediated: true,
        stageBefore: 'stage:in-progress',
        stageAfter: 'stage:todo',
      }),
    ]);
  });
});

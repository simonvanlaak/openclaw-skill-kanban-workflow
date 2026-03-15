import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/automation/auto_reopen.js', () => ({
  runAutoReopenOnHumanComment: vi.fn(async () => ({ actions: [] })),
}));

const { loadWorkerDelegationState } = vi.hoisted(() => ({
  loadWorkerDelegationState: vi.fn(async () => ({ kind: 'none' })),
}));

vi.mock('../src/workflow/worker_runtime.js', async () => {
  const actual = await vi.importActual<typeof import('../src/workflow/worker_runtime.js')>('../src/workflow/worker_runtime.js');
  return {
    ...actual,
    loadWorkerDelegationState,
  };
});

import { runWorkflowLoopSelection } from '../src/workflow/workflow_loop_selection.js';

describe('workflow_loop_selection', () => {
  it('keeps the newest self-assigned in-progress ticket and requeues extra in-progress tickets', async () => {
    const adapter = {
      whoami: vi.fn(async () => ({ id: 'me-1', username: 'kwf-bot' })),
      listIdsByStage: vi.fn(async (stage: string) => {
        if (stage === 'stage:in-progress') return ['A1', 'A2'];
        return [];
      }),
      getWorkItem: vi.fn(async (id: string) => ({
        id,
        title: id === 'A1' ? 'Older task' : 'Newest task',
        stage: 'stage:in-progress' as const,
        assignees: [{ id: 'me-1' }],
        updatedAt: new Date(id === 'A1' ? '2026-03-10T00:00:00.000Z' : '2026-03-10T01:00:00.000Z'),
        labels: [],
      })),
      setStage: vi.fn(async () => undefined),
      listBacklogIdsInOrder: vi.fn(async () => []),
      listComments: vi.fn(async () => []),
      listAttachments: vi.fn(async () => []),
      listLinkedWorkItems: vi.fn(async () => []),
      name: vi.fn(() => 'plane'),
    };

    const output = await runWorkflowLoopSelection({
      adapter,
      map: { version: 1, sessionsByTicket: {} },
      dryRun: false,
    });

    expect(output.tick).toEqual({ kind: 'in_progress', id: 'A2', inProgressIds: ['A2'] });
    expect(adapter.setStage).toHaveBeenCalledWith('A1', 'stage:todo');
  });

  it('starts the highest-priority self-assigned backlog ticket and ignores unassigned items', async () => {
    const adapter = {
      whoami: vi.fn(async () => ({ id: 'me-1', username: 'kwf-bot' })),
      listIdsByStage: vi.fn(async () => []),
      listBacklogIdsInOrder: vi.fn(async () => ['T1', 'T2']),
      getWorkItem: vi.fn(async (id: string) => ({
        id,
        title: id === 'T1' ? 'Not mine' : 'Mine',
        stage: 'stage:todo' as const,
        assignees: id === 'T1' ? [{ id: 'other' }] : [{ id: 'me-1' }],
        labels: [],
      })),
      setStage: vi.fn(async () => undefined),
      listComments: vi.fn(async () => []),
      listAttachments: vi.fn(async () => []),
      listLinkedWorkItems: vi.fn(async () => []),
      name: vi.fn(() => 'plane'),
    };

    const output = await runWorkflowLoopSelection({
      adapter,
      map: { version: 1, sessionsByTicket: {} },
      dryRun: false,
    });

    expect(output.tick).toEqual({ kind: 'started', id: 'T2', reasonCode: 'start_next_assigned_backlog' });
    expect(adapter.setStage).toHaveBeenCalledWith('T2', 'stage:in-progress');
    expect(adapter.listComments).not.toHaveBeenCalled();
    expect(adapter.listAttachments).not.toHaveBeenCalled();
    expect(adapter.listLinkedWorkItems).not.toHaveBeenCalled();
  });

  it('persists ticket reservation before moving Plane to in-progress', async () => {
    const persistMap = vi.fn(async () => undefined);
    const adapter = {
      whoami: vi.fn(async () => ({ id: 'me-1', username: 'kwf-bot' })),
      listIdsByStage: vi.fn(async () => []),
      listBacklogIdsInOrder: vi.fn(async () => ['T2']),
      getWorkItem: vi.fn(async () => ({
        id: 'T2',
        title: 'Mine',
        identifier: 'JULES-294',
        stage: 'stage:todo' as const,
        assignees: [{ id: 'me-1' }],
        labels: [],
      })),
      setStage: vi.fn(async () => {
        throw new Error('plane stage update failed');
      }),
      listComments: vi.fn(async () => []),
      listAttachments: vi.fn(async () => []),
      listLinkedWorkItems: vi.fn(async () => []),
      name: vi.fn(() => 'plane'),
    };

    const map = { version: 1 as const, sessionsByTicket: {} };
    await expect(
      runWorkflowLoopSelection({
        adapter,
        map,
        dryRun: false,
        persistMap,
      }),
    ).rejects.toThrow('plane stage update failed');

    expect(persistMap).toHaveBeenCalledTimes(1);
    const persistedMap = (persistMap.mock.calls[0] as any)?.[0];
    expect(persistedMap?.active).toEqual({ ticketId: 'T2', sessionId: 'jules-294' });
    expect(persistedMap?.sessionsByTicket?.T2?.lastState).toBe('reserved');
    expect(persistedMap?.sessionsByTicket?.T2?.pendingMutation).toMatchObject({
      kind: 'ticket_reservation',
      targetStage: 'stage:in-progress',
    });
  });

  it('replays a pending ticket reservation without creating a new session', async () => {
    const persistMap = vi.fn(async () => undefined);
    const adapter = {
      whoami: vi.fn(async () => ({ id: 'me-1', username: 'kwf-bot' })),
      listIdsByStage: vi.fn(async () => []),
      listBacklogIdsInOrder: vi.fn(async () => ['T2']),
      getWorkItem: vi.fn(async () => ({
        id: 'T2',
        title: 'Mine',
        identifier: 'JULES-294',
        stage: 'stage:todo' as const,
        assignees: [{ id: 'me-1' }],
        labels: [],
      })),
      setStage: vi.fn(async () => undefined),
      listComments: vi.fn(async () => []),
      listAttachments: vi.fn(async () => []),
      listLinkedWorkItems: vi.fn(async () => []),
      name: vi.fn(() => 'plane'),
    };

    const map = {
      version: 1 as const,
      active: { ticketId: 'T2', sessionId: 'jules-294' },
      sessionsByTicket: {
        T2: {
          sessionId: 'jules-294',
          sessionLabel: 'JULES-294 Mine',
          lastState: 'reserved' as const,
          lastSeenAt: '2026-03-15T17:30:00.000Z',
          workStartedAt: '2026-03-15T17:30:00.000Z',
          pendingMutation: {
            kind: 'ticket_reservation' as const,
            targetStage: 'stage:in-progress' as const,
            createdAt: '2026-03-15T17:30:00.000Z',
          },
        },
      },
    };

    const output = await runWorkflowLoopSelection({
      adapter,
      map,
      dryRun: false,
      persistMap,
    });

    expect(output.tick).toEqual({ kind: 'started', id: 'T2', reasonCode: 'start_next_assigned_backlog' });
    expect(adapter.setStage).toHaveBeenCalledTimes(1);
    expect(adapter.setStage).toHaveBeenCalledWith('T2', 'stage:in-progress');
    expect(map.sessionsByTicket.T2.sessionId).toBe('jules-294');
    expect(persistMap).toHaveBeenCalledTimes(1);
    expect(map.sessionsByTicket.T2.pendingMutation).toMatchObject({
      kind: 'ticket_reservation',
      targetStage: 'stage:in-progress',
    });
  });

  it('fast-paths active tickets with completed/running delegation and skips heavy context reload', async () => {
    loadWorkerDelegationState.mockResolvedValueOnce({ kind: 'completed', workerOutput: '{}', raw: '{}', meta: {} } as any);

    const adapter = {
      whoami: vi.fn(async () => ({ id: 'me-1', username: 'kwf-bot' })),
      listIdsByStage: vi.fn(async (stage: string) => {
        if (stage === 'stage:in-progress') return ['A2'];
        return [];
      }),
      getWorkItem: vi.fn(async () => ({
        id: 'A2',
        title: 'Current task',
        stage: 'stage:in-progress' as const,
        assignees: [{ id: 'me-1' }],
        updatedAt: new Date('2026-03-10T01:00:00.000Z'),
        labels: [],
      })),
      setStage: vi.fn(async () => undefined),
      listBacklogIdsInOrder: vi.fn(async () => []),
      listComments: vi.fn(async () => []),
      listAttachments: vi.fn(async () => []),
      listLinkedWorkItems: vi.fn(async () => []),
      name: vi.fn(() => 'plane'),
    };

    const output = await runWorkflowLoopSelection({
      adapter,
      map: {
        version: 1,
        active: { ticketId: 'A2', sessionId: 'jules-281' },
        sessionsByTicket: {
          A2: {
            sessionId: 'jules-281',
            lastState: 'in_progress',
            lastSeenAt: '2026-03-10T01:00:00.000Z',
          },
        },
      },
      dryRun: false,
      workerRuntimeOptions: {
        delegationDir: '.tmp/test-delegations',
        defaultSyncTimeoutMs: 30_000,
        defaultBackgroundTimeoutMs: 60_000,
        isBackgroundDelegationAllowed: () => false,
      },
    });

    expect(output.tick).toEqual({ kind: 'in_progress', id: 'A2', inProgressIds: ['A2'] });
    expect(loadWorkerDelegationState).toHaveBeenCalledWith('jules-281', 'A2', expect.any(Object));
    expect(adapter.listComments).not.toHaveBeenCalled();
    expect(adapter.listAttachments).not.toHaveBeenCalled();
    expect(adapter.listLinkedWorkItems).not.toHaveBeenCalled();
  });

  it('normalizes a completed reservation to in-progress before continuing an active ticket', async () => {
    const persistMap = vi.fn(async () => undefined);
    const adapter = {
      whoami: vi.fn(async () => ({ id: 'me-1', username: 'kwf-bot' })),
      listIdsByStage: vi.fn(async (stage: string) => {
        if (stage === 'stage:in-progress') return ['A2'];
        return [];
      }),
      getWorkItem: vi.fn(async () => ({
        id: 'A2',
        title: 'Current task',
        stage: 'stage:in-progress' as const,
        assignees: [{ id: 'me-1' }],
        updatedAt: new Date('2026-03-10T01:00:00.000Z'),
        labels: [],
      })),
      setStage: vi.fn(async () => undefined),
      listBacklogIdsInOrder: vi.fn(async () => []),
      listComments: vi.fn(async () => []),
      listAttachments: vi.fn(async () => []),
      listLinkedWorkItems: vi.fn(async () => []),
      name: vi.fn(() => 'plane'),
    };

    const map = {
      version: 1 as const,
      active: { ticketId: 'A2', sessionId: 'jules-294' },
      sessionsByTicket: {
        A2: {
          sessionId: 'jules-294',
          sessionLabel: 'JULES-294 Current task',
          lastState: 'reserved' as const,
          lastSeenAt: '2026-03-10T01:00:00.000Z',
          workStartedAt: '2026-03-10T01:00:00.000Z',
          pendingMutation: {
            kind: 'ticket_reservation' as const,
            targetStage: 'stage:in-progress' as const,
            createdAt: '2026-03-10T01:00:00.000Z',
            stageAppliedAt: '2026-03-10T01:00:01.000Z',
          },
        },
      },
    };

    const output = await runWorkflowLoopSelection({
      adapter,
      map,
      dryRun: false,
      persistMap,
      workerRuntimeOptions: {
        delegationDir: '.tmp/test-delegations',
        defaultSyncTimeoutMs: 30_000,
        defaultBackgroundTimeoutMs: 60_000,
        isBackgroundDelegationAllowed: () => false,
      },
    });

    expect(output.tick).toEqual({ kind: 'in_progress', id: 'A2', inProgressIds: ['A2'] });
    expect(map.sessionsByTicket.A2.lastState).toBe('in_progress');
    expect(map.sessionsByTicket.A2.pendingMutation).toBeUndefined();
    expect(persistMap).toHaveBeenCalledTimes(1);
    expect(adapter.listComments).not.toHaveBeenCalled();
    expect(adapter.listAttachments).not.toHaveBeenCalled();
    expect(adapter.listLinkedWorkItems).not.toHaveBeenCalled();
  });
});

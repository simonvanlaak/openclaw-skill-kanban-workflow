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
        stage: 'stage:in-progress',
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
        stage: 'stage:todo',
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
        stage: 'stage:in-progress',
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
});

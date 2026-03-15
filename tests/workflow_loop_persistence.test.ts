import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  saveSessionMap,
  loadSessionMap,
  dispatchWorkerTurn,
} = vi.hoisted(() => ({
  saveSessionMap: vi.fn(async () => undefined),
  loadSessionMap: vi.fn(async () => ({ version: 1, sessionsByTicket: {} })),
  dispatchWorkerTurn: vi.fn(async () => {
    throw new Error('gateway unavailable');
  }),
}));

vi.mock('../src/config.js', () => ({
  loadConfigFromFile: vi.fn(async () => ({
    version: 1,
    autopilot: { requeueTargetStage: 'stage:todo' },
    adapter: {
      kind: 'plane',
      workspaceSlug: 'ws',
      projectIds: ['p1'],
      stageMap: {
        Todo: 'stage:todo',
        Blocked: 'stage:blocked',
        'In Progress': 'stage:in-progress',
        'In Review': 'stage:in-review',
      },
    },
  })),
}));

vi.mock('../src/adapters/plane.js', () => ({
  PlaneAdapter: vi.fn().mockImplementation(() => ({
    name: () => 'plane',
    whoami: vi.fn(async () => ({ id: 'me-1', username: 'me' })),
    listIdsByStage: vi.fn(async () => []),
    listBacklogIdsInOrder: vi.fn(async () => ['A1']),
    getWorkItem: vi.fn(async () => ({
      id: 'A1',
      title: 'Investigate flaky worker handoff',
      stage: 'stage:todo',
      labels: [],
      assignees: [{ id: 'me-1' }],
    })),
    listComments: vi.fn(async () => []),
    listAttachments: vi.fn(async () => []),
    listLinkedWorkItems: vi.fn(async () => []),
    setStage: vi.fn(async () => undefined),
    addComment: vi.fn(async () => undefined),
    updateComment: vi.fn(async () => undefined),
    deleteComment: vi.fn(async () => undefined),
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
    dispatchWorkerTurn,
    loadWorkerDelegationState: vi.fn(async () => ({ kind: 'none' })),
  };
});

vi.mock('../src/workflow/no_work_alert.js', () => ({
  maybeSendNoWorkFirstHitAlert: vi.fn(async () => null),
}));

vi.mock('../src/workflow/rocketchat_status.js', () => ({
  maybeUpdateRocketChatStatusFromWorkflowLoop: vi.fn(async () => null),
}));

vi.mock('../src/workflow/queue_position_comments.js', () => ({
  reconcileQueuePositionComments: vi.fn(async () => ({
    outcome: 'applied',
    queuedTickets: 0,
    activeOffset: 0,
    created: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    errors: [],
  })),
}));

import { runCli } from '../src/cli.js';

function createIo(): { io: any; cap: { out: string[]; err: string[] } } {
  const cap = { out: [] as string[], err: [] as string[] };
  return {
    cap,
    io: {
      stdout: { write: (chunk: string) => cap.out.push(chunk) },
      stderr: { write: (chunk: string) => cap.err.push(chunk) },
    },
  };
}

describe('workflow-loop reservation persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadSessionMap.mockResolvedValue({ version: 1, sessionsByTicket: {} });
    saveSessionMap.mockResolvedValue(undefined);
    dispatchWorkerTurn.mockRejectedValue(new Error('gateway unavailable'));
  });

  it('persists the reserved active ticket before worker dispatch so the loop can recover', async () => {
    const { io, cap } = createIo();

    const code = await runCli(['workflow-loop'], io);

    expect(code).toBe(1);
    expect(cap.err.join('')).toContain('gateway unavailable');
    expect(saveSessionMap.mock.calls.length).toBeGreaterThanOrEqual(1);
    const persistedMap = (saveSessionMap.mock.calls[0] as any)?.[0];
    expect(persistedMap?.active).toEqual({ ticketId: 'A1', sessionId: 'a1' });
    expect(persistedMap?.sessionsByTicket?.A1?.lastState).toBe('reserved');
    expect(persistedMap?.sessionsByTicket?.A1?.pendingMutation).toMatchObject({
      kind: 'ticket_reservation',
      targetStage: 'stage:in-progress',
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runDelegationReconciler } = vi.hoisted(() => ({
  runDelegationReconciler: vi.fn(async () => ({
    quiet: false,
    exitCode: 0,
    payload: {
      delegationReconcile: {
        ticketId: 'A1',
        sessionId: 'jules-281',
        execution: {
          sessionId: 'jules-281',
          ticketId: 'A1',
          parsed: { kind: 'completed', result: 'Worker decision: completed' },
          workerOutput: '{}',
          outcome: 'applied',
        },
        mapPath: '.tmp/kwf-session-map.json',
      },
    },
  })),
}));

vi.mock('../src/setup.js', () => ({
  runSetup: vi.fn(async () => undefined),
}));

vi.mock('../src/config.js', () => ({
  loadConfigFromFile: vi.fn(async () => ({
    version: 1,
    adapter: { kind: 'plane', workspaceSlug: 'ws', projectIds: ['p1'], stageMap: {} },
  })),
}));

vi.mock('../src/adapters/plane.js', () => ({
  PlaneAdapter: vi.fn().mockImplementation(() => ({
    name: () => 'plane',
  })),
}));

vi.mock('../src/workflow/delegation_reconciler.js', () => ({
  runDelegationReconciler,
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

describe('reconcile-delegation cli', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes the command to the delegation reconciler with the requested ticket and session ids', async () => {
    const { io, cap } = createIo();

    const code = await runCli(['reconcile-delegation', '--ticket-id', 'A1', '--session-id', 'jules-281'], io);

    expect(code).toBe(0);
    expect(runDelegationReconciler).toHaveBeenCalledOnce();
    const reconcileArgs = ((runDelegationReconciler.mock.calls as unknown as Array<[any]>)[0]?.[0]);
    expect(reconcileArgs).toMatchObject({
      ticketId: 'A1',
      sessionId: 'jules-281',
      workerAgentId: 'kanban-workflow-worker',
    });
    expect(cap.out.join('')).toContain('"delegationReconcile"');
  });
});

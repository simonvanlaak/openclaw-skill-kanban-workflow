import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runSubagentCompletionReconciler } = vi.hoisted(() => ({
  runSubagentCompletionReconciler: vi.fn(async () => ({
    quiet: false,
    exitCode: 0,
    payload: {
      subagentCompletionReconcile: {
        childSessionKey: 'agent:kanban-workflow-worker:subagent:child-296',
        ticketId: 'A1',
        sessionId: 'jules-296',
        delegation: {
          quiet: false,
          exitCode: 0,
          payload: {
            delegationReconcile: {
              ticketId: 'A1',
              sessionId: 'jules-296',
              execution: { outcome: 'applied' },
              handoff: null,
              mapPath: '.tmp/kwf-session-map.json',
            },
          },
        },
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

vi.mock('../src/workflow/subagent_completion_reconciler.js', () => ({
  runSubagentCompletionReconciler,
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

describe('reconcile-subagent-ended cli', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes the command to the subagent completion reconciler', async () => {
    const { io, cap } = createIo();

    const code = await runCli(
      ['reconcile-subagent-ended', '--child-session-key', 'agent:kanban-workflow-worker:subagent:child-296'],
      io,
    );

    expect(code).toBe(0);
    expect(runSubagentCompletionReconciler).toHaveBeenCalledOnce();
    expect((runSubagentCompletionReconciler.mock.calls as unknown as Array<[any]>)[0]?.[0]).toMatchObject({
      childSessionKey: 'agent:kanban-workflow-worker:subagent:child-296',
      workerAgentId: 'kanban-workflow-worker',
    });
    expect(cap.out.join('')).toContain('"subagentCompletionReconcile"');
  });
});

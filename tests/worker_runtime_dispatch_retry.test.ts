import { afterEach, describe, expect, it, vi } from 'vitest';

const workerRuntimeOpts = (delegationDir: string) => ({
  delegationDir,
  defaultSyncTimeoutMs: 30_000,
  defaultBackgroundTimeoutMs: 15 * 60_000,
  isBackgroundDelegationAllowed: () => false,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.KWF_WORKER_SEND_MAX_ATTEMPTS;
  delete process.env.KWF_WORKER_SEND_RETRY_DELAY_MS;
});

describe('worker runtime dispatch retries', () => {
  it('retries transient gateway close errors before starting an asynchronous worker run', async () => {
    process.env.KWF_WORKER_SEND_MAX_ATTEMPTS = '2';
    process.env.KWF_WORKER_SEND_RETRY_DELAY_MS = '1';

    const execaMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('Gateway call failed: Error: gateway closed (1000 normal closure): no close reason'))
      .mockResolvedValueOnce({ stdout: '{"runId":"retry-send","status":"started"}' })
      .mockResolvedValueOnce({ stdout: '' });

    vi.doMock('execa', () => ({ execa: execaMock }));
    const { dispatchWorkerTurn } = await import('../src/workflow/worker_runtime.js');

    await expect(
      dispatchWorkerTurn(
        {
          ticketId: 'ticket-1',
          dispatchRunId: 'dispatch-1',
          agentId: 'kanban-workflow-worker',
          sessionId: 'jules-267',
          text: 'do the work',
          thinking: 'high',
        },
        workerRuntimeOpts('/tmp/kwf-test-delegation'),
      ),
    ).resolves.toMatchObject({
      kind: 'delegated',
      runId: 'retry-send',
      sessionKey: 'agent:kanban-workflow-worker:jules-267',
    });

    expect(execaMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-transient worker dispatch failures', async () => {
    process.env.KWF_WORKER_SEND_MAX_ATTEMPTS = '4';
    process.env.KWF_WORKER_SEND_RETRY_DELAY_MS = '1';

    const execaMock = vi.fn().mockRejectedValueOnce(new Error('missing scope: chat.write'));

    vi.doMock('execa', () => ({ execa: execaMock }));
    const { dispatchWorkerTurn } = await import('../src/workflow/worker_runtime.js');

    await expect(
      dispatchWorkerTurn(
        {
          ticketId: 'ticket-2',
          dispatchRunId: 'dispatch-2',
          agentId: 'kanban-workflow-worker',
          sessionId: 'jules-268',
          text: 'do the work',
          thinking: 'high',
        },
        workerRuntimeOpts('/tmp/kwf-test-delegation'),
      ),
    ).rejects.toThrow('missing scope: chat.write');

    expect(execaMock).toHaveBeenCalledTimes(1);
  });
});

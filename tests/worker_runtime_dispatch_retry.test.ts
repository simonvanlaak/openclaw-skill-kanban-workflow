import { afterEach, describe, expect, it, vi } from 'vitest';

const workerRuntimeOpts = (delegationDir: string) => ({
  delegationDir,
  defaultSyncTimeoutMs: 30_000,
  defaultBackgroundTimeoutMs: 15 * 60_000,
  isBackgroundDelegationAllowed: () => false,
  requesterSessionKey: 'agent:kanban-workflow-workflow-loop:kwf-control',
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.KWF_WORKER_SEND_MAX_ATTEMPTS;
  delete process.env.KWF_WORKER_SEND_RETRY_DELAY_MS;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_PORT;
});

describe('worker runtime dispatch retries', () => {
  it('retries transient gateway close errors before starting an asynchronous worker run', async () => {
    process.env.KWF_WORKER_SEND_MAX_ATTEMPTS = '2';
    process.env.KWF_WORKER_SEND_RETRY_DELAY_MS = '1';
    process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token';
    process.env.OPENCLAW_GATEWAY_PORT = '18789';

    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('Gateway call failed: Error: gateway closed (1000 normal closure): no close reason'))
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            ok: true,
            result: {
              details: {
                runId: 'retry-send',
                childSessionKey: 'agent:kanban-workflow-worker:subagent:retry-send',
                status: 'accepted',
              },
            },
          }),
      });

    vi.stubGlobal('fetch', fetchMock as any);
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
      requestId: expect.any(String),
      runId: 'retry-send',
      sessionKey: 'agent:kanban-workflow-worker:subagent:retry-send',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-transient worker dispatch failures', async () => {
    process.env.KWF_WORKER_SEND_MAX_ATTEMPTS = '4';
    process.env.KWF_WORKER_SEND_RETRY_DELAY_MS = '1';
    process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token';
    process.env.OPENCLAW_GATEWAY_PORT = '18789';

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      text: async () =>
        JSON.stringify({
          ok: false,
          error: {
            message: 'missing scope: sessions_spawn',
          },
        }),
    });

    vi.stubGlobal('fetch', fetchMock as any);
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
    ).rejects.toThrow('missing scope: sessions_spawn');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

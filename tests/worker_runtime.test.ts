import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildDelegationCompletionHook,
  extractCompletedAssistantReplyFromLocalSessionSince,
  extractCompletedAssistantReplySince,
  extractCompletedAssistantReplyWithLocalFallback,
  loadWorkerDelegationState,
} from '../src/workflow/worker_runtime.js';

const tempDirs: string[] = [];

const workerRuntimeOpts = (delegationDir: string) => ({
  delegationDir,
  defaultSyncTimeoutMs: 30_000,
  defaultBackgroundTimeoutMs: 15 * 60_000,
  isBackgroundDelegationAllowed: () => true,
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.OPENCLAW_HOME;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('worker runtime terminal assistant reply detection', () => {
  it('builds a delegation completion hook that triggers immediate reconciliation', () => {
    const hook = buildDelegationCompletionHook({
      ticketId: 'A1',
      sessionId: 'jules-281',
      stderrPath: '/tmp/kwf-stderr.log',
    });

    expect(hook).toContain('reconcile-delegation');
    expect(hook).toContain('--ticket-id');
    expect(hook).toContain("'A1'");
    expect(hook).toContain('--session-id');
    expect(hook).toContain("'jules-281'");
  });

  it('waits for a terminal assistant message instead of returning an earlier progress note', () => {
    const history = {
      sessionId: 'agent:kanban-workflow-worker:JULES-274',
      messages: [
        {
          role: 'assistant',
          timestamp: 110,
          stopReason: 'endTurn',
          content: [{ type: 'text', text: 'I am digging into the logs now.' }],
        },
        {
          role: 'assistant',
          timestamp: 120,
          stopReason: 'toolUse',
          content: [{ type: 'toolCall', name: 'exec' }],
        },
        {
          role: 'toolResult',
          timestamp: 121,
          content: [{ type: 'text', text: 'grep output' }],
        },
      ],
    };

    expect(extractCompletedAssistantReplySince(history, 100)).toBeNull();
  });

  it('returns the final assistant text after tool work completes', () => {
    const history = {
      sessionId: 'agent:kanban-workflow-worker:JULES-274',
      messages: [
        {
          role: 'assistant',
          timestamp: 110,
          stopReason: 'endTurn',
          content: [{ type: 'text', text: 'I am digging into the logs now.' }],
        },
        {
          role: 'assistant',
          timestamp: 120,
          stopReason: 'toolUse',
          content: [{ type: 'toolCall', name: 'exec' }],
        },
        {
          role: 'toolResult',
          timestamp: 121,
          content: [{ type: 'text', text: 'grep output' }],
        },
        {
          role: 'assistant',
          timestamp: 130,
          stopReason: 'endTurn',
          content: [{ type: 'text', text: '{"decision":"completed"}' }],
        },
      ],
    };

    expect(extractCompletedAssistantReplySince(history, 100)).toEqual({
      text: '{"decision":"completed"}',
      timestamp: 130,
      sessionId: 'agent:kanban-workflow-worker:JULES-274',
    });
  });

  it('ignores a latest assistant toolUse message that would otherwise swallow the reply', () => {
    const history = {
      sessionId: 'agent:kanban-workflow-worker:d5ae7042-5de6-48a0-85e2-ae8d975de81b',
      messages: [
        {
          role: 'toolResult',
          timestamp: 1742038561537,
          content: [{ type: 'text', text: 'search output' }],
        },
        {
          role: 'assistant',
          timestamp: 1742038600065,
          stopReason: 'toolUse',
          content: [{ type: 'toolCall', name: 'exec' }],
        },
      ],
    };

    expect(extractCompletedAssistantReplySince(history, 1742038500000)).toBeNull();
  });

  it('falls back to the local worker session store when gateway history is unavailable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kwf-worker-runtime-'));
    tempDirs.push(root);
    process.env.OPENCLAW_HOME = root;

    const sessionsDir = path.join(root, 'agents', 'kanban-workflow-worker', 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, 'sessions.json'),
      JSON.stringify(
        {
          'agent:kanban-workflow-worker:jules-241': {
            sessionId: 'bc1902ba-1a97-46dc-acb7-4f3f7cb3929b',
            sessionFile: path.join(sessionsDir, 'bc1902ba-1a97-46dc-acb7-4f3f7cb3929b.jsonl'),
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await fs.writeFile(
      path.join(sessionsDir, 'bc1902ba-1a97-46dc-acb7-4f3f7cb3929b.jsonl'),
      [
        JSON.stringify({
          type: 'message',
          timestamp: '2026-03-15T11:51:39.123Z',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'hello' }],
          },
        }),
        JSON.stringify({
          type: 'message',
          timestamp: '2026-03-15T11:51:44.912Z',
          message: {
            role: 'assistant',
            stopReason: 'stop',
            content: [{ type: 'text', text: '{"decision":"completed"}' }],
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    await expect(
      extractCompletedAssistantReplyFromLocalSessionSince('agent:kanban-workflow-worker:jules-241', 1773575499000),
    ).resolves.toEqual({
      text: '{"decision":"completed"}',
      timestamp: 1773575504912,
      sessionId: 'bc1902ba-1a97-46dc-acb7-4f3f7cb3929b',
    });
  });

  it('uses the local worker session store when gateway history is stale but reachable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kwf-worker-runtime-'));
    tempDirs.push(root);
    process.env.OPENCLAW_HOME = root;

    const sessionsDir = path.join(root, 'agents', 'kanban-workflow-worker', 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, 'sessions.json'),
      JSON.stringify(
        {
          'agent:kanban-workflow-worker:jules-267': {
            sessionId: 'b04dfd8e-034a-45a3-88b1-09f9789ed6c1',
            sessionFile: path.join(sessionsDir, 'b04dfd8e-034a-45a3-88b1-09f9789ed6c1.jsonl'),
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await fs.writeFile(
      path.join(sessionsDir, 'b04dfd8e-034a-45a3-88b1-09f9789ed6c1.jsonl'),
      [
        JSON.stringify({
          type: 'message',
          timestamp: '2026-03-15T12:30:00.000Z',
          message: {
            role: 'assistant',
            stopReason: 'stop',
            content: [{ type: 'text', text: '{"decision":"blocked"}' }],
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    await expect(
      extractCompletedAssistantReplyWithLocalFallback({
        history: {
          sessionId: 'agent:kanban-workflow-worker:jules-267',
          messages: [
            {
              role: 'assistant',
              timestamp: 1773577799000,
              stopReason: 'toolUse',
              content: [{ type: 'toolCall', name: 'browser' }],
            },
          ],
        },
        sessionKey: 'agent:kanban-workflow-worker:jules-267',
        sinceTimestamp: 1773577798000,
      }),
    ).resolves.toEqual({
      text: '{"decision":"blocked"}',
      timestamp: 1773577800000,
      sessionId: 'b04dfd8e-034a-45a3-88b1-09f9789ed6c1',
    });
  });

  it('drops failed background dispatch markers instead of reporting them as running', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kwf-worker-runtime-'));
    tempDirs.push(root);

    const delegationDir = path.join(root, 'delegations');
    const workDir = path.join(delegationDir, 'jules-267');
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(
      path.join(workDir, 'meta.json'),
      JSON.stringify(
        {
          ticketId: 'b5932b75-046f-43e4-b1ca-c34ba51509da',
          dispatchRunId: '3080918f-eb53-4e2f-b7c6-7a6a6be9c95c',
          sessionId: 'jules-267',
          agentId: 'kanban-workflow-worker',
          thinking: 'high',
          startedAt: '2026-03-15T12:53:12.073Z',
          runId: 'run-267',
          sessionKey: 'agent:kanban-workflow-worker:jules-267',
          runTimeoutSeconds: 900,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(workDir, 'wait-result.json'),
      JSON.stringify({ runId: 'run-267', status: 'error', error: 'agent.wait failed' }) + '\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(workDir, 'stderr.log'),
      'Gateway call failed: Error: gateway closed (1000 normal closure): no close reason\n',
      'utf8',
    );
    await fs.writeFile(path.join(workDir, 'done'), '', 'utf8');

    await expect(
      loadWorkerDelegationState(
        'jules-267',
        'b5932b75-046f-43e4-b1ca-c34ba51509da',
        workerRuntimeOpts(delegationDir),
      ),
    ).resolves.toEqual({ kind: 'none' });

    await expect(fs.access(workDir)).rejects.toThrow();
  });
});

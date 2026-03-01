import * as fs from 'node:fs/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('../src/config.js', () => ({
  loadConfigFromFile: vi.fn(async () => ({
    version: 1,
    adapter: { kind: 'github', repo: 'o/r', stageMap: {} },
  })),
}));

vi.mock('../src/adapters/github.js', () => ({
  GitHubAdapter: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../src/adapters/linear.js', () => ({
  LinearAdapter: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../src/adapters/plane.js', () => ({
  PlaneAdapter: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../src/adapters/planka.js', () => ({
  PlankaAdapter: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../src/automation/lockfile.js', () => ({
  lockfile: {
    tryAcquireLock: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
  },
}));

vi.mock('../src/automation/autopilot_tick.js', () => ({
  runAutopilotTick: vi.fn(),
}));

vi.mock('../src/automation/auto_reopen.js', () => ({
  runAutoReopenOnHumanComment: vi.fn(async () => ({ actions: [] })),
}));

vi.mock('../src/verbs/verbs.js', () => ({
  show: vi.fn(async (_adapter: unknown, id: string) => ({ item: { id, title: 'T' }, comments: [] })),
  next: vi.fn(async () => ({ kind: 'none' })),
  start: vi.fn(async () => undefined),
  update: vi.fn(async () => undefined),
  ask: vi.fn(async () => undefined),
  complete: vi.fn(async () => undefined),
  create: vi.fn(async () => ({ id: 'X' })),
}));

import { execa } from 'execa';

import { runAutopilotTick } from '../src/automation/autopilot_tick.js';
import { extractWorkerTerminalCommand, runCli } from '../src/cli.js';
import { validateWorkerResponseContract } from '../src/automation/worker_contract.js';
import { loadSessionMap } from '../src/automation/session_dispatcher.js';
import { ask, complete, update } from '../src/verbs/verbs.js';

type IoCapture = { out: string[]; err: string[] };

function createIo(): { io: any; cap: IoCapture } {
  const cap: IoCapture = { out: [], err: [] };
  return {
    cap,
    io: {
      stdout: { write: (chunk: string) => cap.out.push(chunk) },
      stderr: { write: (chunk: string) => cap.err.push(chunk) },
    },
  };
}

function parseFirstJson(out: string[]): any {
  const combined = out.join('');
  const idx = combined.indexOf('\nWhat next:');
  const jsonText = idx >= 0 ? combined.slice(0, idx).trim() : combined.trim();
  return JSON.parse(jsonText);
}

describe('cron-dispatch worker parser + execution integration', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.KWF_WORKER_BACKGROUND_DELEGATION = 'true';
    await fs.rm('.tmp/kwf-session-map.json', { force: true });
    await fs.rm('.tmp/kwf-worker-delegations', { recursive: true, force: true });
  });

  it('enforces strict terminal command + evidence contract', () => {
    const invalid = validateWorkerResponseContract([
      'thinking... here are examples:',
      'kanban-workflow continue --text "template only"',
      'final:',
      'kanban-workflow blocked --text "Dependency says \\\"no\\\" for now.\\nNeed maintainer approval."',
    ].join('\n'));

    expect(invalid.ok).toBe(false);
    expect(invalid.violations.join(' ')).toContain('exactly one terminal');

    const parsed = extractWorkerTerminalCommand([
      'Did work.',
      'EVIDENCE',
      '- executed: plane issue update command',
      '- key result/output: API accepted update',
      '- changed files: none',
      'kanban-workflow blocked --text "Dependency says \\\"no\\\" for now.\\nNeed maintainer approval."',
    ].join('\n'));

    expect(parsed).toEqual({
      kind: 'blocked',
      text: 'Dependency says "no" for now.\nNeed maintainer approval.',
    });
  });

  it('sends first-hit no-work alert to Simon in Rocket.Chat and suppresses repeats', async () => {
    vi.mocked(runAutopilotTick).mockResolvedValueOnce({
      kind: 'no_work',
      reasonCode: 'no_backlog_assigned',
    } as any);

    vi.mocked(execa).mockResolvedValueOnce({
      stdout: JSON.stringify({ ok: true }),
      stderr: '',
    } as any);

    const firstIo = createIo();
    const firstCode = await runCli(['cron-dispatch'], firstIo.io);
    expect(firstCode).toBe(0);

    expect(execa).toHaveBeenCalledWith(
      'openclaw',
      expect.arrayContaining([
        'message',
        'send',
        '--channel',
        'rocketchat',
        '--target',
        'simon.vanlaak',
      ]),
    );

    const firstOut = parseFirstJson(firstIo.cap.out);
    expect(firstOut.dispatch.noWorkAlert).toMatchObject({
      outcome: 'first_hit_sent',
      channel: 'rocketchat',
      target: 'simon.vanlaak',
      reasonCode: 'no_backlog_assigned',
    });

    const firstMap = await loadSessionMap('.tmp/kwf-session-map.json');
    expect(firstMap.noWork?.firstHitAlertTarget).toBe('simon.vanlaak');
    expect(firstMap.noWork?.firstHitAlertChannel).toBe('rocketchat');
    expect(firstMap.noWork?.firstHitAlertSentAt).toBeTruthy();

    vi.mocked(runAutopilotTick).mockResolvedValueOnce({
      kind: 'no_work',
      reasonCode: 'no_backlog_assigned',
    } as any);

    const secondIo = createIo();
    const secondCode = await runCli(['cron-dispatch'], secondIo.io);
    expect(secondCode).toBe(0);
    expect(execa).toHaveBeenCalledTimes(1);

    const secondOut = parseFirstJson(secondIo.cap.out);
    expect(secondOut.dispatch.noWorkAlert).toMatchObject({
      outcome: 'repeat_suppressed',
      reasonCode: 'no_backlog_assigned',
    });
  });

  it('does not delegate to background execution on gateway sync timeout (prevents noisy ticket comments)', async () => {
    vi.mocked(runAutopilotTick).mockResolvedValueOnce({
      kind: 'in_progress',
      id: 'A1',
      inProgressIds: ['A1'],
      reasonCode: 'active_in_progress',
    } as any);

    vi.mocked(execa).mockRejectedValueOnce(new Error('Request timed out before a response was generated.'));

    const { io, cap } = createIo();
    const code = await runCli(['cron-dispatch', '--agent', 'kwf-worker-test'], io);

    expect(code).toBe(0);
    expect(update).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(execa).toHaveBeenCalledTimes(1);

    const out = parseFirstJson(cap.out);
    expect(out.dispatch.execution[0].outcome).toBe('parse_error');
  });

  it('keeps worker agents silent on gateway sync timeout by default', async () => {
    delete process.env.KWF_WORKER_BACKGROUND_DELEGATION;

    vi.mocked(runAutopilotTick).mockResolvedValueOnce({
      kind: 'in_progress',
      id: 'A1',
      inProgressIds: ['A1'],
      reasonCode: 'active_in_progress',
    } as any);

    vi.mocked(execa).mockRejectedValueOnce(new Error('Request timed out before a response was generated.'));

    const { io, cap } = createIo();
    const code = await runCli(['cron-dispatch', '--agent', 'kwf-worker-test'], io);

    expect(code).toBe(0);
    expect(update).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(execa).toHaveBeenCalledTimes(1);

    const out = parseFirstJson(cap.out);
    expect(out.dispatch.execution[0].outcome).toBe('parse_error');
  });

  it('does not delegate when gateway returns timeout fallback payload text (prevents noisy ticket comments)', async () => {
    vi.mocked(runAutopilotTick).mockResolvedValueOnce({
      kind: 'in_progress',
      id: 'A1',
      inProgressIds: ['A1'],
      reasonCode: 'active_in_progress',
    } as any);

    vi.mocked(execa).mockResolvedValueOnce({
      stdout: JSON.stringify({
        result: {
          payloads: [
            {
              text: 'Request timed out before a response was generated. Please try again, or increase `agents.defaults.timeoutSeconds` in your config.',
            },
          ],
        },
      }),
      stderr: '',
    } as any);

    const { io, cap } = createIo();
    const code = await runCli(['cron-dispatch', '--agent', 'kwf-worker-test'], io);

    expect(code).toBe(0);
    expect(update).not.toHaveBeenCalled();
    expect(execa).toHaveBeenCalledTimes(1);

    const out = parseFirstJson(cap.out);
    expect(out.dispatch.execution[0].outcome).toBe('parse_error');
  });

  it('keeps delegated run in running state without duplicate writes', async () => {
    vi.mocked(runAutopilotTick).mockResolvedValueOnce({
      kind: 'in_progress',
      id: 'A1',
      inProgressIds: ['A1'],
      reasonCode: 'active_in_progress',
    } as any);

    const dir = '.tmp/kwf-worker-delegations/a1';
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(`${dir}/meta.json`, JSON.stringify({
      ticketId: 'A1',
      sessionId: 'a1',
      agentId: 'kwf-worker-test',
      thinking: 'high',
      startedAt: new Date().toISOString(),
      syncTimeoutMs: 30000,
      backgroundTimeoutMs: 900000,
    }, null, 2));

    const { io, cap } = createIo();
    const code = await runCli(['cron-dispatch', '--agent', 'kwf-worker-test'], io);

    expect(code).toBe(0);
    expect(update).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(execa).not.toHaveBeenCalled();

    const out = parseFirstJson(cap.out);
    expect(out.dispatch.execution[0].outcome).toBe('delegated_running');
  });

  it('applies queued background delegation result on next tick', async () => {
    vi.mocked(runAutopilotTick).mockResolvedValueOnce({
      kind: 'in_progress',
      id: 'A1',
      inProgressIds: ['A1'],
      reasonCode: 'active_in_progress',
    } as any);

    const dir = '.tmp/kwf-worker-delegations/a1';
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(`${dir}/meta.json`, JSON.stringify({
      ticketId: 'A1',
      sessionId: 'a1',
      agentId: 'kwf-worker-test',
      thinking: 'high',
      startedAt: new Date().toISOString(),
      syncTimeoutMs: 30000,
      backgroundTimeoutMs: 900000,
    }, null, 2));
    await fs.writeFile(`${dir}/result.json`, JSON.stringify({
      result: {
        payloads: [
          {
            text: [
              'Done.',
              'EVIDENCE',
              '- executed: async worker replay',
              '- key result/output: background task finished and returned parser-safe command',
              '- changed files: src/cli.ts',
              'kanban-workflow continue --text "Background run finished, applying update now."',
            ].join('\n'),
          },
        ],
      },
    }));
    await fs.writeFile(`${dir}/stderr.log`, '');
    await fs.writeFile(`${dir}/done`, '');

    const { io, cap } = createIo();
    const code = await runCli(['cron-dispatch', '--agent', 'kwf-worker-test'], io);

    expect(code).toBe(0);
    expect(update).toHaveBeenCalledWith(expect.anything(), 'A1', 'Background run finished, applying update now.');
    expect(execa).not.toHaveBeenCalled();

    const out = parseFirstJson(cap.out);
    expect(out.dispatch.execution[0].outcome).toBe('applied');
    expect(out.dispatch.execution[0].detail).toContain('source=background-delegation');
  });

  it('applies completed mutation and logs applied outcome from worker output', async () => {
    vi.mocked(runAutopilotTick).mockResolvedValueOnce({
      kind: 'in_progress',
      id: 'A1',
      inProgressIds: ['A1'],
      reasonCode: 'active_in_progress',
    } as any);

    vi.mocked(execa).mockResolvedValueOnce({
      stdout: JSON.stringify({
        result: {
          payloads: [
            {
              text: [
                'Done.',
                'EVIDENCE',
                '- executed: tests + parser hardening',
                '- key result/output: all target tests pass',
                '- changed files: src/automation/worker_contract.ts, src/cli.ts',
                'kanban-workflow completed --result "Implemented fix across parser + dispatcher."',
              ].join('\n'),
            },
          ],
        },
      }),
      stderr: '',
    } as any);

    const { io, cap } = createIo();
    const code = await runCli(['cron-dispatch', '--agent', 'kwf-worker-test'], io);

    expect(code).toBe(0);
    expect(update).not.toHaveBeenCalled(); // no boilerplate heartbeat update on in_progress
    expect(complete).toHaveBeenCalledWith(expect.anything(), 'A1', 'Implemented fix across parser + dispatcher.');
    expect(ask).not.toHaveBeenCalled();
    expect(execa).toHaveBeenCalledWith(
      'openclaw',
      expect.arrayContaining(['gateway', 'call', 'agent', '--expect-final', '--json', '--params', expect.any(String)]),
    );
    const execaArgs = vi.mocked(execa).mock.calls[0]?.[1] as string[];
    const paramsJson = execaArgs[execaArgs.indexOf('--params') + 1];
    const params = JSON.parse(paramsJson);
    expect(params.sessionKey).toBe('agent:kwf-worker-test:a1');

    const out = parseFirstJson(cap.out);
    expect(out.dispatch.execution[0].outcome).toBe('applied');
    expect(out.dispatch.execution[0].parsed).toEqual({
      kind: 'completed',
      result: 'Implemented fix across parser + dispatcher.',
    });

    const map = await loadSessionMap('.tmp/kwf-session-map.json');
    expect(map.sessionsByTicket.A1?.lastState).toBe('completed');
    expect(map.sessionsByTicket.A1?.closedAt).toBeTruthy();
  });

  it('normalizes legacy worker session ids so sessionKey does not repeat worker prefix', async () => {
    await fs.mkdir('.tmp', { recursive: true });
    await fs.writeFile(
      '.tmp/kwf-session-map.json',
      `${JSON.stringify(
        {
          version: 1,
          active: { ticketId: 'A1', sessionId: 'kanban-workflow-worker-7e034eda-9929-4fe6-80ee-94c46cc55b37' },
          sessionsByTicket: {
            A1: {
              sessionId: 'kanban-workflow-worker-7e034eda-9929-4fe6-80ee-94c46cc55b37',
              lastState: 'in_progress',
              lastSeenAt: '2026-02-28T22:00:00.000Z',
            },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    vi.mocked(runAutopilotTick).mockResolvedValueOnce({
      kind: 'in_progress',
      id: 'A1',
      inProgressIds: ['A1'],
      reasonCode: 'active_in_progress',
    } as any);

    vi.mocked(execa).mockResolvedValueOnce({
      stdout: JSON.stringify({
        result: {
          payloads: [
            {
              text: [
                'Progress update.',
                'EVIDENCE',
                '- executed: renamed worker session key normalization',
                '- key result/output: session key no longer repeats worker id prefix',
                '- changed files: src/cli.ts',
                'kanban-workflow continue --text "Kept working with normalized session key."',
              ].join('\n'),
            },
          ],
        },
      }),
      stderr: '',
    } as any);

    const { io } = createIo();
    const code = await runCli(['cron-dispatch', '--agent', 'kanban-workflow-worker'], io);

    expect(code).toBe(0);
    const execaArgs = vi.mocked(execa).mock.calls[0]?.[1] as string[];
    const paramsJson = execaArgs[execaArgs.indexOf('--params') + 1];
    const params = JSON.parse(paramsJson);
    expect(params.sessionKey).toBe('agent:kanban-workflow-worker:7e034eda-9929-4fe6-80ee-94c46cc55b37');
  });
});

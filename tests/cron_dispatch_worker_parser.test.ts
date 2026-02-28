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
    await fs.rm('.tmp/kwf-session-map.json', { force: true });
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
    expect(params.sessionKey).toBe('agent:kwf-worker-test:kanban-workflow-worker-a1');

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
});

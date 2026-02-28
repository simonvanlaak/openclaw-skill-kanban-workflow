import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  show: vi.fn(async (_adapter: unknown, id: string) => ({ item: { id, title: 'T' } })),
  next: vi.fn(async () => ({ kind: 'item', item: { id: 'N1', title: 'Next' } })),
  start: vi.fn(async () => undefined),
  update: vi.fn(async () => undefined),
  ask: vi.fn(async () => undefined),
  complete: vi.fn(async () => undefined),
  create: vi.fn(async () => ({ id: 'X' })),
}));

import { runCli } from '../src/cli.js';
import { runAutopilotTick } from '../src/automation/autopilot_tick.js';
import { ask, complete, next, show, start, update } from '../src/verbs/verbs.js';

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

describe('autopilot CLI simplified contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(next).mockResolvedValue({ kind: 'item', item: { id: 'N1', title: 'Next' } } as any);
  });

  it('returns continue contract with halt options and does not mutate on --dry-run', async () => {
    vi.mocked(runAutopilotTick).mockResolvedValueOnce({
      kind: 'in_progress',
      id: 'A1',
      inProgressIds: ['A1'],
      reasonCode: 'active_in_progress',
    } as any);

    vi.mocked(show).mockResolvedValueOnce({
      adapter: 'plane',
      item: { id: 'A1', title: 'T', body: 'Full Plane ticket body' },
      comments: [],
    } as any);

    const { io, cap } = createIo();
    const code = await runCli(['autopilot-tick', '--dry-run'], io);

    expect(code).toBe(0);
    expect(update).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith(expect.anything(), 'A1');

    const out = parseFirstJson(cap.out);
    expect(out.nextTicket.item).toEqual({ id: 'A1', title: 'T', body: 'Full Plane ticket body' });
    expect(out.instruction).toBe('Continue working on this ticket now.');
    expect(out.haltOptions.continue.command).toContain('kanban-workflow continue --text');
    expect(out.haltOptions.blocked.command).toContain('kanban-workflow blocked --text');
    expect(out.haltOptions.completed.command).toContain('kanban-workflow completed --result');
    expect(out.dryRun).toBe(true);
  });

  it('executes blocked branch and pivots to next ticket contract', async () => {
    vi.mocked(runAutopilotTick).mockResolvedValueOnce({
      kind: 'blocked',
      id: 'A1',
      minutesStale: 15,
      reason: 'Auto-blocked: stale in-progress item with blocker signal in recent updates.',
      reasonCode: 'stale_with_blocker_signal',
    } as any);

    const { io, cap } = createIo();
    const code = await runCli(['autopilot-tick'], io);

    expect(code).toBe(0);
    expect(ask).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();

    const out = parseFirstJson(cap.out);
    expect(out.instruction).toBe('Previous ticket is blocked. Work on this next ticket now.');
    expect(out.haltOptions.continue.command).toContain('kanban-workflow continue --text');
  });

  it('executes completed branch only when completion proof gate is strong', async () => {
    vi.mocked(runAutopilotTick).mockResolvedValueOnce({
      kind: 'completed',
      id: 'A1',
      reason: 'Auto-completed: detected completion proof marker in recent updates.',
      reasonCode: 'completion_signal_strong',
    } as any);

    const { io, cap } = createIo();
    const code = await runCli(['autopilot-tick'], io);

    expect(code).toBe(0);
    expect(complete).toHaveBeenCalledOnce();

    const out = parseFirstJson(cap.out);
    expect(out.instruction).toBe('Previous ticket completed. Work on this next ticket now.');
    expect(out.haltOptions.completed.command).toContain('kanban-workflow completed --result');
  });

  it('holds action when completion proof gate fails', async () => {
    vi.mocked(runAutopilotTick).mockResolvedValueOnce({
      kind: 'completed',
      id: 'A1',
      reason: 'weak signal',
      reasonCode: 'weak_signal',
    } as any);

    const { io, cap } = createIo();
    const code = await runCli(['autopilot-tick'], io);

    expect(code).toBe(0);
    expect(complete).not.toHaveBeenCalled();

    const out = parseFirstJson(cap.out);
    expect(out).toEqual({
      tick: {
        kind: 'completed',
        id: 'A1',
        reason: 'weak signal',
        reasonCode: 'weak_signal',
      },
      action: 'hold',
      reason: 'completion_proof_gate_failed',
      dryRun: false,
      autoReopen: { actions: [] },
    });
  });
});

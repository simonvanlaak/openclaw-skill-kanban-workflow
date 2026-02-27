import { describe, expect, test, vi } from 'vitest';

import { runAutopilotTick } from '../src/automation/autopilot_tick.js';

function fakeLock() {
  return {
    tryAcquireLock: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
  };
}

describe('autopilot-tick', () => {
  test('returns in_progress when there is an in-progress item assigned to me', async () => {
    const lock = fakeLock();
    const adapter = {
      whoami: vi.fn(async () => ({ id: 'me' })),
      listIdsByStage: vi.fn(async () => ['A']),
      listBacklogIdsInOrder: vi.fn(async () => ['B']),
      getWorkItem: vi.fn(async () => ({ assignees: [{ id: 'me' }] })),
      setStage: vi.fn(async () => undefined),
      addComment: vi.fn(async () => undefined),
    };

    const res = await runAutopilotTick({ adapter, lock, now: new Date('2026-02-26T00:00:00Z') });
    expect(res).toEqual({ kind: 'in_progress', id: 'A', inProgressIds: ['A'] });
    expect(adapter.setStage).not.toHaveBeenCalled();
  });

  test('starts backlog item when only other users have in-progress tickets', async () => {
    const lock = fakeLock();
    const adapter = {
      whoami: vi.fn(async () => ({ username: 'me' })),
      listIdsByStage: vi.fn(async () => ['A']),
      listBacklogIdsInOrder: vi.fn(async () => ['B', 'C']),
      getWorkItem: vi.fn(async () => ({ assignees: [{ username: 'someone-else' }] })),
      setStage: vi.fn(async () => undefined),
      addComment: vi.fn(async () => undefined),
    };

    const res = await runAutopilotTick({ adapter, lock, now: new Date('2026-02-26T00:00:00Z') });
    expect(res).toEqual({ kind: 'started', id: 'B' });
    expect(adapter.setStage).toHaveBeenCalledWith('B', 'stage:in-progress');
  });

  test('auto-heals only my own extra in-progress tickets', async () => {
    const lock = fakeLock();
    const adapter = {
      whoami: vi.fn(async () => ({ id: 'me' })),
      listIdsByStage: vi.fn(async () => ['A', 'B', 'C']),
      listBacklogIdsInOrder: vi.fn(async () => ['X']),
      getWorkItem: vi.fn(async (id: string) => {
        if (id === 'A') return { assignees: [{ id: 'me' }] };
        if (id === 'B') return { assignees: [{ id: 'me' }] };
        return { assignees: [{ id: 'other' }] };
      }),
      setStage: vi.fn(async () => undefined),
      addComment: vi.fn(async () => undefined),
    };

    const res = await runAutopilotTick({ adapter, lock, now: new Date('2026-02-26T00:00:00Z') });
    expect(res).toEqual({ kind: 'in_progress', id: 'A', inProgressIds: ['A'] });
    expect(adapter.setStage).toHaveBeenCalledTimes(1);
    expect(adapter.setStage).toHaveBeenCalledWith('B', 'stage:backlog');
    expect(adapter.addComment).toHaveBeenCalledTimes(1);
    expect(adapter.addComment).toHaveBeenCalledWith(
      'B',
      expect.stringContaining('Moved back to Backlog automatically'),
    );
  });

  test('starts the first backlog item when idle', async () => {
    const lock = fakeLock();
    const adapter = {
      whoami: vi.fn(async () => ({ id: 'me' })),
      listIdsByStage: vi.fn(async () => []),
      listBacklogIdsInOrder: vi.fn(async () => ['B', 'C']),
      getWorkItem: vi.fn(async () => ({ assignees: [] })),
      setStage: vi.fn(async () => undefined),
      addComment: vi.fn(async () => undefined),
    };

    const res = await runAutopilotTick({ adapter, lock, now: new Date('2026-02-26T00:00:00Z') });
    expect(res).toEqual({ kind: 'started', id: 'B' });
    expect(adapter.setStage).toHaveBeenCalledWith('B', 'stage:in-progress');
  });

  test('returns no_work when backlog is empty and idle', async () => {
    const lock = fakeLock();
    const adapter = {
      whoami: vi.fn(async () => ({ id: 'me' })),
      listIdsByStage: vi.fn(async () => []),
      listBacklogIdsInOrder: vi.fn(async () => []),
      getWorkItem: vi.fn(async () => ({ assignees: [] })),
      setStage: vi.fn(async () => undefined),
      addComment: vi.fn(async () => undefined),
    };

    const res = await runAutopilotTick({ adapter, lock, now: new Date('2026-02-26T00:00:00Z') });
    expect(res).toEqual({ kind: 'no_work' });
    expect(adapter.setStage).not.toHaveBeenCalled();
  });
});

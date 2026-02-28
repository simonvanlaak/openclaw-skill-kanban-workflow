import { describe, expect, test, vi } from 'vitest';

import { runAutopilotTick } from '../src/automation/autopilot_tick.js';

function fakeLock() {
  return {
    tryAcquireLock: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
  };
}

describe('autopilot-tick', () => {
  test('runs optional assignment reconciliation before selection', async () => {
    const lock = fakeLock();
    const adapter = {
      reconcileAssignments: vi.fn(async () => undefined),
      whoami: vi.fn(async () => ({ id: 'me' })),
      listIdsByStage: vi.fn(async () => []),
      listBacklogIdsInOrder: vi.fn(async () => []),
      getWorkItem: vi.fn(async () => ({ assignees: [] })),
      setStage: vi.fn(async () => undefined),
      addComment: vi.fn(async () => undefined),
    };

    await runAutopilotTick({ adapter, lock, now: new Date('2026-02-26T00:00:00Z') });

    expect(adapter.reconcileAssignments).toHaveBeenCalledTimes(1);
    expect(adapter.reconcileAssignments.mock.invocationCallOrder[0]).toBeLessThan(
      adapter.whoami.mock.invocationCallOrder[0],
    );
  });

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
      getWorkItem: vi.fn(async (id: string) => {
        if (id === 'A') return { assignees: [{ username: 'someone-else' }] };
        return { assignees: [{ username: 'me' }] };
      }),
      setStage: vi.fn(async () => undefined),
      addComment: vi.fn(async () => undefined),
    };

    const res = await runAutopilotTick({ adapter, lock, now: new Date('2026-02-26T00:00:00Z') });
    expect(res).toEqual({
      kind: 'started',
      id: 'B',
      reasonCode: 'start_next_assigned_backlog',
      evidence: { updatedAt: undefined },
    });
    // The decision function returns "started"; stage mutation is done by CLI orchestration.
    expect(adapter.setStage).not.toHaveBeenCalled();
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
    expect(adapter.setStage).toHaveBeenCalledWith('B', 'stage:todo');
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
      getWorkItem: vi.fn(async () => ({ assignees: [{ id: 'me' }] })),
      setStage: vi.fn(async () => undefined),
      addComment: vi.fn(async () => undefined),
    };

    const res = await runAutopilotTick({ adapter, lock, now: new Date('2026-02-26T00:00:00Z') });
    expect(res).toEqual({
      kind: 'started',
      id: 'B',
      reasonCode: 'start_next_assigned_backlog',
      evidence: { updatedAt: undefined },
    });
    expect(adapter.setStage).not.toHaveBeenCalled();
  });

  test('returns no_work with reason code when next backlog ticket is not assigned to me', async () => {
    const lock = fakeLock();
    const adapter = {
      whoami: vi.fn(async () => ({ id: 'me' })),
      listIdsByStage: vi.fn(async () => []),
      listBacklogIdsInOrder: vi.fn(async () => ['B', 'C']),
      getWorkItem: vi.fn(async () => ({ assignees: [{ id: 'other' }] })),
      setStage: vi.fn(async () => undefined),
      addComment: vi.fn(async () => undefined),
    };

    const res = await runAutopilotTick({ adapter, lock, now: new Date('2026-02-26T00:00:00Z') });
    expect(res).toEqual({ kind: 'no_work', reasonCode: 'next_not_assigned_to_me' });
    expect(adapter.setStage).not.toHaveBeenCalled();
  });

  test('returns no_work with reason code when backlog is empty and idle', async () => {
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
    expect(res).toEqual({ kind: 'no_work', reasonCode: 'no_backlog_assigned' });
    expect(adapter.setStage).not.toHaveBeenCalled();
  });

  test('returns completed when completion proof marker is found in recent comments', async () => {
    const lock = fakeLock();
    const now = new Date('2026-02-26T00:12:00Z');
    const adapter = {
      whoami: vi.fn(async () => ({ id: 'me' })),
      listIdsByStage: vi.fn(async () => ['A']),
      listBacklogIdsInOrder: vi.fn(async () => ['B']),
      getWorkItem: vi.fn(async () => ({ assignees: [{ id: 'me' }], updatedAt: new Date('2026-02-26T00:11:00Z') })),
      listComments: vi.fn(async () => [{ body: 'Completed: shipped and verified' }]),
      setStage: vi.fn(async () => undefined),
      addComment: vi.fn(async () => undefined),
    };

    const res = await runAutopilotTick({ adapter, lock, now });
    expect(res).toMatchObject({
      kind: 'completed',
      id: 'A',
      reasonCode: 'completion_signal_strong',
      evidence: { matchedSignal: 'completed:' },
    });
  });

  test('returns blocked when stale and blocker signal appears in comments', async () => {
    const lock = fakeLock();
    const now = new Date('2026-02-26T00:20:00Z');
    const adapter = {
      whoami: vi.fn(async () => ({ id: 'me' })),
      listIdsByStage: vi.fn(async () => ['A']),
      listBacklogIdsInOrder: vi.fn(async () => ['B']),
      getWorkItem: vi.fn(async () => ({ assignees: [{ id: 'me' }], updatedAt: new Date('2026-02-26T00:00:00Z') })),
      listComments: vi.fn(async () => [{ body: 'Still waiting on API credential, blocked here.' }]),
      setStage: vi.fn(async () => undefined),
      addComment: vi.fn(async () => undefined),
    };

    const res = await runAutopilotTick({ adapter, lock, now });
    expect(res).toMatchObject({
      kind: 'blocked',
      id: 'A',
      reasonCode: 'stale_with_blocker_signal',
      minutesStale: 20,
      evidence: { matchedSignal: 'waiting on' },
    });
  });
});

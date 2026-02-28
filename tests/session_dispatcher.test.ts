import { describe, expect, it } from 'vitest';

import { applyWorkerCommandToSessionMap, buildDispatcherPlan } from '../src/automation/session_dispatcher.js';

describe('session dispatcher', () => {
  it('reuses same session for same in_progress ticket, then finalizes and starts new session on completion', () => {
    const t1 = new Date('2026-02-28T13:00:00.000Z');
    const initialMap = { version: 1 as const, sessionsByTicket: {} };

    const first = buildDispatcherPlan({
      previousMap: initialMap,
      now: t1,
      autopilotOutput: {
        tick: { kind: 'in_progress', id: 'A1', inProgressIds: ['A1'] },
        nextTicket: {
          kind: 'item',
          item: {
            id: 'A1',
            title: 'Fix login race',
            body: 'Repro in Safari private mode',
            attachments: [{ name: 'trace.log', url: 'https://files/trace.log' }],
            linked: [{ id: 'BUG-77', title: 'Root cause', url: 'https://tracker/BUG-77' }],
          },
          comments: [{ body: 'Latest update', author: 'jules' }],
        },
        instruction: 'Continue working on this ticket now.',
      },
    });

    expect(first.activeTicketId).toBe('A1');
    expect(first.actions).toHaveLength(1);
    expect(first.actions[0]?.kind).toBe('work');
    expect(first.actions[0]?.text).toContain('DO WORK NOW on ticket A1.');
    expect(first.actions[0]?.text).toContain('kanban-workflow continue --text');
    expect(first.actions[0]?.text).toContain('kanban-workflow blocked --text');
    expect(first.actions[0]?.text).toContain('kanban-workflow completed --result');
    expect(first.actions[0]?.text).toContain('"title": "Fix login race"');
    expect(first.actions[0]?.text).toContain('"attachments"');
    expect(first.actions[0]?.text).toContain('"links"');
    const a1Session = first.actions[0]!.sessionId;

    const second = buildDispatcherPlan({
      previousMap: first.map,
      now: new Date('2026-02-28T13:05:00.000Z'),
      autopilotOutput: {
        tick: { kind: 'in_progress', id: 'A1', inProgressIds: ['A1'] },
      },
    });

    expect(second.actions[0]?.sessionId).toBe(a1Session);

    const third = buildDispatcherPlan({
      previousMap: second.map,
      now: new Date('2026-02-28T13:10:00.000Z'),
      autopilotOutput: {
        tick: { kind: 'completed', id: 'A1', reasonCode: 'completion_signal_strong' },
        nextTicket: { kind: 'item', item: { id: 'B2' } },
      },
    });

    expect(third.actions).toHaveLength(2);
    expect(third.actions[0]).toMatchObject({ kind: 'finalize', ticketId: 'A1', sessionId: a1Session });
    expect(third.actions[1]).toMatchObject({ kind: 'work', ticketId: 'B2' });
    expect(third.actions[1]?.text).toContain('DO WORK NOW on ticket B2.');
    expect(third.actions[1]?.sessionId).not.toBe(a1Session);
    expect(third.map.active?.ticketId).toBe('B2');
    expect(third.map.sessionsByTicket.A1?.closedAt).toBeTruthy();
  });

  it('switches ticket on blocked transition with finalize + new work action', () => {
    const seededMap = {
      version: 1 as const,
      active: { ticketId: 'A1', sessionId: 'kwf-A1-1' },
      sessionsByTicket: {
        A1: { sessionId: 'kwf-A1-1', lastState: 'in_progress' as const, lastSeenAt: '2026-02-28T13:00:00.000Z' },
      },
    };

    const plan = buildDispatcherPlan({
      previousMap: seededMap,
      now: new Date('2026-02-28T13:15:00.000Z'),
      autopilotOutput: {
        tick: { kind: 'blocked', id: 'A1', reasonCode: 'stale_with_blocker_signal' },
        nextTicket: { kind: 'item', item: { id: 'C3', title: 'Unblock deploy' }, comments: [] },
      },
    });

    expect(plan.actions[0]).toMatchObject({ kind: 'finalize', ticketId: 'A1', sessionId: 'kwf-A1-1' });
    expect(plan.actions[1]).toMatchObject({ kind: 'work', ticketId: 'C3' });
    expect(plan.actions[1]?.text).toContain('"title": "Unblock deploy"');
    expect(plan.map.active?.ticketId).toBe('C3');
  });

  it('keeps no-work path as dispatch no-op', () => {
    const seededMap = {
      version: 1 as const,
      active: { ticketId: 'A1', sessionId: 'kwf-A1-1' },
      sessionsByTicket: {
        A1: { sessionId: 'kwf-A1-1', lastState: 'in_progress' as const, lastSeenAt: '2026-02-28T13:00:00.000Z' },
      },
    };

    const plan = buildDispatcherPlan({
      previousMap: seededMap,
      now: new Date('2026-02-28T13:20:00.000Z'),
      autopilotOutput: { kind: 'no_work' },
    });

    expect(plan.actions).toEqual([]);
    expect(plan.activeTicketId).toBeNull();
    expect(plan.map.active).toBeUndefined();
  });

  it('applies worker command back into session map state', () => {
    const map = {
      version: 1 as const,
      active: { ticketId: 'A1', sessionId: 'kwf-A1-1' },
      sessionsByTicket: {
        A1: { sessionId: 'kwf-A1-1', lastState: 'in_progress' as const, lastSeenAt: '2026-02-28T13:00:00.000Z' },
      },
    };

    const completedMap = applyWorkerCommandToSessionMap(
      structuredClone(map),
      'A1',
      { kind: 'completed', result: 'done' },
      new Date('2026-02-28T13:25:00.000Z'),
    );
    expect(completedMap.sessionsByTicket.A1?.lastState).toBe('completed');
    expect(completedMap.sessionsByTicket.A1?.closedAt).toBe('2026-02-28T13:25:00.000Z');
    expect(completedMap.active).toBeUndefined();

    const reopened = applyWorkerCommandToSessionMap(
      structuredClone(completedMap),
      'A1',
      { kind: 'continue', text: 'retrying' },
      new Date('2026-02-28T13:30:00.000Z'),
    );
    expect(reopened.sessionsByTicket.A1?.lastState).toBe('in_progress');
    expect(reopened.sessionsByTicket.A1?.closedAt).toBeUndefined();
    expect(reopened.active?.ticketId).toBe('A1');
  });
});

import { describe, expect, it } from 'vitest';

import { applyWorkerCommandToSessionMap, buildWorkflowLoopPlan } from '../src/automation/session_dispatcher.js';

describe('session workflow-loop', () => {
  it('reuses same session for same in_progress ticket, then finalizes and starts new session on completion', () => {
    const t1 = new Date('2026-02-28T13:00:00.000Z');
    const initialMap = { version: 1 as const, sessionsByTicket: {} };

    const first = buildWorkflowLoopPlan({
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
    expect(first.actions[0]?.sessionLabel).toBe('A1 Fix login race');
    expect(first.actions[0]?.text).toContain('DO WORK NOW on ticket A1.');
    expect(first.actions[0]?.text).toContain('Session label: A1 Fix login race');
    expect(first.actions[0]?.text).toContain('WORKER_AGENT_MD (mandatory instructions loaded at task start):');
    expect(first.actions[0]?.text).toContain('## 2) Plane skill usage (required when task touches Plane)');
    expect(first.actions[0]?.text).toContain('must be stored on Nextcloud');
    expect(first.actions[0]?.text).toContain('Respond with a markdown report only');
    expect(first.actions[0]?.text).toContain('verification evidence');
    expect(first.actions[0]?.text).toContain('confidence (0.0..1.0)');
    expect(first.actions[0]?.text).toContain('"title": "Fix login race"');
    expect(first.actions[0]?.text).toContain('"attachments"');
    expect(first.actions[0]?.text).toContain('"links"');
    const a1Session = first.actions[0]!.sessionId;

    const second = buildWorkflowLoopPlan({
      previousMap: first.map,
      now: new Date('2026-02-28T13:05:00.000Z'),
      autopilotOutput: {
        tick: { kind: 'in_progress', id: 'A1', inProgressIds: ['A1'] },
      },
    });

    expect(second.actions[0]?.sessionId).toBe(a1Session);

    const third = buildWorkflowLoopPlan({
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

  it('refreshes existing worker session label when ticket title changes', () => {
    const first = buildWorkflowLoopPlan({
      previousMap: { version: 1 as const, sessionsByTicket: {} },
      now: new Date('2026-02-28T14:00:00.000Z'),
      autopilotOutput: {
        tick: { kind: 'in_progress', id: 'A1', inProgressIds: ['A1'] },
        nextTicket: { kind: 'item', item: { id: 'A1', title: 'Old title' } },
      },
    });

    const second = buildWorkflowLoopPlan({
      previousMap: first.map,
      now: new Date('2026-02-28T14:05:00.000Z'),
      autopilotOutput: {
        tick: { kind: 'in_progress', id: 'A1', inProgressIds: ['A1'] },
        nextTicket: { kind: 'item', item: { id: 'A1', title: 'New title after grooming' } },
      },
    });

    expect(second.actions[0]?.sessionId).toBe(first.actions[0]?.sessionId);
    expect(second.actions[0]?.sessionLabel).toBe('A1 New title after grooming');
    expect(second.map.sessionsByTicket.A1?.sessionLabel).toBe('A1 New title after grooming');
    expect(second.actions[0]?.text).toContain('Session label: A1 New title after grooming');
  });

  it('uses linked human-readable issue keys for worker session id + label', () => {
    const plan = buildWorkflowLoopPlan({
      previousMap: { version: 1 as const, sessionsByTicket: {} },
      now: new Date('2026-02-28T14:10:00.000Z'),
      autopilotOutput: {
        tick: { kind: 'in_progress', id: '45a8585d-9075-44de-bcd2-196e6793979a', inProgressIds: ['45a8585d-9075-44de-bcd2-196e6793979a'] },
        nextTicket: {
          kind: 'item',
          item: {
            id: '45a8585d-9075-44de-bcd2-196e6793979a',
            title: 'Improve kwf worker session naming',
            linked: [{ title: 'JULES-177', relation: 'mentioned' }],
          },
        },
      },
    });

    expect(plan.actions[0]?.sessionId).toBe('jules-177');
    expect(plan.actions[0]?.sessionLabel).toBe('JULES-177 Improve kwf worker session naming');
    expect(plan.actions[0]?.text).toContain('Session label: JULES-177 Improve kwf worker session naming');
  });

  it('extracts issue keys from top-level links when adapter emits links outside item.linked', () => {
    const plan = buildWorkflowLoopPlan({
      previousMap: { version: 1 as const, sessionsByTicket: {} },
      now: new Date('2026-02-28T14:11:00.000Z'),
      autopilotOutput: {
        tick: { kind: 'in_progress', id: '45a8585d-9075-44de-bcd2-196e6793979a', inProgressIds: ['45a8585d-9075-44de-bcd2-196e6793979a'] },
        nextTicket: {
          kind: 'item',
          item: {
            id: '45a8585d-9075-44de-bcd2-196e6793979a',
            title: 'Improve kwf worker session naming',
          },
          links: [{ title: 'JULES-177', relation: 'mentioned' }],
        },
      },
    });

    expect(plan.actions[0]?.sessionId).toBe('jules-177');
    expect(plan.actions[0]?.sessionLabel).toBe('JULES-177 Improve kwf worker session naming');
  });

  it('upgrades legacy worker session ids to human-readable keys when available', () => {
    const plan = buildWorkflowLoopPlan({
      previousMap: {
        version: 1 as const,
        active: {
          ticketId: '45a8585d-9075-44de-bcd2-196e6793979a',
          sessionId: 'kanban-workflow-worker-7e034eda-9929-4fe6-80ee-94c46cc55b37',
        },
        sessionsByTicket: {
          '45a8585d-9075-44de-bcd2-196e6793979a': {
            sessionId: 'kanban-workflow-worker-7e034eda-9929-4fe6-80ee-94c46cc55b37',
            lastState: 'in_progress' as const,
            lastSeenAt: '2026-02-28T14:10:00.000Z',
          },
        },
      },
      now: new Date('2026-02-28T14:12:00.000Z'),
      autopilotOutput: {
        tick: { kind: 'in_progress', id: '45a8585d-9075-44de-bcd2-196e6793979a', inProgressIds: ['45a8585d-9075-44de-bcd2-196e6793979a'] },
        nextTicket: {
          kind: 'item',
          item: {
            id: '45a8585d-9075-44de-bcd2-196e6793979a',
            title: 'Improve kwf worker session naming',
            linked: [{ title: 'JULES-177', relation: 'mentioned' }],
          },
        },
      },
    });

    expect(plan.actions[0]?.sessionId).toBe('jules-177');
    expect(plan.map.active?.sessionId).toBe('jules-177');
    expect(plan.map.sessionsByTicket['45a8585d-9075-44de-bcd2-196e6793979a']?.sessionId).toBe('jules-177');
  });

  it('switches ticket on blocked transition with finalize + new work action', () => {
    const seededMap = {
      version: 1 as const,
      active: { ticketId: 'A1', sessionId: 'kwf-A1-1' },
      sessionsByTicket: {
        A1: { sessionId: 'kwf-A1-1', lastState: 'in_progress' as const, lastSeenAt: '2026-02-28T13:00:00.000Z' },
      },
    };

    const plan = buildWorkflowLoopPlan({
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

    const plan = buildWorkflowLoopPlan({
      previousMap: seededMap,
      now: new Date('2026-02-28T13:20:00.000Z'),
      autopilotOutput: { kind: 'no_work' },
    });

    expect(plan.actions).toEqual([]);
    expect(plan.activeTicketId).toBeNull();
    expect(plan.map.active).toBeUndefined();
    expect(plan.map.noWork?.streakStartedAt).toBe('2026-02-28T13:20:00.000Z');
    expect(plan.map.noWork?.lastSeenAt).toBe('2026-02-28T13:20:00.000Z');
  });

  it('keeps same no-work streak start across repeated no-work ticks', () => {
    const first = buildWorkflowLoopPlan({
      previousMap: { version: 1 as const, sessionsByTicket: {} },
      now: new Date('2026-02-28T13:20:00.000Z'),
      autopilotOutput: { kind: 'no_work', reasonCode: 'no_backlog_assigned' },
    });

    const second = buildWorkflowLoopPlan({
      previousMap: first.map,
      now: new Date('2026-02-28T13:25:00.000Z'),
      autopilotOutput: { kind: 'no_work', reasonCode: 'no_backlog_assigned' },
    });

    expect(second.map.noWork?.streakStartedAt).toBe('2026-02-28T13:20:00.000Z');
    expect(second.map.noWork?.lastSeenAt).toBe('2026-02-28T13:25:00.000Z');
    expect(second.map.noWork?.reasonCode).toBe('no_backlog_assigned');
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

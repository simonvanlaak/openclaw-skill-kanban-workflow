import { describe, expect, it } from 'vitest';

import type { SessionMap } from '../src/automation/session_dispatcher.js';
import { currentActiveSession, isActiveSessionState, markTicketQueued } from '../src/workflow/workflow_state.js';

function baseMap(): SessionMap {
  return {
    version: 1,
    sessionsByTicket: {},
  };
}

describe('workflow_state helpers', () => {
  it('treats reserved and in_progress as active local states', () => {
    expect(isActiveSessionState('reserved')).toBe(true);
    expect(isActiveSessionState('in_progress')).toBe(true);
    expect(isActiveSessionState('queued')).toBe(false);
    expect(isActiveSessionState('blocked')).toBe(false);
  });

  it('returns current active session only when session entry is actively owned', () => {
    const map = baseMap();
    map.active = { ticketId: 'A1', sessionId: 'a1' };
    map.sessionsByTicket.A1 = {
      sessionId: 'a1',
      lastState: 'reserved',
      lastSeenAt: '2026-03-10T00:00:00.000Z',
    };

    expect(currentActiveSession(map)).toEqual({ ticketId: 'A1', sessionId: 'a1' });

    map.sessionsByTicket.A1.lastState = 'queued';
    expect(currentActiveSession(map)).toBeNull();
  });

  it('marks reopened tickets as queued and clears active execution metadata', () => {
    const map = baseMap();
    map.active = { ticketId: 'A1', sessionId: 'a1' };
    map.sessionsByTicket.A1 = {
      sessionId: 'a1',
      lastState: 'completed',
      lastSeenAt: '2026-03-10T00:00:00.000Z',
      closedAt: '2026-03-10T00:00:00.000Z',
      workStartedAt: '2026-03-09T00:00:00.000Z',
      continueCount: 2,
    };

    markTicketQueued(map, 'A1', new Date('2026-03-11T00:00:00.000Z'));

    expect(map.active).toBeUndefined();
    expect(map.sessionsByTicket.A1?.lastState).toBe('queued');
    expect(map.sessionsByTicket.A1?.lastSeenAt).toBe('2026-03-11T00:00:00.000Z');
    expect(map.sessionsByTicket.A1?.closedAt).toBeUndefined();
    expect(map.sessionsByTicket.A1?.workStartedAt).toBeUndefined();
    expect(map.sessionsByTicket.A1?.continueCount).toBeUndefined();
  });
});

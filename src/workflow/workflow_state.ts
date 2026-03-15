import type { SessionMap } from '../automation/session_dispatcher.js';

type ActiveSessionState = 'reserved' | 'in_progress';

export function isActiveSessionState(state: string | undefined): state is ActiveSessionState {
  return state === 'reserved' || state === 'in_progress';
}

export function currentActiveSession(map: SessionMap): { ticketId: string; sessionId: string } | null {
  const active = map.active;
  if (!active?.ticketId || !active.sessionId) return null;
  const entry = map.sessionsByTicket?.[active.ticketId];
  if (!entry) return active;
  if (!isActiveSessionState(entry.lastState)) return null;
  return active;
}

export function markTicketQueued(map: SessionMap, ticketId: string, now: Date): SessionMap {
  const entry = map.sessionsByTicket?.[ticketId];
  if (!entry) return map;

  entry.lastState = 'queued';
  entry.lastSeenAt = now.toISOString();
  delete entry.closedAt;
  delete entry.workStartedAt;
  delete entry.continueCount;

  if (map.active?.ticketId === ticketId) {
    map.active = undefined;
  }

  return map;
}

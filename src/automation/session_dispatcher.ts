import * as fs from 'node:fs/promises';

export const DEFAULT_SESSION_MAP_PATH = '.tmp/kwf-session-map.json';

export type SessionEntry = {
  sessionId: string;
  lastState: 'in_progress' | 'blocked' | 'completed' | 'no_work';
  lastSeenAt: string;
  closedAt?: string;
};

export type SessionMap = {
  version: 1;
  active?: { ticketId: string; sessionId: string };
  sessionsByTicket: Record<string, SessionEntry>;
};

export type DispatchAction = {
  kind: 'work' | 'finalize';
  sessionId: string;
  ticketId: string;
  text: string;
};

export type DispatcherPlan = {
  map: SessionMap;
  actions: DispatchAction[];
  activeTicketId: string | null;
};

function emptyMap(): SessionMap {
  return { version: 1, sessionsByTicket: {} };
}

export async function loadSessionMap(path = DEFAULT_SESSION_MAP_PATH): Promise<SessionMap> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyMap();
    const sessionsByTicket = parsed.sessionsByTicket && typeof parsed.sessionsByTicket === 'object' ? parsed.sessionsByTicket : {};
    return {
      version: 1,
      active:
        parsed.active && typeof parsed.active.ticketId === 'string' && typeof parsed.active.sessionId === 'string'
          ? { ticketId: parsed.active.ticketId, sessionId: parsed.active.sessionId }
          : undefined,
      sessionsByTicket,
    };
  } catch {
    return emptyMap();
  }
}

export async function saveSessionMap(map: SessionMap, path = DEFAULT_SESSION_MAP_PATH): Promise<void> {
  await fs.mkdir('.tmp', { recursive: true });
  await fs.writeFile(path, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
}

export function makeSessionId(ticketId: string, now: Date): string {
  const clean = ticketId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
  return `kwf-${clean}-${now.getTime()}`;
}

function ensureSessionForTicket(map: SessionMap, ticketId: string, nowIso: string): { sessionId: string; reused: boolean } {
  const existing = map.sessionsByTicket[ticketId];
  if (existing && !existing.closedAt) {
    existing.lastState = 'in_progress';
    existing.lastSeenAt = nowIso;
    map.active = { ticketId, sessionId: existing.sessionId };
    return { sessionId: existing.sessionId, reused: true };
  }

  const active = map.active;
  if (active && active.ticketId === ticketId) {
    return { sessionId: active.sessionId, reused: true };
  }

  const sessionId = makeSessionId(ticketId, new Date(nowIso));
  map.sessionsByTicket[ticketId] = {
    sessionId,
    lastState: 'in_progress',
    lastSeenAt: nowIso,
  };
  map.active = { ticketId, sessionId };
  return { sessionId, reused: false };
}

function finalizeTicket(map: SessionMap, ticketId: string, state: 'blocked' | 'completed', nowIso: string): SessionEntry | null {
  const entry = map.sessionsByTicket[ticketId];
  if (!entry) return null;
  entry.lastState = state;
  entry.lastSeenAt = nowIso;
  entry.closedAt = nowIso;
  if (map.active?.ticketId === ticketId) {
    map.active = undefined;
  }
  return entry;
}

export function buildDispatcherPlan(params: {
  autopilotOutput: any;
  previousMap: SessionMap;
  now: Date;
}): DispatcherPlan {
  const nowIso = params.now.toISOString();
  const map: SessionMap = JSON.parse(JSON.stringify(params.previousMap || emptyMap()));
  if (!map.sessionsByTicket) map.sessionsByTicket = {};

  const output = params.autopilotOutput ?? {};
  const tick = output.tick ?? output;
  const tickKind = tick?.kind;
  const currentTicketId: string | undefined = tickKind === 'started' || tickKind === 'in_progress' ? tick?.id : undefined;
  const nextTicketId: string | undefined = output?.nextTicket?.item?.id;

  const actions: DispatchAction[] = [];

  if (tickKind === 'blocked' || tickKind === 'completed') {
    const finalized = finalizeTicket(map, tick.id, tickKind, nowIso);
    if (finalized) {
      actions.push({
        kind: 'finalize',
        sessionId: finalized.sessionId,
        ticketId: tick.id,
        text: `Ticket ${tick.id} transitioned to ${tickKind}. Wrap up this thread and stop active execution for this ticket.`,
      });
    }

    if (nextTicketId) {
      const { sessionId } = ensureSessionForTicket(map, nextTicketId, nowIso);
      actions.push({
        kind: 'work',
        sessionId,
        ticketId: nextTicketId,
        text: `Autopilot selected ticket ${nextTicketId}. Continue implementation on this ticket now.`,
      });
      return { map, actions, activeTicketId: nextTicketId };
    }

    return { map, actions, activeTicketId: null };
  }

  if (currentTicketId) {
    const { sessionId } = ensureSessionForTicket(map, currentTicketId, nowIso);
    actions.push({
      kind: 'work',
      sessionId,
      ticketId: currentTicketId,
      text: `Autopilot confirms active ticket ${currentTicketId}. Continue implementation on this ticket now.`,
    });
    return { map, actions, activeTicketId: currentTicketId };
  }

  if (tickKind === 'no_work') {
    map.active = undefined;
  }

  return { map, actions, activeTicketId: null };
}

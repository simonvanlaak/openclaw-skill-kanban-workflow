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

type TicketContext = {
  id: string;
  title?: string;
  body?: string;
  url?: string;
  comments: Array<{ at?: string; author?: string; body?: string; internal?: boolean }>;
  attachments: Array<{ name?: string; url?: string }>;
  links: Array<{ id?: string; title?: string; url?: string; relation?: string }>;
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

export function makeSessionId(ticketId: string, _now: Date): string {
  const clean = ticketId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
  return `kanban-workflow-worker-${clean}`;
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

function extractTicketContext(payload: any, fallbackTicketId: string): TicketContext {
  const item = payload?.item ?? {};
  const commentsRaw: any[] = Array.isArray(payload?.comments) ? payload.comments : [];
  const attachmentsRaw: any[] = Array.isArray(item?.attachments) ? item.attachments : [];
  const linksRaw: any[] = Array.isArray(item?.linked) ? item.linked : [];

  return {
    id: String(item?.id ?? fallbackTicketId),
    title: item?.title ? String(item.title) : undefined,
    body: item?.body ? String(item.body) : undefined,
    url: item?.url ? String(item.url) : undefined,
    comments: commentsRaw.map((c) => ({
      at: c?.createdAt ? String(c.createdAt) : undefined,
      author: c?.author ? String(c.author) : undefined,
      body: c?.body ? String(c.body) : undefined,
      internal: typeof c?.internal === 'boolean' ? c.internal : undefined,
    })),
    attachments: attachmentsRaw.map((a) => ({
      name: a?.name ? String(a.name) : undefined,
      url: a?.url ? String(a.url) : undefined,
    })),
    links: linksRaw.map((l) => ({
      id: l?.id ? String(l.id) : undefined,
      title: l?.title ? String(l.title) : undefined,
      url: l?.url ? String(l.url) : undefined,
      relation: l?.relation ? String(l.relation) : undefined,
    })),
  };
}

function buildWorkInstruction(ticketId: string, payload: any): string {
  const context = extractTicketContext(payload, ticketId);
  const contextJson = JSON.stringify(context, null, 2);

  return [
    `DO WORK NOW on ticket ${ticketId}.`,
    'Use the context JSON below as the single source of truth for this turn.',
    '',
    'You must end this turn with exactly one command:',
    '- kanban-workflow continue --text "<status update + next steps>"',
    '- kanban-workflow blocked --text "<blocker reason + concrete ask>"',
    '- kanban-workflow completed --result "<what was finished>"',
    '',
    'CONTEXT_JSON',
    contextJson,
  ].join('\n');
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
  const activeTicketPayload = output?.nextTicket;
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
        text: buildWorkInstruction(nextTicketId, output?.nextTicket),
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
      text: buildWorkInstruction(currentTicketId, activeTicketPayload),
    });
    return { map, actions, activeTicketId: currentTicketId };
  }

  if (tickKind === 'no_work') {
    map.active = undefined;
  }

  return { map, actions, activeTicketId: null };
}

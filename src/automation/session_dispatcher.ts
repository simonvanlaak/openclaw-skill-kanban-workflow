import * as fs from 'node:fs/promises';

export const DEFAULT_SESSION_MAP_PATH = '.tmp/kwf-session-map.json';

export type SessionEntry = {
  sessionId: string;
  sessionLabel?: string;
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
  sessionLabel?: string;
  ticketId: string;
  text: string;
};

export type WorkerCommandResult =
  | { kind: 'continue'; text: string }
  | { kind: 'blocked'; text: string }
  | { kind: 'completed'; result: string };

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

export function makeSessionId(ticketId: string, _now: Date, ticketTitle?: string): string {
  const cleanId = ticketId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40);
  const slug = (ticketTitle ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  return slug ? `kanban-workflow-worker-${cleanId}-${slug}` : `kanban-workflow-worker-${cleanId}`;
}

export function makeSessionLabel(ticketId: string, ticketTitle?: string): string {
  const cleanTitle = (ticketTitle ?? '').replace(/\s+/g, ' ').trim();
  return cleanTitle ? `${ticketId} ${cleanTitle}` : ticketId;
}

function ensureSessionForTicket(
  map: SessionMap,
  ticketId: string,
  nowIso: string,
  ticketTitle?: string,
): { sessionId: string; sessionLabel: string; reused: boolean } {
  const existing = map.sessionsByTicket[ticketId];
  const sessionLabel = ticketTitle
    ? makeSessionLabel(ticketId, ticketTitle)
    : existing?.sessionLabel || makeSessionLabel(ticketId, ticketTitle);
  if (existing && !existing.closedAt) {
    existing.lastState = 'in_progress';
    existing.lastSeenAt = nowIso;
    existing.sessionLabel = sessionLabel;
    map.active = { ticketId, sessionId: existing.sessionId };
    return { sessionId: existing.sessionId, sessionLabel, reused: true };
  }

  const active = map.active;
  if (active && active.ticketId === ticketId) {
    const activeEntry = map.sessionsByTicket[ticketId];
    if (activeEntry) activeEntry.sessionLabel = sessionLabel;
    return { sessionId: active.sessionId, sessionLabel, reused: true };
  }

  const sessionId = makeSessionId(ticketId, new Date(nowIso), ticketTitle);
  map.sessionsByTicket[ticketId] = {
    sessionId,
    sessionLabel,
    lastState: 'in_progress',
    lastSeenAt: nowIso,
  };
  map.active = { ticketId, sessionId };
  return { sessionId, sessionLabel, reused: false };
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

export function applyWorkerCommandToSessionMap(
  map: SessionMap,
  ticketId: string,
  command: WorkerCommandResult,
  now: Date,
): SessionMap {
  const nowIso = now.toISOString();
  const entry = map.sessionsByTicket[ticketId];
  if (!entry) return map;

  entry.lastSeenAt = nowIso;
  if (command.kind === 'continue') {
    entry.lastState = 'in_progress';
    delete entry.closedAt;
    map.active = { ticketId, sessionId: entry.sessionId };
    return map;
  }

  entry.lastState = command.kind;
  entry.closedAt = nowIso;
  if (map.active?.ticketId === ticketId) {
    map.active = undefined;
  }
  return map;
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

function buildWorkInstruction(ticketId: string, payload: any, sessionLabel: string): string {
  const context = extractTicketContext(payload, ticketId);
  const contextJson = JSON.stringify(context, null, 2);

  return [
    `DO WORK NOW on ticket ${ticketId}.`,
    `Session label: ${sessionLabel}`,
    'Use the context JSON below as the single source of truth for this turn.',
    '',
    'Execution contract (mandatory):',
    '- Perform at least one concrete execution step this turn (tool call, command, or file/code change), unless truly blocked by external dependency.',
    '- Include an EVIDENCE section before your final command with:',
    '  - what was executed,',
    '  - key result/output,',
    '  - changed files (if any).',
    '- If no concrete execution happened, do NOT use continue. Use blocked instead.',
    '',
    'You must end this turn with exactly one command (final line):',
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
        sessionLabel: finalized.sessionLabel,
        ticketId: tick.id,
        text: `Ticket ${tick.id} transitioned to ${tickKind}. Wrap up this thread and stop active execution for this ticket.`,
      });
    }

    if (nextTicketId) {
      const nextTicketTitle = output?.nextTicket?.item?.title ? String(output.nextTicket.item.title) : undefined;
      const { sessionId, sessionLabel } = ensureSessionForTicket(map, nextTicketId, nowIso, nextTicketTitle);
      actions.push({
        kind: 'work',
        sessionId,
        sessionLabel,
        ticketId: nextTicketId,
        text: buildWorkInstruction(nextTicketId, output?.nextTicket, sessionLabel),
      });
      return { map, actions, activeTicketId: nextTicketId };
    }

    return { map, actions, activeTicketId: null };
  }

  if (currentTicketId) {
    const currentTicketTitle = activeTicketPayload?.item?.title ? String(activeTicketPayload.item.title) : undefined;
    const { sessionId, sessionLabel } = ensureSessionForTicket(map, currentTicketId, nowIso, currentTicketTitle);
    actions.push({
      kind: 'work',
      sessionId,
      sessionLabel,
      ticketId: currentTicketId,
      text: buildWorkInstruction(currentTicketId, activeTicketPayload, sessionLabel),
    });
    return { map, actions, activeTicketId: currentTicketId };
  }

  if (tickKind === 'no_work') {
    map.active = undefined;
  }

  return { map, actions, activeTicketId: null };
}

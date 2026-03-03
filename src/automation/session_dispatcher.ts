import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SESSION_MAP_PATH = '.tmp/kwf-session-map.json';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKER_AGENT_MD_PATH = path.resolve(MODULE_DIR, '..', '..', 'WORKER.md');

function loadWorkerAgentGuide(): string | null {
  const overridePath = process.env.KWF_WORKER_AGENT_MD_PATH?.trim();
  const guidePath = overridePath ? path.resolve(overridePath) : DEFAULT_WORKER_AGENT_MD_PATH;

  try {
    const raw = fsSync.readFileSync(guidePath, 'utf8').trim();
    if (!raw) return null;
    return raw;
  } catch {
    return null;
  }
}

export type SessionEntry = {
  sessionId: string;
  sessionLabel?: string;
  lastState: 'in_progress' | 'blocked' | 'completed' | 'no_work';
  lastSeenAt: string;
  closedAt?: string;
  continueCount?: number;
};

export type SessionMap = {
  version: 1;
  active?: { ticketId: string; sessionId: string };
  noWork?: {
    streakStartedAt: string;
    lastSeenAt: string;
    reasonCode?: string;
    firstHitAlertSentAt?: string;
    firstHitAlertChannel?: string;
    firstHitAlertTarget?: string;
  };
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

export type WorkflowLoopPlan = {
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
    const noWork =
      parsed.noWork && typeof parsed.noWork === 'object' && typeof parsed.noWork.streakStartedAt === 'string'
        ? {
            streakStartedAt: parsed.noWork.streakStartedAt,
            lastSeenAt:
              typeof parsed.noWork.lastSeenAt === 'string' && parsed.noWork.lastSeenAt.trim()
                ? parsed.noWork.lastSeenAt
                : parsed.noWork.streakStartedAt,
            reasonCode: typeof parsed.noWork.reasonCode === 'string' ? parsed.noWork.reasonCode : undefined,
            firstHitAlertSentAt:
              typeof parsed.noWork.firstHitAlertSentAt === 'string' ? parsed.noWork.firstHitAlertSentAt : undefined,
            firstHitAlertChannel:
              typeof parsed.noWork.firstHitAlertChannel === 'string' ? parsed.noWork.firstHitAlertChannel : undefined,
            firstHitAlertTarget:
              typeof parsed.noWork.firstHitAlertTarget === 'string' ? parsed.noWork.firstHitAlertTarget : undefined,
          }
        : undefined;

    return {
      version: 1,
      active:
        parsed.active && typeof parsed.active.ticketId === 'string' && typeof parsed.active.sessionId === 'string'
          ? { ticketId: parsed.active.ticketId, sessionId: parsed.active.sessionId }
          : undefined,
      noWork,
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

function sanitizeSessionToken(raw: string): string {
  return raw
    .trim()
    .replace(/^kanban-workflow-worker[-_:]*/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 64);
}

function extractIssueKey(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match = text.toUpperCase().match(/\b[A-Z][A-Z0-9]+-\d+\b/);
  return match?.[0];
}

function looksOpaqueTicketId(ticketId: string): boolean {
  const trimmed = ticketId.trim();
  if (!trimmed) return true;

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)) {
    return true;
  }

  if (trimmed.length >= 24 && /^[a-z0-9-]+$/i.test(trimmed)) {
    return true;
  }

  return false;
}

function looksLegacyWorkerSessionId(sessionId: string): boolean {
  const trimmed = sessionId.trim();
  if (!trimmed) return true;
  if (/^(main|default)$/i.test(trimmed)) return true;
  if (/(^|[-_:])(main|default)$/i.test(trimmed)) return true;
  if (/^kanban-workflow-worker[-_:]/i.test(trimmed)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)) return true;
  return false;
}

export function makeSessionId(ticketId: string, now: Date, _ticketTitle?: string, sessionDisplayId?: string): string {
  const preferred = sanitizeSessionToken(sessionDisplayId ?? '');
  if (preferred) return preferred;

  const fallback = sanitizeSessionToken(ticketId);
  if (fallback) return fallback;

  return `ticket-${now.getTime()}`;
}

export function makeSessionLabel(sessionDisplayId: string, ticketTitle?: string): string {
  const cleanTitle = (ticketTitle ?? '').replace(/\s+/g, ' ').trim();
  return cleanTitle ? `${sessionDisplayId} ${cleanTitle}` : sessionDisplayId;
}

function ensureSessionForTicket(
  map: SessionMap,
  ticketId: string,
  nowIso: string,
  ticketTitle?: string,
  sessionDisplayId?: string,
): { sessionId: string; sessionLabel: string; reused: boolean } {
  const existing = map.sessionsByTicket[ticketId];
  const effectiveDisplayId = sessionDisplayId || ticketId;
  const preferredSessionId = makeSessionId(ticketId, new Date(nowIso), ticketTitle, effectiveDisplayId);
  const sessionLabel = ticketTitle
    ? makeSessionLabel(effectiveDisplayId, ticketTitle)
    : existing?.sessionLabel || makeSessionLabel(effectiveDisplayId, ticketTitle);

  if (existing && !existing.closedAt) {
    let sessionId = existing.sessionId;
    const shouldUpgradeLegacyId =
      preferredSessionId !== sessionId &&
      looksLegacyWorkerSessionId(sessionId) &&
      !!sanitizeSessionToken(effectiveDisplayId) &&
      !!extractIssueKey(effectiveDisplayId);

    if (shouldUpgradeLegacyId) {
      sessionId = preferredSessionId;
      existing.sessionId = sessionId;
    }

    existing.lastState = 'in_progress';
    existing.lastSeenAt = nowIso;
    existing.sessionLabel = sessionLabel;
    map.active = { ticketId, sessionId };
    return { sessionId, sessionLabel, reused: !shouldUpgradeLegacyId };
  }

  const active = map.active;
  if (active && active.ticketId === ticketId) {
    const activeEntry = map.sessionsByTicket[ticketId];
    if (activeEntry) activeEntry.sessionLabel = sessionLabel;
    return { sessionId: active.sessionId, sessionLabel, reused: true };
  }

  const sessionId = preferredSessionId;
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
  if (state === 'completed') {
    entry.closedAt = nowIso;
  } else {
    delete entry.closedAt;
  }
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
    entry.continueCount = (entry.continueCount ?? 0) + 1;
    delete entry.closedAt;
    map.active = { ticketId, sessionId: entry.sessionId };
    return map;
  }

  entry.lastState = command.kind;
  if (command.kind === 'completed') {
    entry.closedAt = nowIso;
  } else {
    delete entry.closedAt;
  }
  if (map.active?.ticketId === ticketId) {
    map.active = undefined;
  }
  return map;
}

function normalizeCommentAuthor(author: unknown): string | undefined {
  if (author == null) return undefined;
  if (typeof author === 'string') return author;

  if (typeof author === 'object') {
    const a = author as Record<string, unknown>;
    const candidates = [a.display_name, a.displayName, a.name, a.username, a.email, a.id];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.trim();
    }

    const nested = a.member;
    if (nested && typeof nested === 'object') {
      const n = nested as Record<string, unknown>;
      const nestedCandidates = [n.display_name, n.displayName, n.name, n.username, n.email, n.id];
      for (const c of nestedCandidates) {
        if (typeof c === 'string' && c.trim()) return c.trim();
      }
    }

    return JSON.stringify(a);
  }

  return String(author);
}

function extractIssueKeyLinks(text: string | undefined): Array<{ title: string; relation: string }> {
  if (!text) return [];
  const matches = text.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? [];
  const unique = [...new Set(matches)];
  return unique.map((k) => ({ title: k, relation: 'mentioned' }));
}

function extractTicketContext(payload: any, fallbackTicketId: string): TicketContext {
  const item = payload?.item ?? {};
  const commentsRaw: any[] = Array.isArray(payload?.comments) ? payload.comments : [];
  const attachmentsRaw: any[] = Array.isArray(item?.attachments) ? item.attachments : [];
  const linksRaw: any[] = [
    ...(Array.isArray(item?.linked) ? item.linked : []),
    ...(Array.isArray(item?.links) ? item.links : []),
    ...(Array.isArray(payload?.links) ? payload.links : []),
  ];

  const comments = commentsRaw.map((c) => ({
    at: c?.createdAt ? String(c.createdAt) : undefined,
    author: normalizeCommentAuthor(c?.author),
    body: c?.body ? String(c.body) : undefined,
    internal: typeof c?.internal === 'boolean' ? c.internal : undefined,
  }));

  const explicitLinks = linksRaw.map((l) => ({
    id: l?.id ? String(l.id) : undefined,
    title: l?.title ? String(l.title) : undefined,
    url: l?.url ? String(l.url) : undefined,
    relation: l?.relation ? String(l.relation) : undefined,
  }));

  const inferredFromBody = extractIssueKeyLinks(item?.body ? String(item.body) : undefined);
  const inferredFromComments = comments.flatMap((c) => extractIssueKeyLinks(c.body));
  const inferred = [...inferredFromBody, ...inferredFromComments].map((l) => ({
    ...l,
    url: undefined,
  }));

  const seen = new Set<string>();
  const mergedLinks = [...explicitLinks, ...inferred]
    .filter((l) => {
      const key = `${l.title ?? ''}|${l.url ?? ''}|${l.relation ?? ''}`;
      if (!key.trim() || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return {
    id: String(item?.id ?? fallbackTicketId),
    title: item?.title ? String(item.title) : undefined,
    body: item?.body ? String(item.body) : undefined,
    url: item?.url ? String(item.url) : undefined,
    comments,
    attachments: attachmentsRaw.map((a) => ({
      name: a?.name ? String(a.name) : undefined,
      url: a?.url ? String(a.url) : undefined,
    })),
    links: mergedLinks,
  };
}

function resolveSessionDisplayId(ticketId: string, payload: any): string {
  const ticketMatch = extractIssueKey(ticketId);
  if (ticketMatch) return ticketMatch;

  if (!looksOpaqueTicketId(ticketId)) return ticketId;

  const item = payload?.item ?? {};
  const directCandidates = [
    item?.identifier,
    item?.issueIdentifier,
    item?.issue_identifier,
    item?.issueKey,
    item?.issue_key,
    item?.key,
    item?.reference,
    item?.displayId,
    item?.display_id,
    item?.title,
  ];

  for (const candidate of directCandidates) {
    const key = extractIssueKey(candidate != null ? String(candidate) : undefined);
    if (key) return key;
  }

  const context = extractTicketContext(payload, ticketId);
  const contextCandidates = [
    context.id,
    context.title,
    context.body,
    ...context.links.map((l) => l.title),
    ...context.links.map((l) => l.id),
    ...context.links.map((l) => l.url),
  ];

  for (const candidate of contextCandidates) {
    const key = extractIssueKey(candidate != null ? String(candidate) : undefined);
    if (key) return key;
  }

  return ticketId;
}

function buildWorkInstruction(ticketId: string, payload: any, sessionLabel: string): string {
  const context = extractTicketContext(payload, ticketId);
  const contextJson = JSON.stringify(context, null, 2);
  const workerAgentGuide = loadWorkerAgentGuide();

  return [
    `DO WORK NOW on ticket ${ticketId}.`,
    `Session label: ${sessionLabel}`,
    ...(workerAgentGuide
      ? [
          '',
          'WORKER_AGENT_MD (mandatory instructions loaded at task start):',
          workerAgentGuide,
        ]
      : []),
    '',
    'Use the context JSON below as the single source of truth for this turn.',
    '',
    'Execution contract (mandatory):',
    '- Perform at least one concrete execution step this turn (tool call, command, or file/code change), unless truly blocked by external dependency.',
    '- Respond with a markdown report only (no terminal commands).',
    '- Include required facts in the report:',
    '  - verification evidence',
    '  - blockers with status (open/resolved)',
    '  - uncertainties',
    '  - confidence (0.0..1.0)',
    '- Do not post boilerplate progress spam. Report only evidence-backed updates.',
    '',
    'CONTEXT_JSON',
    contextJson,
  ].join('\n');
}

export function buildWorkflowLoopPlan(params: {
  autopilotOutput: any;
  previousMap: SessionMap;
  now: Date;
}): WorkflowLoopPlan {
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

  if (tickKind !== 'no_work') {
    map.noWork = undefined;
  }

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
      const nextTicketDisplayId = resolveSessionDisplayId(nextTicketId, output?.nextTicket);
      const { sessionId, sessionLabel } = ensureSessionForTicket(
        map,
        nextTicketId,
        nowIso,
        nextTicketTitle,
        nextTicketDisplayId,
      );
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
    const currentTicketDisplayId = resolveSessionDisplayId(currentTicketId, activeTicketPayload);
    const { sessionId, sessionLabel } = ensureSessionForTicket(
      map,
      currentTicketId,
      nowIso,
      currentTicketTitle,
      currentTicketDisplayId,
    );
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
    const previousNoWork = map.noWork;
    map.noWork = {
      streakStartedAt: previousNoWork?.streakStartedAt ?? nowIso,
      lastSeenAt: nowIso,
      reasonCode: typeof tick?.reasonCode === 'string' ? tick.reasonCode : undefined,
      firstHitAlertSentAt: previousNoWork?.firstHitAlertSentAt,
      firstHitAlertChannel: previousNoWork?.firstHitAlertChannel,
      firstHitAlertTarget: previousNoWork?.firstHitAlertTarget,
    };
  }

  return { map, actions, activeTicketId: null };
}

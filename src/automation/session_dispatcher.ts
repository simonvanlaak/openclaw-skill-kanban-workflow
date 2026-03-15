import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKER_RESULT_JSON_SCHEMA_CONTRACT } from '../workflow/worker_result.js';

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
  lastState: 'queued' | 'reserved' | 'in_progress' | 'blocked' | 'completed' | 'no_work';
  lastSeenAt: string;
  workStartedAt?: string;
  closedAt?: string;
  continueCount?: number;
};

export type SessionMap = {
  version: 1;
  active?: { ticketId: string; sessionId: string };
  queuePosition?: {
    commentsByTicket: Record<string, { commentId: string; higherPriorityCount: number; lastSeenAt?: string; templateVersion?: number }>;
    recentCompletionDurationsMs?: number[];
    lastReconciledAt?: string;
  };
  noWork?: {
    streakStartedAt: string;
    lastSeenAt: string;
    reasonCode?: string;
    firstHitAlertSentAt?: string;
    firstHitAlertChannel?: string;
    firstHitAlertTarget?: string;
  };
  rocketChatStatus?: {
    lastMessage?: string;
    lastUpdatedAt?: string;
    lastError?: string;
  };
  sessionsByTicket: Record<string, SessionEntry>;
};

export type DispatchAction = {
  kind: 'work';
  sessionId: string;
  sessionLabel?: string;
  ticketId: string;
  projectId?: string;
  text: string;
};

export type WorkerCommandResult =
  | { kind: 'continue'; text: string }
  | { kind: 'blocked'; text: string }
  | { kind: 'uncertain'; text: string }
  | { kind: 'completed'; result: string };

type TicketContext = {
  id: string;
  projectId?: string;
  title?: string;
  body?: string;
  url?: string;
  comments: Array<{ at?: string; author?: string; authorId?: string; authorName?: string; body?: string; internal?: boolean }>;
  attachments: Array<{ name?: string; url?: string }>;
  links: Array<{ id?: string; title?: string; url?: string; relation?: string }>;
  potentialDuplicates: Array<{
    id?: string;
    identifier?: string;
    title?: string;
    url?: string;
    stage?: string;
    score?: number;
  }>;
};

const VERIFICATION_HARNESS_DIGEST = [
  'VERIFICATION_HARNESS (mandatory before completed/in-review):',
  '- First prove the issue/gap exists (red), then define the acceptance test, then implement, then rerun the test (green).',
  '- Completed work must include concrete evidence, not "probably done" language.',
  '- For non-technical work, acceptable evidence includes checklists, stable links, diffs, screenshots, stakeholder confirmations, and measurements.',
  '- If verification cannot be performed, return decision="blocked" with the exact missing dependency.',
  '- Optional reusable probes: /root/.openclaw/workspace/skills/kanban-workflow/scripts/verification_primitives.sh {http-status|file-exists|file-contains|diff-changed|metric-threshold} ...',
].join('\n');

const WORKER_POLICY_DIGEST = [
  'WORKER_POLICY_DIGEST (resume turn):',
  '- Execute at least one concrete step this turn unless truly blocked.',
  '- Reply with strict JSON only.',
  '- Follow WORKER_RESULT_JSON_SCHEMA_CONTRACT exactly.',
  '- Plane CLI: always start with: source /root/.openclaw/workspace/scripts/plane_env.sh',
  '- Before implementation, scan potentialDuplicates and sanity-check for duplicates.',
  '- If unsure and clarification is needed, use decision="uncertain" with clarification_questions.',
  '- Keep output concise and evidence-backed; avoid boilerplate.',
  '',
  VERIFICATION_HARNESS_DIGEST,
].join('\n');

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

    const rocketChatStatus =
      parsed.rocketChatStatus && typeof parsed.rocketChatStatus === 'object'
        ? {
            lastMessage:
              typeof parsed.rocketChatStatus.lastMessage === 'string' ? parsed.rocketChatStatus.lastMessage : undefined,
            lastUpdatedAt:
              typeof parsed.rocketChatStatus.lastUpdatedAt === 'string' ? parsed.rocketChatStatus.lastUpdatedAt : undefined,
            lastError: typeof parsed.rocketChatStatus.lastError === 'string' ? parsed.rocketChatStatus.lastError : undefined,
          }
        : undefined;

    const queuePosition =
      parsed.queuePosition && typeof parsed.queuePosition === 'object'
        ? {
            commentsByTicket:
              parsed.queuePosition.commentsByTicket && typeof parsed.queuePosition.commentsByTicket === 'object'
                ? parsed.queuePosition.commentsByTicket
                : {},
            recentCompletionDurationsMs:
              Array.isArray(parsed.queuePosition.recentCompletionDurationsMs)
                ? parsed.queuePosition.recentCompletionDurationsMs
                    .map((v: unknown) => Number(v))
                    .filter((v: number) => Number.isFinite(v) && v > 0)
                : [],
            lastReconciledAt:
              typeof parsed.queuePosition.lastReconciledAt === 'string'
                ? parsed.queuePosition.lastReconciledAt
                : undefined,
          }
        : undefined;

    const map: SessionMap = {
      version: 1,
      active:
        parsed.active && typeof parsed.active.ticketId === 'string' && typeof parsed.active.sessionId === 'string'
          ? { ticketId: parsed.active.ticketId, sessionId: parsed.active.sessionId }
          : undefined,
      noWork,
      queuePosition,
      rocketChatStatus,
      sessionsByTicket,
    };

    // One-time migration on load:
    // rewrite legacy worker session ids (main/default/old prefixes) to deterministic per-ticket ids.
    for (const [ticketId, entry] of Object.entries(map.sessionsByTicket ?? {})) {
      if (!entry || typeof entry !== 'object') continue;
      const currentSessionId = String((entry as any).sessionId ?? '').trim();
      if (!currentSessionId) continue;
      if (!looksLegacyWorkerSessionId(currentSessionId)) continue;
      const migrated = sanitizeSessionToken(ticketId);
      if (!migrated) continue;
      (entry as any).sessionId = migrated;
      if (map.active?.ticketId === ticketId) {
        map.active = { ticketId, sessionId: migrated };
      }
    }

    // Also normalize active if it still points to a legacy id and ticket is known.
    if (map.active?.ticketId && looksLegacyWorkerSessionId(map.active.sessionId)) {
      const fallback = sanitizeSessionToken(map.active.ticketId);
      if (fallback) {
        map.active = { ticketId: map.active.ticketId, sessionId: fallback };
        const activeEntry = map.sessionsByTicket[map.active.ticketId] as any;
        if (activeEntry && typeof activeEntry === 'object') {
          activeEntry.sessionId = fallback;
        }
      }
    }

    return map;
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

  // Prefer the human-readable issue key for session naming, e.g. JULES-243.
  // If we cannot resolve it, fall back to the opaque ticket id.
  const effectiveDisplayId = (sessionDisplayId ?? '').trim() || ticketId;

  const preferredSessionId = makeSessionId(ticketId, new Date(nowIso), ticketTitle, effectiveDisplayId);
  const sessionLabel = ticketTitle
    ? makeSessionLabel(effectiveDisplayId, ticketTitle)
    : existing?.sessionLabel || makeSessionLabel(effectiveDisplayId, ticketTitle);

  if (existing && !existing.closedAt) {
    const previousState = existing.lastState;
    let sessionId = existing.sessionId;

    const matchesIssueKey = (value: string): { project: string; seq: string } | null => {
      const m = value.match(/^([a-z][a-z0-9]+)-(\d+)$/i);
      if (!m) return null;
      return { project: m[1].toLowerCase(), seq: m[2] };
    };

    const preferredKey = matchesIssueKey(preferredSessionId);
    const existingKey = matchesIssueKey(sessionId);

    const shouldUpgradeToPreferred =
      preferredSessionId !== sessionId &&
      !!sanitizeSessionToken(effectiveDisplayId) &&
      (
        looksLegacyWorkerSessionId(sessionId) ||
        looksOpaqueTicketId(sessionId) ||
        sessionId === sanitizeSessionToken(ticketId) ||
        sessionId.startsWith('ticket-') ||
        // If we previously extracted the wrong issue key from free text (e.g. an example like JULES-243),
        // but we can now resolve the canonical identifier (e.g. JULES-248), upgrade the session id.
        (preferredKey != null && existingKey != null && preferredKey.project === existingKey.project && preferredKey.seq !== existingKey.seq)
      );

    if (shouldUpgradeToPreferred) {
      sessionId = preferredSessionId;
      existing.sessionId = sessionId;
    }

    existing.lastState = previousState === 'in_progress' ? 'in_progress' : 'reserved';
    existing.lastSeenAt = nowIso;
    if (!((previousState === 'in_progress' || previousState === 'reserved') && existing.workStartedAt)) {
      existing.workStartedAt = nowIso;
    }
    existing.sessionLabel = sessionLabel;
    map.active = { ticketId, sessionId };
    return { sessionId, sessionLabel, reused: !shouldUpgradeToPreferred };
  }

  const active = map.active;
  if (active && active.ticketId === ticketId) {
    const matchesIssueKey = (value: string): { project: string; seq: string } | null => {
      const m = value.match(/^([a-z][a-z0-9]+)-(\d+)$/i);
      if (!m) return null;
      return { project: m[1].toLowerCase(), seq: m[2] };
    };

    const preferredKey = matchesIssueKey(preferredSessionId);
    const activeKey = matchesIssueKey(active.sessionId);

    const shouldUpgradeActiveId =
      preferredSessionId !== active.sessionId &&
      !!sanitizeSessionToken(effectiveDisplayId) &&
      (
        looksLegacyWorkerSessionId(active.sessionId) ||
        looksOpaqueTicketId(active.sessionId) ||
        active.sessionId === sanitizeSessionToken(ticketId) ||
        active.sessionId.startsWith('ticket-') ||
        (preferredKey != null && activeKey != null && preferredKey.project === activeKey.project && preferredKey.seq !== activeKey.seq)
      );

    const resolvedActiveSessionId = shouldUpgradeActiveId ? preferredSessionId : active.sessionId;
    map.active = { ticketId, sessionId: resolvedActiveSessionId };

    const activeEntry = map.sessionsByTicket[ticketId];
    if (activeEntry) {
      activeEntry.sessionLabel = sessionLabel;
      activeEntry.sessionId = resolvedActiveSessionId;
      activeEntry.lastState = activeEntry.lastState === 'in_progress' ? 'in_progress' : 'reserved';
      activeEntry.lastSeenAt = nowIso;
      if (!activeEntry.workStartedAt) activeEntry.workStartedAt = nowIso;
      return { sessionId: resolvedActiveSessionId, sessionLabel, reused: !shouldUpgradeActiveId };
    }

    map.sessionsByTicket[ticketId] = {
      sessionId: resolvedActiveSessionId,
      sessionLabel,
      lastState: 'reserved',
      lastSeenAt: nowIso,
      workStartedAt: nowIso,
    };
    return { sessionId: resolvedActiveSessionId, sessionLabel, reused: !shouldUpgradeActiveId };
  }

  const sessionId = preferredSessionId;
  map.sessionsByTicket[ticketId] = {
    sessionId,
    sessionLabel,
    lastState: 'reserved',
    lastSeenAt: nowIso,
    workStartedAt: nowIso,
  };
  map.active = { ticketId, sessionId };
  return { sessionId, sessionLabel, reused: false };
}

export function markSessionInProgress(
  map: SessionMap,
  ticketId: string,
  now: Date,
): SessionMap {
  const entry = map.sessionsByTicket[ticketId];
  if (!entry) return map;

  const nowIso = now.toISOString();
  entry.lastState = 'in_progress';
  entry.lastSeenAt = nowIso;
  if (!entry.workStartedAt) {
    entry.workStartedAt = nowIso;
  }
  map.active = { ticketId, sessionId: entry.sessionId };
  return map;
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
    if (!entry.workStartedAt) entry.workStartedAt = nowIso;
    delete entry.closedAt;
    map.active = { ticketId, sessionId: entry.sessionId };
    return map;
  }

  entry.lastState = command.kind === 'uncertain' ? 'blocked' : command.kind;
  if (command.kind === 'completed') {
    entry.closedAt = nowIso;
  } else {
    delete entry.closedAt;
    delete entry.workStartedAt;
  }
  if (map.active?.ticketId === ticketId) {
    map.active = undefined;
  }
  return map;
}

function normalizeCommentAuthor(author: unknown): { id?: string; name?: string } | undefined {
  if (author == null) return undefined;
  if (typeof author === 'string') {
    const value = author.trim();
    if (!value) return undefined;
    return { id: value, name: value };
  }

  if (typeof author === 'object') {
    const a = author as Record<string, unknown>;
    const idCandidates = [a.id, a.user_id, a.userId];
    const nameCandidates = [a.display_name, a.displayName, a.name, a.username, a.email];
    const nested = a.member && typeof a.member === 'object' ? (a.member as Record<string, unknown>) : undefined;
    const nestedIdCandidates = nested ? [nested.id, nested.user_id, nested.userId] : [];
    const nestedNameCandidates = nested ? [nested.display_name, nested.displayName, nested.name, nested.username, nested.email] : [];

    const firstText = (values: unknown[]): string | undefined => {
      for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
      return undefined;
    };

    const id = firstText([...idCandidates, ...nestedIdCandidates]);
    const name = firstText([...nameCandidates, ...nestedNameCandidates, ...idCandidates, ...nestedIdCandidates]);
    if (id || name) return { id, name };
    return { name: JSON.stringify(a) };
  }

  const fallback = String(author).trim();
  if (!fallback) return undefined;
  return { id: fallback, name: fallback };
}

function extractIssueKeyLinks(text: string | undefined): Array<{ title: string; relation: string }> {
  if (!text) return [];
  const matches = text.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? [];
  const unique = [...new Set(matches)];
  return unique.map((k) => ({ title: k, relation: 'mentioned' }));
}

function asIso(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function trimForPrompt(text: string, maxChars: number): string {
  const t = String(text ?? '');
  if (t.length <= maxChars) return t;
  return `${t.slice(0, Math.max(0, maxChars - 40))}\n\n[TRUNCATED: ${t.length} chars total]`;
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

  const potentialDuplicatesRaw: any[] = Array.isArray(payload?.potentialDuplicates)
    ? payload.potentialDuplicates
    : Array.isArray(payload?.similarTickets)
      ? payload.similarTickets
      : [];

  const comments = commentsRaw.map((c) => {
    const author = normalizeCommentAuthor(c?.author);
    return {
      at: asIso(c?.createdAt),
      author: author?.name ?? author?.id,
      authorId: author?.id,
      authorName: author?.name,
      body: c?.body ? trimForPrompt(String(c.body), 1600) : undefined,
      internal: typeof c?.internal === 'boolean' ? c.internal : undefined,
    };
  });

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

  const potentialDuplicates = potentialDuplicatesRaw
    .map((d) => ({
      id: d?.id != null ? String(d.id) : undefined,
      identifier: d?.identifier != null ? String(d.identifier) : undefined,
      title: d?.title != null ? String(d.title) : undefined,
      url: d?.url != null ? String(d.url) : undefined,
      stage: d?.stage != null ? String(d.stage) : undefined,
      score: typeof d?.score === 'number' && Number.isFinite(d.score) ? d.score : undefined,
    }))
    .filter((d) => Boolean(d.id || d.identifier || d.title || d.url));

  return {
    id: String(item?.id ?? fallbackTicketId),
    projectId: item?.projectId ? String(item.projectId) : item?.project_id ? String(item.project_id) : undefined,
    title: item?.title ? String(item.title) : undefined,
    body: item?.body ? trimForPrompt(String(item.body), 5000) : undefined,
    url: item?.url ? String(item.url) : undefined,
    comments,
    attachments: attachmentsRaw.map((a) => ({
      name: a?.name ? String(a.name) : undefined,
      url: a?.url ? String(a.url) : undefined,
    })),
    links: mergedLinks,
    potentialDuplicates,
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

function compactContextForPrompt(context: TicketContext): Record<string, unknown> {
  const compact: Record<string, unknown> = {
    id: context.id,
  };
  if (context.projectId) compact.projectId = context.projectId;
  if (context.title) compact.title = context.title;
  if (context.body) compact.body = trimForPrompt(context.body, 5000);
  if (context.url) compact.url = context.url;
  if (context.comments.length > 0) compact.comments = context.comments;
  if (context.attachments.length > 0) compact.attachments = context.attachments;
  if (context.links.length > 0) compact.links = context.links;
  if (context.potentialDuplicates.length > 0) compact.potentialDuplicates = context.potentialDuplicates;
  return compact;
}

function buildDeltaSinceLastTurn(context: TicketContext, previousSeenAtIso?: string): string {
  if (!previousSeenAtIso) return 'none (new session)';
  const previousMs = Date.parse(previousSeenAtIso);
  if (!Number.isFinite(previousMs)) return 'none';

  const newComments = context.comments
    .filter((c) => {
      const atMs = Date.parse(String(c.at ?? ''));
      return Number.isFinite(atMs) && atMs > previousMs;
    })
    .slice(0, 3)
    .map((c, idx) => `${idx + 1}. [${c.at ?? 'unknown-time'}] ${c.authorName ?? c.authorId ?? c.author ?? 'unknown'}: ${c.body ?? ''}`);

  if (newComments.length === 0) return 'none';
  return newComments.join('\n');
}

function buildWorkInstruction(params: {
  ticketId: string;
  sessionDisplayId: string;
  payload: any;
  sessionLabel: string;
  includeFullGuide: boolean;
  previousSeenAtIso?: string;
}): string {
  const context = extractTicketContext(params.payload, params.ticketId);
  const contextJson = JSON.stringify(compactContextForPrompt(context), null, 2);
  const delta = buildDeltaSinceLastTurn(context, params.previousSeenAtIso);
  const workerAgentGuide = loadWorkerAgentGuide();

  return [
    `Ticket: ${params.sessionDisplayId} (${params.ticketId})`,
    `Goal: ${context.title ?? 'Continue assigned ticket execution.'}`,
    `Session label: ${params.sessionLabel}`,
    'Expected output: strict JSON result for forced decision (blocked|completed|uncertain).',
    '',
    'PREWORK (reduce duplicates):',
    '- Before doing implementation, search for similar Plane tickets by keywords from title/body.',
    '- Use CONTEXT_JSON.potentialDuplicates as a starting point, but verify in Plane.',
    '',
    'DELTA_SINCE_LAST_TURN',
    delta,
    ...(params.includeFullGuide && workerAgentGuide
      ? [
          '',
          'WORKER_AGENT_MD (mandatory instructions loaded at task start):',
          workerAgentGuide,
        ]
      : ['', WORKER_POLICY_DIGEST]),
    '',
    'Use the context JSON below as the single source of truth for this turn.',
    '',
    'Execution contract (mandatory):',
    '- Perform at least one concrete execution step this turn (tool call, command, or file/code change), unless truly blocked by external dependency.',
    '- Respond with JSON only (no markdown wrapper, no code fences).',
    '- Follow the strict schema contract below exactly.',
    '- Do not post boilerplate progress spam. Report only evidence-backed updates.',
    '',
    WORKER_RESULT_JSON_SCHEMA_CONTRACT,
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
    finalizeTicket(map, tick.id, tickKind, nowIso);

    if (nextTicketId) {
      const nextTicketTitle = output?.nextTicket?.item?.title ? String(output.nextTicket.item.title) : undefined;
      const nextTicketDisplayId = resolveSessionDisplayId(nextTicketId, output?.nextTicket);
      const previousEntry = map.sessionsByTicket[nextTicketId];
      const { sessionId, sessionLabel, reused } = ensureSessionForTicket(
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
        projectId: output?.nextTicket?.item?.projectId
          ? String(output.nextTicket.item.projectId)
          : output?.nextTicket?.item?.project_id
            ? String(output.nextTicket.item.project_id)
            : undefined,
        text: buildWorkInstruction({
          ticketId: nextTicketId,
          sessionDisplayId: nextTicketDisplayId,
          payload: output?.nextTicket,
          sessionLabel,
          includeFullGuide: !reused,
          previousSeenAtIso: previousEntry?.lastSeenAt,
        }),
      });
      return { map, actions, activeTicketId: nextTicketId };
    }

    return { map, actions, activeTicketId: null };
  }

  if (currentTicketId) {
    const currentTicketTitle = activeTicketPayload?.item?.title ? String(activeTicketPayload.item.title) : undefined;
    const currentTicketDisplayId = resolveSessionDisplayId(currentTicketId, activeTicketPayload);
    const previousEntry = map.sessionsByTicket[currentTicketId];
    const { sessionId, sessionLabel, reused } = ensureSessionForTicket(
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
      projectId: activeTicketPayload?.item?.projectId
        ? String(activeTicketPayload.item.projectId)
        : activeTicketPayload?.item?.project_id
          ? String(activeTicketPayload.item.project_id)
          : undefined,
      text: buildWorkInstruction({
        ticketId: currentTicketId,
        sessionDisplayId: currentTicketDisplayId,
        payload: activeTicketPayload,
        sessionLabel,
        includeFullGuide: !reused,
        previousSeenAtIso: previousEntry?.lastSeenAt,
      }),
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

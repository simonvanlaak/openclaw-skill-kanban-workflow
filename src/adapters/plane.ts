import type { Adapter } from '../adapter.js';
import type { WorkItem } from '../models.js';
import type { ExternalLinkInput } from '../core/ports.js';

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { z } from 'zod';

import { Stage } from '../stage.js';

const PLANE_CACHE_DIR = process.env.KWF_PLANE_CACHE_DIR?.trim() || '.tmp/kwf-plane-cache';
const PLANE_CACHE_EVENT_FILE = process.env.KWF_PLANE_CACHE_EVENT_FILE?.trim() || '.tmp/kwf-plane-webhook-events.json';
const PLANE_CACHE_RECONCILE_MS = Number.parseInt(process.env.KWF_PLANE_CACHE_RECONCILE_MS ?? '900000', 10);

function parsePlaneDate(v: string): Date | undefined {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function normalizePlaneIssuesList(raw: unknown): any[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const r: any = raw;
    // Different Plane CLI/API surfaces may wrap lists.
    if (Array.isArray(r.results)) return r.results;
    if (Array.isArray(r.items)) return r.items;
    if (Array.isArray(r.data)) return r.data;
  }
  return [];
}

type PlaneIssueCache = {
  version: 1;
  projectId: string;
  refreshedAt?: string;
  updatedAt?: string;
  issuesById: Record<string, any>;
};

type PlaneCacheEventQueue = {
  version: 1;
  events: Array<{ id: string; projectId?: string; seenAt?: string }>;
};

function issueCachePath(projectId: string): string {
  return path.join(PLANE_CACHE_DIR, `${projectId}.json`);
}

function queueUniqueByIdAndProject(events: Array<{ id: string; projectId?: string; seenAt?: string }>): Array<{ id: string; projectId?: string; seenAt?: string }> {
  const out = new Map<string, { id: string; projectId?: string; seenAt?: string }>();
  for (const event of events) {
    const id = String(event?.id ?? '').trim();
    if (!id) continue;
    const projectId = String(event?.projectId ?? '').trim() || undefined;
    const key = `${projectId ?? '*'}:${id}`;
    out.set(key, {
      id,
      projectId,
      seenAt: event?.seenAt,
    });
  }
  return [...out.values()];
}

function priorityValueFromUnknown(raw: unknown): number | undefined {
  if (raw == null) return undefined;

  if (typeof raw === 'string') {
    const value = raw.trim().toLowerCase();
    if (!value) return undefined;

    const mapped: Record<string, number> = {
      urgent: 5,
      critical: 5,
      blocker: 5,
      highest: 5,
      high: 4,
      medium: 3,
      med: 3,
      normal: 3,
      low: 2,
      lowest: 1,
      none: 0,
      'no-priority': 0,
      'no priority': 0,
    };

    if (value in mapped) return mapped[value];

    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    return undefined;
  }

  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : undefined;
  }

  if (typeof raw === 'object') {
    const obj: any = raw;
    return (
      priorityValueFromUnknown(obj.name) ??
      priorityValueFromUnknown(obj.key) ??
      priorityValueFromUnknown(obj.value) ??
      priorityValueFromUnknown(obj.label)
    );
  }

  return undefined;
}

function extractPriorityFromIssue(raw: unknown): number | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const issue: any = raw;

  return (
    priorityValueFromUnknown(issue.priority) ??
    priorityValueFromUnknown(issue.priority_key) ??
    priorityValueFromUnknown(issue.priorityKey) ??
    priorityValueFromUnknown(issue.priority_value) ??
    priorityValueFromUnknown(issue.priorityValue) ??
    priorityValueFromUnknown(issue.priority_detail) ??
    priorityValueFromUnknown(issue.priorityDetail)
  );
}

function extractIssueAssigneeIds(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const issue: any = raw;
  const assignees = Array.isArray(issue.assignees) ? issue.assignees : [];
  return assignees
    .map((a: any) => {
      if (typeof a === 'string' || typeof a === 'number') return String(a);
      if (a && typeof a === 'object' && (a.id != null || a.user_id != null)) return String(a.id ?? a.user_id);
      return undefined;
    })
    .filter((x: string | undefined): x is string => typeof x === 'string' && x.trim().length > 0);
}

function idFromUnknown(raw: unknown): string | undefined {
  if (raw == null) return undefined;

  if (typeof raw === 'string' || typeof raw === 'number') {
    const out = String(raw).trim();
    return out.length > 0 ? out : undefined;
  }

  if (typeof raw === 'object') {
    const obj: any = raw;
    return (
      idFromUnknown(obj.id) ??
      idFromUnknown(obj.user_id) ??
      idFromUnknown(obj.userId) ??
      idFromUnknown(obj.uuid)
    );
  }

  return undefined;
}

function actorKeys(actor: unknown): string[] {
  if (actor == null) return [];

  const out = new Set<string>();
  const push = (value: unknown): void => {
    if (value == null) return;
    const text = String(value).trim().toLowerCase();
    if (text.length > 0) out.add(text);
  };

  if (typeof actor === 'string' || typeof actor === 'number') {
    push(actor);
    return [...out];
  }

  if (typeof actor === 'object') {
    const obj: any = actor;
    push(idFromUnknown(obj));
    push(idFromUnknown(obj.user));
    push(idFromUnknown(obj.actor));

    push(obj.username);
    push(obj.email);
    push(obj.name);
    push(obj.display_name);
    push(obj.displayName);
    push(obj.full_name);
    push(obj.fullName);
    push(obj.user?.username);
    push(obj.user?.email);
    push(obj.user?.name);
    push(obj.user?.display_name);
    push(obj.user?.displayName);
    push(obj.user?.full_name);
    push(obj.user?.fullName);
  }

  return [...out];
}

function assigneeMatchesSelf(
  assignee: string | { id?: string; username?: string; name?: string },
  me: { id?: string; username?: string; name?: string },
): boolean {
  const meKeys = new Set(actorKeys(me));
  if (meKeys.size === 0) return false;
  return actorKeys(assignee).some((k) => meKeys.has(k));
}

function extractIssueCreatorId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const issue: any = raw;

  return (
    idFromUnknown(issue.created_by) ??
    idFromUnknown(issue.createdBy) ??
    idFromUnknown(issue.created_by_id) ??
    idFromUnknown(issue.createdById) ??
    idFromUnknown(issue.created_by_detail) ??
    idFromUnknown(issue.createdByDetail)
  );
}

function extractIssueStageName(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const issue: any = raw;
  const name = issue.state?.name ?? issue.state_detail?.name ?? issue.stateDetail?.name;
  if (name == null) return undefined;
  const out = String(name).trim();
  return out.length > 0 ? out : undefined;
}

function extractIssueStateId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const issue: any = raw;

  const direct = [
    issue.state_id,
    issue.stateId,
    typeof issue.state === 'string' || typeof issue.state === 'number' ? issue.state : undefined,
    issue.state?.id,
    issue.state_detail?.id,
    issue.stateDetail?.id,
  ];

  for (const candidate of direct) {
    if (candidate == null) continue;
    const out = String(candidate).trim();
    if (out.length > 0) return out;
  }

  return undefined;
}

function extractIssueBody(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const issue: any = raw;

  const direct = [
    issue.description,
    issue.description_stripped,
    issue.descriptionStripped,
    issue.body,
    issue.body_text,
    issue.bodyText,
  ];

  for (const candidate of direct) {
    if (candidate == null) continue;
    const text = String(candidate).trim();
    if (text.length > 0) return text;
  }

  const html = issue.description_html ?? issue.descriptionHtml ?? issue.body_html ?? issue.bodyHtml;
  if (html != null) {
    const text = String(html)
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .trim();
    if (text.length > 0) return text;
  }

  return undefined;
}

import { CliRunner } from './cli.js';

type PlaneState = {
  id: string;
  name: string;
};

/**
 * Plane adapter (CLI-auth only).
 *
 * Uses https://github.com/simonvanlaak/plane-cli (a2c-based).
 *
 * By default this calls a `plane` wrapper on PATH, e.g. plane-cli's `scripts/plane`.
 *
 * If you prefer to call a2c directly:
 *   bin: "a2c"
 *   baseArgs: ["--config", "<path>/a2c", "--workspace", "plane"]
 */
export class PlaneAdapter implements Adapter {
  private readonly cli: CliRunner;
  private readonly baseArgs: readonly string[];
  // workspaceSlug is kept for config compatibility; current plane CLI reads workspace from env.
  private readonly workspaceSlug: string;
  private readonly projectIds: readonly string[];
  private readonly stageMap: Readonly<Record<string, import('../stage.js').StageKey>>;
  private readonly orderField?: string;

  /**
   * Plane CLI JSON output flags.
   *
   * plane-cli currently uses `-f json` (a2c convention). Older surfaces used `--format json`.
   * We default to `-f json` and fall back to `--format json` if needed.
   */
  private readonly formatArgs: readonly string[];
  private readonly issueProjectCache = new Map<string, string>();
  private readonly projectIdentifierCache = new Map<string, string>();
  private membersByDisplayNameCache?: Map<string, string>;

  constructor(opts: {
    workspaceSlug: string;
    /** Single-project config (legacy). */
    projectId?: string;
    /** Multi-project config. */
    projectIds?: readonly string[];
    bin?: string;
    baseArgs?: readonly string[];
    /** Required mapping: Plane state/list names -> canonical stage key. */
    stageMap: Readonly<Record<string, import('../stage.js').StageKey>>;
    /** Explicit ordering field name when UI order can't be discovered. */
    orderField?: string;
    /** Override JSON output flags if your plane wrapper differs. */
    formatArgs?: readonly string[];
  }) {
    this.cli = new CliRunner(opts.bin ?? 'plane');
    this.baseArgs = opts.baseArgs ?? [];
    this.workspaceSlug = opts.workspaceSlug;

    const ids = (opts.projectIds && opts.projectIds.length > 0 ? [...opts.projectIds] : []).filter(Boolean);
    if (ids.length === 0) {
      const single = String(opts.projectId ?? '').trim();
      if (!single) throw new Error('PlaneAdapter requires projectId or projectIds');
      ids.push(single);
    }
    this.projectIds = ids;

    this.stageMap = opts.stageMap;
    this.orderField = opts.orderField;
    this.formatArgs = opts.formatArgs ?? ['-f', 'json'];
  }

  name(): string {
    return 'plane';
  }

  private async writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    await fs.rename(tempPath, filePath);
  }

  private async loadIssueCache(projectId: string): Promise<PlaneIssueCache | undefined> {
    try {
      const raw = await fs.readFile(issueCachePath(projectId), 'utf-8');
      const parsed = JSON.parse(raw || '{}');
      if (!parsed || typeof parsed !== 'object' || typeof parsed.projectId !== 'string' || typeof parsed.issuesById !== 'object') {
        return undefined;
      }
      return {
        version: 1,
        projectId,
        refreshedAt: typeof parsed.refreshedAt === 'string' ? parsed.refreshedAt : undefined,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
        issuesById: { ...(parsed.issuesById ?? {}) },
      };
    } catch {
      return undefined;
    }
  }

  private async saveIssueCache(projectId: string, issues: any[], opts?: { refreshedAt?: boolean }): Promise<PlaneIssueCache> {
    const now = new Date().toISOString();
    const cache: PlaneIssueCache = {
      version: 1,
      projectId,
      refreshedAt: opts?.refreshedAt === false ? undefined : now,
      updatedAt: now,
      issuesById: Object.fromEntries(
        normalizePlaneIssuesList(issues)
          .filter((issue) => issue && issue.id != null)
          .map((issue: any) => [String(issue.id), issue] as const),
      ),
    };
    if (opts?.refreshedAt === false) {
      const prior = await this.loadIssueCache(projectId);
      cache.refreshedAt = prior?.refreshedAt;
    }
    await this.writeJsonAtomic(issueCachePath(projectId), cache);
    return cache;
  }

  private async loadCacheEventQueue(): Promise<PlaneCacheEventQueue> {
    try {
      const raw = await fs.readFile(PLANE_CACHE_EVENT_FILE, 'utf-8');
      const parsed = JSON.parse(raw || '{}');
      const events = Array.isArray(parsed?.events)
        ? parsed.events.map((event: any) => ({
            id: String(event?.id ?? '').trim(),
            projectId: String(event?.projectId ?? '').trim() || undefined,
            seenAt: typeof event?.seenAt === 'string' ? event.seenAt : undefined,
          }))
        : [];
      return { version: 1, events: queueUniqueByIdAndProject(events) };
    } catch {
      return { version: 1, events: [] };
    }
  }

  private async consumeProjectCacheEvents(projectId: string): Promise<Array<{ id: string; projectId?: string; seenAt?: string }>> {
    const queue = await this.loadCacheEventQueue();
    if (queue.events.length === 0) return [];

    const matched = queue.events.filter((event) => !event.projectId || event.projectId === projectId);
    if (matched.length === 0) return [];

    const remaining = queue.events.filter((event) => event.projectId && event.projectId !== projectId);
    await this.writeJsonAtomic(PLANE_CACHE_EVENT_FILE, { version: 1, events: remaining });
    return matched;
  }

  private async getIssueRawMaybe(projectId: string, id: string): Promise<any | undefined> {
    try {
      return await this.getIssueRaw(projectId, id);
    } catch (err: any) {
      const message = String(err?.message ?? err ?? '');
      if (message.includes('HTTP 404') || message.includes('not found')) {
        return undefined;
      }
      throw err;
    }
  }

  private async applyIncrementalUpdates(projectId: string, cache: PlaneIssueCache, events: Array<{ id: string; projectId?: string; seenAt?: string }>): Promise<PlaneIssueCache> {
    if (events.length === 0) return cache;

    const issuesById = { ...(cache.issuesById ?? {}) };
    let changed = false;

    for (const event of queueUniqueByIdAndProject(events)) {
      const issue = await this.getIssueRawMaybe(projectId, event.id);
      if (issue && issue.id != null) {
        issuesById[String(issue.id)] = issue;
        changed = true;
      } else if (issuesById[event.id] != null) {
        delete issuesById[event.id];
        changed = true;
      }
    }

    if (!changed) return cache;

    const next: PlaneIssueCache = {
      version: 1,
      projectId,
      refreshedAt: cache.refreshedAt,
      updatedAt: new Date().toISOString(),
      issuesById,
    };
    await this.writeJsonAtomic(issueCachePath(projectId), next);
    return next;
  }

  private async getSnapshotIssuesForProject(projectId: string): Promise<any[]> {
    const now = Date.now();
    const cached = await this.loadIssueCache(projectId);
    const events = await this.consumeProjectCacheEvents(projectId);

    let effectiveCache = cached;
    if (effectiveCache && events.length > 0) {
      effectiveCache = await this.applyIncrementalUpdates(projectId, effectiveCache, events);
    }

    const refreshedAtMs = effectiveCache?.refreshedAt ? Date.parse(effectiveCache.refreshedAt) : Number.NaN;
    const stale = !effectiveCache || !Number.isFinite(refreshedAtMs) || (now - refreshedAtMs) >= PLANE_CACHE_RECONCILE_MS;
    if (stale) {
      const issuesRaw = await this.listIssuesRaw(projectId);
      const issues = normalizePlaneIssuesList(issuesRaw);
      await this.saveIssueCache(projectId, issues, { refreshedAt: true });
      return issues;
    }

    return Object.values(effectiveCache?.issuesById ?? {});
  }

  // ---- Verb-level (workflow) API (best-effort; depends on plane-cli surface) ----

  private async runJson(args: readonly string[]): Promise<any> {
    // Prefer global format flags first: `plane -f json <cmd...>`.
    const out = await this.cli.run([...this.baseArgs, ...this.formatArgs, ...args]);
    return out.trim().length > 0 ? JSON.parse(out) : null;
  }

  private async getIssueRaw(projectId: string, id: string): Promise<any> {
    return (await this.runJson(['issues', 'get', '-p', projectId, String(id)])) ?? {};
  }

  private async getProjectIdentifier(projectId: string): Promise<string | undefined> {
    const cached = this.projectIdentifierCache.get(projectId);
    if (cached) return cached;

    try {
      const payload = await this.runJson(['projects', 'list']);
      const results = Array.isArray((payload as any)?.results)
        ? (payload as any).results
        : Array.isArray(payload)
          ? payload
          : [];
      const match = results.find((p: any) => String(p?.id ?? '') === projectId);
      const identifier = match?.identifier != null ? String(match.identifier).trim() : '';
      if (identifier) {
        this.projectIdentifierCache.set(projectId, identifier);
        return identifier;
      }
    } catch {
      // best-effort: session naming falls back to UUIDs if the project identifier can't be resolved.
    }

    return undefined;
  }

  private async postCommentViaApi(projectId: string, id: string, body: string): Promise<void> {
    const apiKey = process.env.PLANE_API_KEY;
    if (!apiKey) {
      throw new Error('PLANE_API_KEY is required for Plane comment API');
    }

    const base = (process.env.PLANE_BASE_URL || 'https://api.plane.so').replace(/\/$/, '');
    const workItemUrl = `${base}/api/v1/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/${String(id)}/comments/`;
    const issueUrl = `${base}/api/v1/workspaces/${this.workspaceSlug}/projects/${projectId}/issues/${String(id)}/comments/`;

    const commentHtml = await this.renderCommentHtmlWithMentions(body);
    const commentJson = await this.renderCommentJsonWithMentions(body);

    let res = await fetch(workItemUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({ comment_html: commentHtml, comment_json: commentJson }),
    });

    // Back-compat fallback for older Plane deployments.
    if (!res.ok && (res.status === 404 || res.status === 405)) {
      res = await fetch(issueUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({ comment_html: commentHtml, comment_json: commentJson }),
      });
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Plane comment API failed: HTTP ${res.status} ${txt}`);
    }
  }


  private async listCommentsViaApi(projectId: string, id: string, opts?: { limit?: number }): Promise<any[]> {
    const apiKey = process.env.PLANE_API_KEY;
    if (!apiKey) {
      throw new Error('PLANE_API_KEY is required for Plane comments API');
    }

    const base = (process.env.PLANE_BASE_URL || 'https://api.plane.so').replace(/\/$/, '');
    const workItemBaseUrl = `${base}/api/v1/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/${String(id)}/comments/`;
    const issueBaseUrl = `${base}/api/v1/workspaces/${this.workspaceSlug}/projects/${projectId}/issues/${String(id)}/comments/`;

    const sleep = async (ms: number): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    };

    const fetchPage = async (url: string): Promise<{ results: any[]; next?: string | null }> => {
      let attempt = 0;
      while (true) {
        attempt += 1;
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            'x-api-key': apiKey,
          },
        });

        if (res.ok) {
          const json = await res.json().catch(() => ({}));
          if (Array.isArray(json)) return { results: json, next: null };

          if (json && typeof json === 'object') {
            const obj: any = json;
            const results = Array.isArray(obj.results) ? obj.results : [];
            const next = typeof obj.next === 'string' ? obj.next : null;
            return { results, next };
          }

          return { results: [], next: null };
        }

        const txt = await res.text().catch(() => '');
        if (res.status === 429 && attempt < 4) {
          const retryAfterRaw = res.headers.get('retry-after');
          const retryAfterSeconds = Number(retryAfterRaw);
          const backoffMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : attempt * 1500;
          await sleep(backoffMs);
          continue;
        }

        throw new Error(`Plane comments API failed: HTTP ${res.status} ${txt}`);
      }
    };

    const fetchAll = async (baseUrl: string): Promise<any[]> => {
      const out: any[] = [];
      const requestedLimit = Math.max(1, Number(opts?.limit ?? 100));
      const pageSize = Math.min(requestedLimit, 100);
      let nextUrl: string | null = (() => {
        try {
          const u = new URL(baseUrl);
          u.searchParams.set('page_size', String(pageSize));
          return u.toString();
        } catch {
          return baseUrl;
        }
      })();
      let pageCount = 0;

      while (nextUrl && pageCount < 50 && out.length < requestedLimit) {
        pageCount += 1;
        const { results, next } = await fetchPage(nextUrl);
        out.push(...results);
        if (!next || out.length >= requestedLimit) break;
        try {
          const u = new URL(next, baseUrl);
          if (!u.searchParams.get('page_size')) u.searchParams.set('page_size', String(pageSize));
          nextUrl = u.toString();
        } catch {
          // If Plane ever returns a malformed next link, stop paginating.
          break;
        }
      }

      return out.slice(0, requestedLimit);
    };

    // Try work-items endpoint first.
    try {
      return await fetchAll(workItemBaseUrl);
    } catch (err: any) {
      const msg = String(err?.message ?? err ?? '');
      // Back-compat fallback for older Plane deployments.
      if (msg.includes('HTTP 404') || msg.includes('HTTP 405')) {
        return await fetchAll(issueBaseUrl);
      }
      throw err;
    }
  }

  private async listLinksViaApi(projectId: string, id: string): Promise<any[]> {
    const apiKey = process.env.PLANE_API_KEY;
    if (!apiKey) {
      throw new Error('PLANE_API_KEY is required for Plane links API');
    }

    const base = (process.env.PLANE_BASE_URL || 'https://api.plane.so').replace(/\/$/, '');
    const workItemUrl = `${base}/api/v1/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/${String(id)}/links/`;
    const issueUrl = `${base}/api/v1/workspaces/${this.workspaceSlug}/projects/${projectId}/issues/${String(id)}/links/`;

    let res = await fetch(workItemUrl, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
      },
    });

    if (!res.ok && (res.status === 404 || res.status === 405)) {
      res = await fetch(issueUrl, {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
        },
      });
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Plane links API failed (list): HTTP ${res.status} ${txt}`);
    }

    const json = await res.json().catch(() => ([]));
    if (Array.isArray(json)) return json;
    if (json && typeof json === 'object' && Array.isArray((json as any).results)) return (json as any).results;
    return [];
  }

  private async createLinkViaApi(projectId: string, id: string, link: { title?: string; url: string }): Promise<void> {
    const apiKey = process.env.PLANE_API_KEY;
    if (!apiKey) {
      throw new Error('PLANE_API_KEY is required for Plane links API');
    }

    const base = (process.env.PLANE_BASE_URL || 'https://api.plane.so').replace(/\/$/, '');
    const workItemUrl = `${base}/api/v1/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/${String(id)}/links/`;
    const issueUrl = `${base}/api/v1/workspaces/${this.workspaceSlug}/projects/${projectId}/issues/${String(id)}/links/`;

    const payload: any = { url: String(link.url || '').trim() };
    const title = String(link.title ?? '').trim();
    if (title) payload.title = title;

    let res = await fetch(workItemUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok && (res.status === 404 || res.status === 405)) {
      res = await fetch(issueUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify(payload),
      });
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Plane links API failed (create): HTTP ${res.status} ${txt}`);
    }
  }

  private async updateCommentViaApi(projectId: string, issueId: string, commentId: string, body: string): Promise<void> {
    const apiKey = process.env.PLANE_API_KEY;
    if (!apiKey) {
      throw new Error('PLANE_API_KEY is required for Plane comments API');
    }
    const base = (process.env.PLANE_BASE_URL || 'https://api.plane.so').replace(/\/$/, '');
    const workItemUrl =
      `${base}/api/v1/workspaces/${this.workspaceSlug}/projects/${projectId}` +
      `/work-items/${String(issueId)}/comments/${String(commentId)}/`;
    const issueUrl =
      `${base}/api/v1/workspaces/${this.workspaceSlug}/projects/${projectId}` +
      `/issues/${String(issueId)}/comments/${String(commentId)}/`;
    const commentHtml = await this.renderCommentHtmlWithMentions(body);
    const commentJson = await this.renderCommentJsonWithMentions(body);

    let res = await fetch(workItemUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({ comment_html: commentHtml, comment_json: commentJson }),
    });

    if (!res.ok && (res.status === 404 || res.status === 405)) {
      res = await fetch(issueUrl, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({ comment_html: commentHtml, comment_json: commentJson }),
      });
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Plane comments API failed (update): HTTP ${res.status} ${txt}`);
    }
  }

  private async deleteCommentViaApi(projectId: string, issueId: string, commentId: string): Promise<void> {
    const apiKey = process.env.PLANE_API_KEY;
    if (!apiKey) {
      throw new Error('PLANE_API_KEY is required for Plane comments API');
    }
    const base = (process.env.PLANE_BASE_URL || 'https://api.plane.so').replace(/\/$/, '');
    const workItemUrl =
      `${base}/api/v1/workspaces/${this.workspaceSlug}/projects/${projectId}` +
      `/work-items/${String(issueId)}/comments/${String(commentId)}/`;
    const issueUrl =
      `${base}/api/v1/workspaces/${this.workspaceSlug}/projects/${projectId}` +
      `/issues/${String(issueId)}/comments/${String(commentId)}/`;

    let res = await fetch(workItemUrl, {
      method: 'DELETE',
      headers: {
        'x-api-key': apiKey,
      },
    });

    if (!res.ok && (res.status === 404 || res.status === 405)) {
      res = await fetch(issueUrl, {
        method: 'DELETE',
        headers: {
          'x-api-key': apiKey,
        },
      });
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Plane comments API failed (delete): HTTP ${res.status} ${txt}`);
    }
  }

  private stripHtml(input: string): string {
    return String(input || '')
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .trim();
  }

  private escapeHtml(input: string): string {
    return String(input ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private renderInlineMarkdown(text: string): string {
    return text
      // Markdown links: [label](https://example.com)
      // We only support http/https and we apply this after HTML-escaping, so label/url are safe.
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  private renderCommentHtml(body: string): string {
    const normalized = String(body ?? '').replace(/\r\n?/g, '\n').trim();
    if (!normalized) return '<p></p>';

    const escaped = this.escapeHtml(normalized);
    const withInline = this.renderInlineMarkdown(escaped);
    const paragraphs = withInline
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p>${p.replace(/\n/g, '<br/>')}</p>`);

    return paragraphs.length > 0 ? paragraphs.join('') : '<p></p>';
  }

  private escapeRegex(input: string): string {
    return String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private async getMembersByDisplayName(): Promise<Map<string, string>> {
    if (this.membersByDisplayNameCache) return this.membersByDisplayNameCache;

    // Best-effort: Plane "members" CLI can be called without project context.
    // Our deployment uses display_name like "lukas.kaiser" (username field may be null).
    let raw: any;
    try {
      raw = await this.runJson(['members']);
    } catch {
      raw = [];
    }

    const members = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object'
        ? Array.isArray((raw as any).results)
          ? (raw as any).results
          : Array.isArray((raw as any).items)
            ? (raw as any).items
            : []
        : [];

    const out = new Map<string, string>();
    for (const m of members) {
      if (!m || typeof m !== 'object') continue;
      const id = m.id != null ? String(m.id).trim() : '';
      const display = m.display_name != null ? String(m.display_name).trim() : '';
      if (!id || !display) continue;
      out.set(display.toLowerCase(), id);
    }

    this.membersByDisplayNameCache = out;
    return out;
  }

  private async renderCommentHtmlWithMentions(body: string): Promise<string> {
    const raw = String(body ?? '');

    // Fast-path: if there is no '@' at all, avoid any member lookup (keeps addComment lightweight).
    if (!raw.includes('@')) return this.renderCommentHtml(raw);

    // Render our normal safe HTML first.
    let html = this.renderCommentHtml(raw);

    // Then replace known @display_name tokens with Plane mention markup.
    // Note: Plane mentions are editor-specific; in our deployment a <span data-type="mention" ...>
    // is rendered as an actual mention in the UI, while plain "@name" is just text.
    const members = await this.getMembersByDisplayName();
    if (members.size === 0) return html;

    for (const [displayLower, id] of members.entries()) {
      const display = displayLower; // already lower-case key
      // We match case-insensitively but preserve the canonical display_name in the rendered label.
      const pattern = new RegExp(`(^|[>\\s])@${this.escapeRegex(display)}(?=($|[\\s<.,;:!?)]))`, 'gi');
      html = html.replace(pattern, `$1<span data-type="mention" data-id="${id}" data-label="${display}">@${display}</span>`);
    }

    return html;
  }

  private async renderCommentJsonWithMentions(body: string): Promise<any> {
    const raw = String(body ?? '').replace(/\r\n?/g, '\n').trimEnd();
    if (!raw) return { type: 'doc', content: [{ type: 'paragraph', content: [] }] };

    // TipTap JSONContent payload. Plane uses this to understand mentions.
    // comment_html alone can render spans but does not always trigger mention behavior.
    const members = raw.includes('@') ? await this.getMembersByDisplayName() : new Map<string, string>();

    const isBoundaryBefore = (text: string, idx: number): boolean => {
      if (idx <= 0) return true;
      return /\s/.test(text[idx - 1] ?? '');
    };
    const isBoundaryAfter = (text: string, idxAfter: number): boolean => {
      if (idxAfter >= text.length) return true;
      return /[\s<.,;:!?)]/.test(text[idxAfter] ?? '');
    };

    const parseLine = (line: string): any[] => {
      if (!members.size || !line.includes('@')) return line ? [{ type: 'text', text: line }] : [];

      const out: any[] = [];
      const rx = /@([A-Za-z0-9._-]+)/g;
      let last = 0;
      for (;;) {
        const m = rx.exec(line);
        if (!m) break;
        const full = m[0];
        const name = m[1] ?? '';
        const start = m.index;
        const end = start + full.length;

        if (!isBoundaryBefore(line, start) || !isBoundaryAfter(line, end)) continue;

        const memberId = members.get(String(name).toLowerCase());
        if (!memberId) continue;

        if (start > last) {
          const chunk = line.slice(last, start);
          if (chunk) out.push({ type: 'text', text: chunk });
        }

        out.push({ type: 'mention', attrs: { id: memberId, label: String(name) } });
        last = end;
      }

      if (last < line.length) {
        const tail = line.slice(last);
        if (tail) out.push({ type: 'text', text: tail });
      }

      return out;
    };

    const paragraphs = raw.split(/\n{2,}/);
    const content: any[] = [];

    for (const p of paragraphs) {
      const lines = p.split('\n');
      const nodes: any[] = [];

      lines.forEach((line, i) => {
        if (i > 0) nodes.push({ type: 'hardBreak' });
        nodes.push(...parseLine(line));
      });

      content.push({ type: 'paragraph', content: nodes });
    }

    return { type: 'doc', content };
  }

  /**
   * Return @display_name mention strings for all stakeholders of a ticket
   * (creator + assignees) excluding the bot's own user.
   * Useful for appending to completion comments so humans get notified.
   */
  async getStakeholderMentions(ticketId: string): Promise<string[]> {
    try {
      const me = await this.whoami();
      const meId = me.id;
      const members = await this.getMembersByDisplayName();
      // Build reverse map: id -> display_name
      const idToDisplay = new Map<string, string>();
      for (const [display, id] of members.entries()) {
        idToDisplay.set(id, display);
      }

      const snap = await this.fetchSnapshot();
      const item = snap instanceof Map ? snap.get(ticketId) : (snap as Record<string, any>)[ticketId];
      if (!item) return [];

      const raw = (item as any).raw ?? item;
      const creatorId = extractIssueCreatorId(raw);
      const assigneeIds = extractIssueAssigneeIds(raw);

      const stakeholderIds = new Set<string>();
      if (creatorId) stakeholderIds.add(creatorId);
      for (const a of assigneeIds) stakeholderIds.add(a);
      // Remove self
      if (meId) stakeholderIds.delete(meId);

      const mentions: string[] = [];
      for (const id of stakeholderIds) {
        const display = idToDisplay.get(id);
        if (display) mentions.push(`@${display}`);
      }
      return mentions;
    } catch {
      return [];
    }
  }

  private readonly statesCacheByProject = new Map<string, PlaneState[]>();

  private getSingleProjectId(forWhat: string): string {
    if (this.projectIds.length !== 1) {
      throw new Error(`PlaneAdapter.${forWhat} requires a single projectId (multi-project write not supported)`);
    }
    return this.projectIds[0];
  }

  private rememberIssueProject(issueId: string, projectId: string): void {
    const iid = String(issueId ?? '').trim();
    const pid = String(projectId ?? '').trim();
    if (!iid || !pid) return;
    this.issueProjectCache.set(iid, pid);
  }

  private projectIdFromIssueRaw(raw: unknown): string | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const issue: any = raw;
    const direct = issue.project_id ?? issue.projectId;
    if (direct != null) {
      const out = String(direct).trim();
      if (out) return out;
    }
    const nested = issue.project?.id ?? issue.project?.project_id ?? issue.project_detail?.id;
    if (nested != null) {
      const out = String(nested).trim();
      if (out) return out;
    }
    return undefined;
  }

  private async resolveProjectIdForIssue(id: string, forWhat: string): Promise<string> {
    const issueId = String(id ?? '').trim();
    if (!issueId) throw new Error(`PlaneAdapter.${forWhat}: missing issue id`);

    if (this.projectIds.length === 1) {
      const projectId = this.projectIds[0]!;
      this.rememberIssueProject(issueId, projectId);
      return projectId;
    }

    const cached = this.issueProjectCache.get(issueId);
    if (cached) return cached;

    for (const projectId of this.projectIds) {
      try {
        const raw = await this.getIssueRaw(projectId, issueId);
        const foundId = idFromUnknown((raw as any)?.id);
        if (foundId && String(foundId) === issueId) {
          this.rememberIssueProject(issueId, projectId);
          return projectId;
        }
      } catch {
        // Continue probing next project.
      }
    }

    throw new Error(`PlaneAdapter.${forWhat}: unable to resolve project for issue ${issueId}`);
  }

  private async fetchStatesForProject(projectId: string): Promise<PlaneState[]> {
    const cached = this.statesCacheByProject.get(projectId);
    if (cached) return cached;
    const raw = (await this.runJson(['states', '-p', projectId])) ?? [];
    const statesRaw = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object'
        ? (raw as any).results && Array.isArray((raw as any).results)
          ? (raw as any).results
          : (raw as any).items && Array.isArray((raw as any).items)
            ? (raw as any).items
            : (raw as any).data && Array.isArray((raw as any).data)
              ? (raw as any).data
              : []
        : [];

    const StateSchema = z
      .object({
        id: z.union([z.string(), z.number()]).transform((v) => String(v)),
        name: z.string(),
      })
      .passthrough();

    const states = z.array(StateSchema).parse(statesRaw);
    this.statesCacheByProject.set(projectId, states);
    return states;
  }

  private async resolveStateIdForStage(projectId: string, stage: import('../stage.js').StageKey): Promise<string> {
    const states = await this.fetchStatesForProject(projectId);

    // Find a Plane state whose name maps to the canonical stage.
    const match = states.find((s) => this.stageMap[s.name] === stage);
    if (!match) {
      const mappedNames = states.filter((s) => this.stageMap[s.name]).map((s) => s.name);
      throw new Error(
        `PlaneAdapter.setStage: no Plane state is mapped to ${stage}. ` +
          `Mapped Plane states: ${mappedNames.length ? mappedNames.join(', ') : '(none)'}`,
      );
    }
    return match.id;
  }

  private async resolveCanonicalStageForIssueRaw(
    projectId: string,
    issueRaw: unknown,
  ): Promise<import('../stage.js').StageKey | undefined> {
    let stateName = extractIssueStageName(issueRaw);

    if (!stateName) {
      const stateId = extractIssueStateId(issueRaw);
      if (stateId) {
        const states = await this.fetchStatesForProject(projectId);
        stateName = states.find((s) => s.id === stateId)?.name;
      }
    }

    if (!stateName) return undefined;

    const mapped = this.stageMap[stateName];
    if (!mapped) return undefined;

    return Stage.fromAny(mapped).key;
  }

  async whoami(): Promise<{ id?: string; username?: string; name?: string }> {
    const parsed = (await this.runJson(['me'])) ?? {};

    // Some flows (multi-project) validate the CLI is functional by listing projects too.
    // We ignore the result; this is just a connectivity/auth sanity check.
    try {
      await this.runJson(['projects', 'list']);
    } catch {
      // ignore
    }

    return {
      id: parsed?.id ? String(parsed.id) : undefined,
      username: parsed?.email ? String(parsed.email) : undefined,
      name: parsed?.display_name ? String(parsed.display_name) : parsed?.name ? String(parsed.name) : undefined,
    };
  }

  async listIdsByStage(stage: import('../stage.js').StageKey): Promise<string[]> {
    // Strict self-assigned gating (aligned with listBacklogIdsInOrder).
    // Without this, automation like auto-reopen can change states for tickets that
    // are not assigned to the worker user.
    const me = await this.whoami();
    const meId = me.id;

    const merged: Array<{ id: string; updatedAt?: Date; assignees?: Array<{ id?: string; username?: string; name?: string } | string> }> = [];

    for (const projectId of this.projectIds) {
      const issues = await this.getSnapshotIssuesForProject(projectId);
      const snap = await this.fetchSnapshotForProject(projectId, issues);

      let items = [...snap.values()].filter((i) => i.stage.key === stage);

      // Hard safety: if assignee data is present, enforce self-assigned only.
      if (meId) {
        const hasAnyAssigneeData = items.some((i) => (i.assignees ?? []).length > 0);
        if (hasAnyAssigneeData) {
          items = items.filter((i) => (i.assignees ?? []).some((a) => assigneeMatchesSelf(a, me)));
        }
      }

      for (const item of items) {
        // Defensive live-stage verification: snapshot cache can lag behind manual
        // stage moves (e.g. In Progress -> Blocked), causing stale active-session drift.
        // When we are selecting active in-progress work, verify each candidate against
        // a fresh issue read before returning it.
        if (stage === 'stage:in-progress') {
          try {
            const issueRaw = await this.getIssueRawMaybe(projectId, item.id);
            if (issueRaw) {
              const canonicalStage = await this.resolveCanonicalStageForIssueRaw(projectId, issueRaw);
              const hasLiveStateSignal = Boolean(extractIssueStageName(issueRaw) || extractIssueStateId(issueRaw));
              if (hasLiveStateSignal && canonicalStage !== stage) {
                continue;
              }
            }
          } catch {
            // Best-effort safety check only; never fail selection due transient read issues.
          }
        }

        merged.push({ id: item.id, updatedAt: item.updatedAt, assignees: item.assignees });
      }
    }

    return merged
      // deterministic order: oldest update first so ongoing work remains primary
      .sort((a, b) => (a.updatedAt?.getTime() ?? 0) - (b.updatedAt?.getTime() ?? 0))
      .map((i) => i.id);
  }

  private async listIssuesRaw(projectId: string, opts?: { assigneeId?: string }): Promise<any> {
    const args = ['issues', 'list', '-p', projectId] as string[];
    if (opts?.assigneeId) args.push('--assignee', opts.assigneeId);
    const out = await this.cli.run([...this.baseArgs, ...args, ...this.formatArgs]);
    return out.trim().length > 0 ? JSON.parse(out) : [];
  }

  async reconcileAssignments(): Promise<void> {
    for (const projectId of this.projectIds) {
      const issuesRaw = await this.listIssuesRaw(projectId);
      const issues = normalizePlaneIssuesList(issuesRaw);

      for (const issue of issues) {
        const stateName = extractIssueStageName(issue);
        if (!stateName) continue;

        const mappedStage = this.stageMap[stateName];
        // Reconcile creator assignment for any mapped canonical stage.
        // This matches the "every new ticket should auto-assign to its creator" expectation,
        // while still skipping unmapped platform states (e.g. Done/Cancelled).
        if (!mappedStage) continue;

        const assigneeIds = extractIssueAssigneeIds(issue);
        if (assigneeIds.length > 0) continue;

        const creatorId = extractIssueCreatorId(issue);
        const issueId = issue?.id ? String(issue.id) : undefined;
        if (!creatorId || !issueId) continue;

        try {
          await this.cli.run([
            ...this.baseArgs,
            ...this.formatArgs,
            'issues',
            'assign',
            '-p',
            projectId,
            issueId,
            creatorId,
          ]);
        } catch {
          // Best-effort only, never fail listing/selection on assign drift healing.
        }
      }
    }
  }

  async listBacklogIdsInOrder(): Promise<string[]> {
    // Requirements-aligned ordering:
    // - merge backlog across all configured projects
    // - strict self-assigned gating
    // - priority desc
    // - title alpha tie-break
    // - deterministic id tie-break
    const me = await this.whoami();
    const meId = me.id;

    const merged: Array<{ id: string; title: string; priority: number }> = [];

    for (const projectId of this.projectIds) {
      const issues = await this.getSnapshotIssuesForProject(projectId);

      const snap = await this.fetchSnapshotForProject(projectId, issues);
      let backlog = [...snap.values()].filter((i) => i.stage.key === 'stage:todo');

      // Hard safety: if assignee data is present, enforce self-assigned only.
      // Some Plane list surfaces omit assignees when server-side --assignee is used,
      // so we avoid dropping all items when assignment info is unavailable.
      if (meId) {
        const hasAnyAssigneeData = backlog.some((i) => (i.assignees ?? []).length > 0);
        if (hasAnyAssigneeData) {
          backlog = backlog.filter((i) => (i.assignees ?? []).some((a) => assigneeMatchesSelf(a, me)));
        }
      }

      const byId = new Map(issues.map((x: any) => [String(x.id), x] as const));
      for (const item of backlog) {
        merged.push({
          id: item.id,
          title: String(item.title ?? ''),
          priority: extractPriorityFromIssue(byId.get(item.id)) ?? Number.NEGATIVE_INFINITY,
        });
      }
    }

    merged.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      const titleCmp = a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
      if (titleCmp !== 0) return titleCmp;
      return a.id.localeCompare(b.id);
    });

    return merged.map((i) => i.id);
  }

  async getWorkItem(id: string): Promise<{
    id: string;
    projectId?: string;
    identifier?: string;
    title: string;
    url?: string;
    stage: import('../stage.js').StageKey;
    body?: string;
    labels: string[];
    assignees?: Array<{ id?: string; username?: string; name?: string } | string>;
    updatedAt?: Date;
  }> {
    const snap = await this.fetchSnapshot();
    const item = snap.get(id);
    if (!item) throw new Error(`Plane work item not found: ${id}`);

    // Determine project id reliably. Some Plane list surfaces omit `project_id`,
    // so we prefer the adapter's project resolution cache/probing.
    const projectId = await this.resolveProjectIdForIssue(id, 'getWorkItem');
    let body = extractIssueBody(item.raw);

    let sequenceId: number | undefined;

    // Fetch issue details for richer/full description where list payload is truncated.
    try {
      const details = await this.getIssueRaw(projectId, id);
      body = extractIssueBody(details) ?? body;
      const seq = (details as any)?.sequence_id ?? (details as any)?.sequenceId;
      const n = Number(seq);
      if (Number.isFinite(n) && n > 0) sequenceId = Math.floor(n);
    } catch {
      // Best-effort, never fail read path because detail endpoint shape varies.
    }

    if (!sequenceId) {
      const seq = (item.raw as any)?.sequence_id ?? (item.raw as any)?.sequenceId;
      const n = Number(seq);
      if (Number.isFinite(n) && n > 0) sequenceId = Math.floor(n);
    }

    let identifier: string | undefined;
    if (sequenceId) {
      const projectIdentifier = await this.getProjectIdentifier(projectId);
      if (projectIdentifier) {
        identifier = `${projectIdentifier}-${sequenceId}`;
      }
    }

    return {
      id: item.id,
      projectId,
      identifier,
      title: item.title,
      url: item.url,
      stage: item.stage.key,
      body,
      labels: [...item.labels],
      assignees: item.assignees,
      updatedAt: item.updatedAt,
    };
  }

  async listComments(
    id: string,
    opts: { limit?: number; newestFirst: boolean; includeInternal: boolean },
  ): Promise<Array<{ id: string; body: string; createdAt?: Date; author?: { id?: string; username?: string; name?: string } }>> {
    const projectId = await this.resolveProjectIdForIssue(id, 'listComments');
    const raw = await this.listCommentsViaApi(projectId, id, { limit: opts.limit });

    const mapped = raw
      .map((c: any) => {
        const actor = c?.actor_detail ?? c?.actor ?? c?.created_by_detail ?? c?.created_by;
        const actorId = typeof actor === 'string' ? actor : actor?.id;
        const actorUsername = typeof actor === 'string' ? undefined : (actor?.display_name ?? actor?.email ?? actor?.username);
        const actorName = typeof actor === 'string' ? undefined : (actor?.first_name || actor?.last_name)
          ? `${String(actor?.first_name ?? '').trim()} ${String(actor?.last_name ?? '').trim()}`.trim()
          : actor?.display_name;

        return {
          id: String(c?.id ?? ''),
          body: this.stripHtml(String(c?.comment_html ?? c?.comment ?? c?.body ?? '')),
          createdAt: c?.created_at ? parsePlaneDate(String(c.created_at)) : undefined,
          author:
            actorId || actorUsername || actorName
              ? {
                  id: actorId ? String(actorId) : undefined,
                  username: actorUsername ? String(actorUsername) : undefined,
                  name: actorName ? String(actorName) : undefined,
                }
              : undefined,
        };
      })
      .filter((c) => c.id && c.body);

    mapped.sort((a, b) => {
      const at = a.createdAt ? a.createdAt.getTime() : 0;
      const bt = b.createdAt ? b.createdAt.getTime() : 0;
      return bt - at;
    });
    const ordered = opts.newestFirst ? mapped : [...mapped].reverse();

    const limit = opts.limit;
    if (limit == null) return ordered;
    return ordered.slice(0, Math.max(1, limit));
  }

  async listAttachments(_id: string): Promise<Array<{ filename: string; url: string }>> {
    return [];
  }

  async listLinkedWorkItems(_id: string): Promise<Array<{ id: string; title: string }>> {
    return [];
  }

  async setStage(id: string, stage: import('../stage.js').StageKey): Promise<void> {
    const projectId = await this.resolveProjectIdForIssue(id, 'setStage');
    const stateId = await this.resolveStateIdForStage(projectId, stage);
    await this.cli.run([
      ...this.baseArgs,
      ...this.formatArgs,
      'issues',
      'update',
      '-p',
      projectId,
      '--state',
      stateId,
      id,
    ]);
  }

  async addComment(id: string, body: string): Promise<void> {
    const projectId = await this.resolveProjectIdForIssue(id, 'addComment');
    const msg = String(body || '').trim();
    if (!msg) return;

    // Primary path: direct Plane API comments endpoint (avoids CLI 405 behavior).
    await this.postCommentViaApi(projectId, String(id), msg);
  }

  async addLinks(id: string, links: ExternalLinkInput[]): Promise<void> {
    const items = Array.isArray(links) ? links : [];
    if (items.length === 0) return;

    const projectId = await this.resolveProjectIdForIssue(id, 'addLinks');

    const normalized = items
      .map((l) => ({
        title: String((l as any)?.title ?? '').trim(),
        url: String((l as any)?.url ?? '').trim(),
      }))
      .filter((l) => l.url.length > 0);

    if (normalized.length === 0) return;

    const existing = await this.listLinksViaApi(projectId, String(id));
    const existingUrls = new Set(
      existing
        .map((x: any) => String(x?.url ?? '').trim())
        .filter((u: string) => u.length > 0),
    );

    for (const link of normalized) {
      if (existingUrls.has(link.url)) continue;
      await this.createLinkViaApi(projectId, String(id), link);
      existingUrls.add(link.url);
    }
  }

  async updateComment(id: string, commentId: string, body: string): Promise<void> {
    const projectId = await this.resolveProjectIdForIssue(id, 'updateComment');
    const msg = String(body || '').trim();
    if (!msg) throw new Error('updateComment requires non-empty body');
    if (!String(commentId || '').trim()) throw new Error('updateComment requires commentId');
    await this.updateCommentViaApi(projectId, String(id), String(commentId), msg);
  }

  async deleteComment(id: string, commentId: string): Promise<void> {
    const projectId = await this.resolveProjectIdForIssue(id, 'deleteComment');
    if (!String(commentId || '').trim()) throw new Error('deleteComment requires commentId');
    await this.deleteCommentViaApi(projectId, String(id), String(commentId));
  }

  async createInBacklogAndAssignToSelf(input: { title: string; body: string; projectId?: string }): Promise<{ id: string; url?: string }> {
    const projectId = input.projectId ? String(input.projectId) : this.getSingleProjectId('create');
    const backlogStateId = await this.resolveStateIdForStage(projectId, 'stage:todo');

    const created = (await this.runJson([
      'issues',
      'create',
      '-p',
      projectId,
      '--name',
      input.title,
      '--description',
      input.body,
      '--state',
      backlogStateId,
    ])) ?? {};

    const id = created?.id ? String(created.id) : undefined;
    if (!id) throw new Error('PlaneAdapter.create: could not read created issue id from CLI output');
    this.rememberIssueProject(id, projectId);

    const me = await this.whoami();
    if (!me.id) throw new Error('create: cannot resolve self user');

    await this.cli.run([
      ...this.baseArgs,
      ...this.formatArgs,
      'issues',
      'assign',
      '-p',
      projectId,
      id,
      me.id,
    ]);

    return { id, url: created?.url ? String(created.url) : undefined };
  }

  private async fetchSnapshotForProject(projectId: string, issuesRaw?: unknown): Promise<ReadonlyMap<string, WorkItem>> {
    const out = JSON.stringify(
      normalizePlaneIssuesList(
        issuesRaw ?? ((await this.runJson(['issues', 'list', '-p', projectId])) ?? []),
      ),
    );

    const StateSchema = z
      .union([
        z
          .object({
            name: z.string().optional(),
          })
          .passthrough(),
        z.string().transform((name) => ({ name })),
      ])
      .transform((v) => (typeof v === 'string' ? { name: v } : v));

    const IssueSchema = z
      .object({
        id: z.union([z.string(), z.number()]).transform((v) => String(v)),
        name: z.string().optional(),
        title: z.string().optional(),
        url: z.string().optional(),
        updated_at: z.string().optional(),
        updatedAt: z.string().optional(),
        state: StateSchema.optional(),
        state_detail: StateSchema.optional(),
        labels: z
          .array(
            z.union([
              z.string().transform((name) => ({ name })),
              z.object({ name: z.string() }).passthrough(),
            ]),
          )
          .optional()
          .default([])
          .transform((arr) => arr.map((x) => x.name)),
        assignees: z
          .array(
            z.union([
              z.string().transform((id) => ({ id })),
              z
                .object({
                  id: z.union([z.string(), z.number()]).optional(),
                  user_id: z.union([z.string(), z.number()]).optional(),
                  userId: z.union([z.string(), z.number()]).optional(),
                  name: z.string().optional(),
                  email: z.string().optional(),
                  display_name: z.string().optional(),
                  displayName: z.string().optional(),
                  full_name: z.string().optional(),
                  fullName: z.string().optional(),
                  username: z.string().optional(),
                  user: z
                    .object({
                      id: z.union([z.string(), z.number()]).optional(),
                      user_id: z.union([z.string(), z.number()]).optional(),
                      userId: z.union([z.string(), z.number()]).optional(),
                      username: z.string().optional(),
                      email: z.string().optional(),
                      name: z.string().optional(),
                      display_name: z.string().optional(),
                      displayName: z.string().optional(),
                      full_name: z.string().optional(),
                      fullName: z.string().optional(),
                    })
                    .passthrough()
                    .optional(),
                })
                .passthrough()
                .transform((a) => ({
                  id:
                    idFromUnknown(a.id) ??
                    idFromUnknown(a.user_id) ??
                    idFromUnknown(a.userId) ??
                    idFromUnknown(a.user),
                  name:
                    a.name ??
                    a.full_name ??
                    a.fullName ??
                    a.display_name ??
                    a.displayName ??
                    a.user?.name ??
                    a.user?.full_name ??
                    a.user?.fullName ??
                    a.user?.display_name ??
                    a.user?.displayName,
                  username:
                    a.username ??
                    a.email ??
                    a.display_name ??
                    a.displayName ??
                    a.user?.username ??
                    a.user?.email ??
                    a.user?.display_name ??
                    a.user?.displayName,
                })),
            ]),
          )
          .optional()
          .default([]),
      })
      .passthrough();

    const ParsedSchema = z.array(IssueSchema);
    const issues = ParsedSchema.parse(JSON.parse(out || '[]'));

    const items = new Map<string, WorkItem>();

    for (const issue of issues) {
      const title = issue.name ?? issue.title ?? '';
      if (!title) continue;

      const stateName =
        (typeof issue.state === 'string' ? issue.state : issue.state?.name) ??
        (typeof issue.state_detail === 'string' ? issue.state_detail : issue.state_detail?.name);
      if (!stateName) continue;

      const mapped = this.stageMap[stateName];
      if (!mapped) {
        // Ignore states not mapped into the canonical set.
        continue;
      }

      const stage = Stage.fromAny(mapped);

      const updatedAtRaw = issue.updatedAt ?? issue.updated_at;
      this.rememberIssueProject(issue.id, projectId);

      items.set(issue.id, {
        id: issue.id,
        title,
        stage,
        url: issue.url,
        labels: [...issue.labels],
        assignees: issue.assignees,
        updatedAt: updatedAtRaw ? new Date(updatedAtRaw) : undefined,
        raw: issue,
      });
    }

    return items;
  }

  async fetchSnapshot(): Promise<ReadonlyMap<string, WorkItem>> {
    const merged = new Map<string, WorkItem>();

    for (const projectId of this.projectIds) {
      const issues = await this.getSnapshotIssuesForProject(projectId);
      const snap = await this.fetchSnapshotForProject(projectId, issues);
      for (const [id, item] of snap.entries()) {
        merged.set(id, item);
      }
    }

    return merged;
  }
}

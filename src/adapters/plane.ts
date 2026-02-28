import type { Adapter } from '../adapter.js';
import type { WorkItem } from '../models.js';

import { z } from 'zod';

import { Stage } from '../stage.js';

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

function discoverPlaneOrderField(issuesRaw: unknown): string | undefined {
  const issues = normalizePlaneIssuesList(issuesRaw);
  // Best-effort heuristics. Plane often uses numeric ordering fields.
  const candidates = ['sort_order', 'sortOrder', 'rank', 'position', 'order', 'sequence_id', 'sequenceId'];
  for (const field of candidates) {
    const has = issues.some((x: any) => x && typeof x === 'object' && field in x);
    if (has) return field;
  }
  return undefined;
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
    .filter((x): x is string => Boolean(x && x.trim().length > 0));
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

  // ---- Verb-level (workflow) API (best-effort; depends on plane-cli surface) ----

  private async runJson(args: readonly string[]): Promise<any> {
    // Prefer global format flags first: `plane -f json <cmd...>`.
    const out = await this.cli.run([...this.baseArgs, ...this.formatArgs, ...args]);
    return out.trim().length > 0 ? JSON.parse(out) : null;
  }

  private async getIssueRaw(projectId: string, id: string): Promise<any> {
    return (await this.runJson(['issues', 'get', '--project', projectId, String(id)])) ?? {};
  }


  private async postCommentViaApi(projectId: string, id: string, body: string): Promise<void> {
    const apiKey = process.env.PLANE_API_KEY;
    if (!apiKey) {
      throw new Error('PLANE_API_KEY is required for Plane comment API');
    }

    const base = (process.env.PLANE_BASE_URL || 'https://api.plane.so').replace(/\/$/, '');
    const url = `${base}/api/v1/workspaces/${this.workspaceSlug}/projects/${projectId}/issues/${String(id)}/comments/`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({ comment_html: `<p>${body}</p>` }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Plane comment API failed: HTTP ${res.status} ${txt}`);
    }
  }


  private async listCommentsViaApi(projectId: string, id: string): Promise<any[]> {
    const apiKey = process.env.PLANE_API_KEY;
    if (!apiKey) {
      throw new Error('PLANE_API_KEY is required for Plane comments API');
    }

    const base = (process.env.PLANE_BASE_URL || 'https://api.plane.so').replace(/\/$/, '');
    const url = `${base}/api/v1/workspaces/${this.workspaceSlug}/projects/${projectId}/issues/${String(id)}/comments/`;

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
      },
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Plane comments API failed: HTTP ${res.status} ${txt}`);
    }

    const json = await res.json().catch(() => ({}));
    if (Array.isArray(json)) return json;
    if (json && typeof json === 'object' && Array.isArray((json as any).results)) return (json as any).results;
    return [];
  }

  private stripHtml(input: string): string {
    return String(input || '')
      .replace(/<br\s*\/?\s*>/gi, '\\n')
      .replace(/<\/p>/gi, '\\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .trim();
  }

  private statesCache?: PlaneState[];

  private getSingleProjectId(forWhat: string): string {
    if (this.projectIds.length !== 1) {
      throw new Error(`PlaneAdapter.${forWhat} requires a single projectId (multi-project write not supported)`);
    }
    return this.projectIds[0];
  }

  private async fetchStates(): Promise<PlaneState[]> {
    if (this.statesCache) return this.statesCache;

    const projectId = this.getSingleProjectId('setStage');

    const raw = (await this.runJson(['states', '--project', projectId])) ?? [];
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
    this.statesCache = states;
    return states;
  }

  private async resolveStateIdForStage(stage: import('../stage.js').StageKey): Promise<string> {
    const states = await this.fetchStates();

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
    const snap = await this.fetchSnapshot();
    return [...snap.values()]
      .filter((i) => i.stage.key === stage)
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
            '--project',
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
    // Try to preserve explicit UI ordering if we can discover it from API fields.
    // Otherwise require an explicit order field from setup, and finally fall back to updatedAt desc.
    // Multi-project: we list backlog candidates per project (in config order) and concatenate.
    // Plane UI ordering isn't stable across projects anyway, so config order wins.
    const me = await this.whoami();
    const meId = me.id;

    const ids: string[] = [];

    for (const projectId of this.projectIds) {
      // This call is intentionally constructed as `plane issues list ... -f json` to match
      // common wrapper usage (and our tests).
      const issuesRaw = await this.listIssuesRaw(projectId, { assigneeId: meId });
      const issues = normalizePlaneIssuesList(issuesRaw);

      const snap = await this.fetchSnapshotForProject(projectId, issues);
      let backlog = [...snap.values()].filter((i) => i.stage.key === 'stage:todo');

      // Hard safety: if assignee data is present, enforce self-assigned only.
      // Some Plane list surfaces omit assignees when server-side --assignee is used,
      // so we avoid dropping all items when assignment info is unavailable.
      if (meId) {
        const hasAnyAssigneeData = backlog.some((i) => (i.assignees ?? []).length > 0);
        if (hasAnyAssigneeData) {
          backlog = backlog.filter((i) =>
            (i.assignees ?? []).some((a) => {
              if (typeof a === 'string') return String(a) === String(meId);
              const aid = (a as any)?.id;
              return aid ? String(aid) === String(meId) : false;
            }),
          );
        }
      }

      const byId = new Map(issues.map((x: any) => [String(x.id), x] as const));

      // If priority differs across backlog items, prioritize by priority first.
      const priorityById = new Map<string, number>();
      for (const item of backlog) {
        const p = extractPriorityFromIssue(byId.get(item.id));
        if (p != null) priorityById.set(item.id, p);
      }

      const distinctPriorities = new Set(priorityById.values());
      const usePriorityOrdering = distinctPriorities.size > 1;

      // Try preserve explicit ordering if we can discover it; otherwise updatedAt desc.
      const orderField = this.orderField ?? discoverPlaneOrderField(issuesRaw);
      const orderById = new Map<string, number>();
      if (orderField) {
        for (const item of backlog) {
          const order = Number(byId.get(item.id)?.[orderField]);
          if (Number.isFinite(order)) orderById.set(item.id, order);
        }
      }

      backlog.sort((a, b) => {
        if (usePriorityOrdering) {
          const pa = priorityById.get(a.id) ?? Number.NEGATIVE_INFINITY;
          const pb = priorityById.get(b.id) ?? Number.NEGATIVE_INFINITY;
          if (pa !== pb) return pb - pa;
        }

        const oa = orderById.get(a.id);
        const ob = orderById.get(b.id);
        const hasOa = oa != null;
        const hasOb = ob != null;

        if (hasOa && hasOb && oa !== ob) return oa - ob;
        if (hasOa !== hasOb) return hasOa ? -1 : 1;

        const updatedCmp = (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0);
        if (updatedCmp !== 0) return updatedCmp;

        return String(a.id).localeCompare(String(b.id));
      });

      ids.push(...backlog.map((i) => i.id));
    }

    return ids;
  }

  async getWorkItem(id: string): Promise<{
    id: string;
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

    const projectId = this.projectIds.find((pid) => String(pid) === String((item.raw as any)?.project_id)) ?? this.projectIds[0];
    let body = extractIssueBody(item.raw);

    // Fetch issue details for richer/full description where list payload is truncated.
    try {
      const details = await this.getIssueRaw(projectId, id);
      body = extractIssueBody(details) ?? body;
    } catch {
      // Best-effort, never fail read path because detail endpoint shape varies.
    }

    return {
      id: item.id,
      title: item.title,
      url: item.url,
      stage: item.stage.key,
      body,
      labels: item.labels,
      assignees: item.assignees,
      updatedAt: item.updatedAt,
    };
  }

  async listComments(
    id: string,
    opts: { limit: number; newestFirst: boolean; includeInternal: boolean },
  ): Promise<Array<{ id: string; body: string; createdAt?: Date; author?: { id?: string; username?: string; name?: string } }>> {
    const projectId = this.getSingleProjectId('listComments');
    const raw = await this.listCommentsViaApi(projectId, id);

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
    return ordered.slice(0, Math.max(1, opts.limit));
  }

  async listAttachments(_id: string): Promise<Array<{ filename: string; url: string }>> {
    return [];
  }

  async listLinkedWorkItems(_id: string): Promise<Array<{ id: string; title: string }>> {
    return [];
  }

  async setStage(id: string, stage: import('../stage.js').StageKey): Promise<void> {
    const projectId = this.getSingleProjectId('setStage');
    const stateId = await this.resolveStateIdForStage(stage);
    await this.cli.run([
      ...this.baseArgs,
      ...this.formatArgs,
      'issues',
      'update',
      '--project',
      projectId,
      '--state',
      stateId,
      id,
    ]);
  }

  async addComment(id: string, body: string): Promise<void> {
    const projectId = this.getSingleProjectId('addComment');
    const msg = String(body || '').trim();
    if (!msg) return;

    // Primary path: direct Plane API comments endpoint (avoids CLI 405 behavior).
    await this.postCommentViaApi(projectId, String(id), msg);
  }

  async createInBacklogAndAssignToSelf(input: { title: string; body: string }): Promise<{ id: string; url?: string }> {
    const projectId = this.getSingleProjectId('create');
    const backlogStateId = await this.resolveStateIdForStage('stage:todo');

    const created = (await this.runJson([
      'issues',
      'create',
      '--project',
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

    // Best-effort assign-to-self.
    try {
      const me = await this.whoami();
      if (me.id) {
        await this.cli.run([
          ...this.baseArgs,
          ...this.formatArgs,
          'issues',
          'assign',
          '--project',
          projectId,
          id,
          me.id,
        ]);
      }
    } catch {
      // ignore
    }

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
          .array(z.object({ name: z.string() }).passthrough())
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
                  name: z.string().optional(),
                  username: z.string().optional(),
                })
                .passthrough()
                .transform((a) => ({
                  id: a.id != null ? String(a.id) : undefined,
                  name: a.name,
                  username: a.username,
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

      items.set(issue.id, {
        id: issue.id,
        title,
        stage,
        url: issue.url,
        labels: issue.labels,
        assignees: issue.assignees,
        updatedAt: updatedAtRaw ? new Date(updatedAtRaw) : undefined,
        raw: issue,
      });
    }

    return items;
  }

  async fetchSnapshot(): Promise<ReadonlyMap<string, WorkItem>> {
    // Single-project snapshot (multi-project usage should call listBacklogIdsInOrder).
    const projectId = this.projectIds[0];
    return this.fetchSnapshotForProject(projectId);
  }
}

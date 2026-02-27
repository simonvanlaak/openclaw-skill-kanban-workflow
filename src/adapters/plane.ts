import type { Adapter } from '../adapter.js';
import type { WorkItem } from '../models.js';

import { z } from 'zod';

import { Stage } from '../stage.js';

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
      .map((i) => i.id);
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
      const args = ['issues', 'list', '-p', projectId] as string[];
      if (meId) args.push('--assignee', meId);

      // This call is intentionally constructed as `plane issues list ... -f json` to match
      // common wrapper usage (and our tests).
      const out = await this.cli.run([...this.baseArgs, ...args, ...this.formatArgs]);
      const issuesRaw = out.trim().length > 0 ? JSON.parse(out) : [];
      const issues = normalizePlaneIssuesList(issuesRaw);

      const snap = await this.fetchSnapshotForProject(projectId, issues);
      let backlog = [...snap.values()].filter((i) => i.stage.key === 'stage:backlog');

      // Hard safety: even if CLI-side --assignee filtering is ignored or unavailable,
      // only pick items explicitly assigned to me.
      if (meId) {
        backlog = backlog.filter((i) =>
          (i.assignees ?? []).some((a) => {
            if (typeof a === 'string') return String(a) === String(meId);
            const aid = (a as any)?.id;
            return aid ? String(aid) === String(meId) : false;
          }),
        );
      }

      // Try preserve explicit ordering if we can discover it; otherwise updatedAt desc.
      const orderField = this.orderField ?? discoverPlaneOrderField(issuesRaw);

      if (orderField) {
        const byId = new Map(issues.map((x: any) => [String(x.id), x] as const));
        const withOrder = backlog
          .map((i) => ({
            id: i.id,
            order: Number(byId.get(i.id)?.[orderField]),
            updatedAt: i.updatedAt,
          }))
          .filter((x) => Number.isFinite(x.order));

        if (withOrder.length > 0) {
          withOrder.sort((a, b) => a.order - b.order);
          const orderedIds = withOrder.map((x) => x.id);
          const orderedSet = new Set(orderedIds);

          const rest = backlog
            .filter((i) => !orderedSet.has(i.id))
            .sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0))
            .map((i) => i.id);

          ids.push(...orderedIds, ...rest);
          continue;
        }
      }

      // updatedAt desc fallback
      backlog.sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
      ids.push(...backlog.map((i) => i.id));
    }

    return ids;

    // If we can't discover an explicit ordering field, we fall back to updatedAt desc.
    // (Some Plane surfaces don't expose a stable ordering field in the list response.)

    // We re-use fetchSnapshot for stage mapping, but we need raw ordering values.
    const snap = await this.fetchSnapshot();
    const backlog = [...snap.values()].filter((i) => i.stage.key === 'stage:backlog');

    if (orderField) {
      const byId = new Map(issues.map((x: any) => [String(x.id), x] as const));
      const withOrder = backlog
        .map((i) => ({
          id: i.id,
          order: Number(byId.get(i.id)?.[orderField]),
          updatedAt: i.updatedAt,
        }))
        .filter((x) => Number.isFinite(x.order));

      if (withOrder.length > 0) {
        withOrder.sort((a, b) => a.order - b.order);
        const orderedIds = withOrder.map((x) => x.id);
        const orderedSet = new Set(orderedIds);

        const rest = backlog
          .filter((i) => !orderedSet.has(i.id))
          .sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0))
          .map((i) => i.id);

        return [...orderedIds, ...rest];
      }
    }

    // updatedAt desc fallback
    return [...backlog]
      .sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0))
      .map((i) => i.id);
  }

  async getWorkItem(id: string): Promise<{
    id: string;
    title: string;
    url?: string;
    stage: import('../stage.js').StageKey;
    body?: string;
    labels: string[];
    updatedAt?: Date;
  }> {
    const snap = await this.fetchSnapshot();
    const item = snap.get(id);
    if (!item) throw new Error(`Plane work item not found: ${id}`);

    return {
      id: item.id,
      title: item.title,
      url: item.url,
      stage: item.stage.key,
      body: undefined,
      labels: item.labels,
      updatedAt: item.updatedAt,
    };
  }

  async listComments(
    _id: string,
    _opts: { limit: number; newestFirst: boolean; includeInternal: boolean },
  ): Promise<Array<{ id: string; body: string }>> {
    return [];
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
    await this.cli.run([
      ...this.baseArgs,
      ...this.formatArgs,
      'comments',
      'add',
      '--project',
      projectId,
      '--issue',
      id,
      body,
    ]);
  }

  async createInBacklogAndAssignToSelf(input: { title: string; body: string }): Promise<{ id: string; url?: string }> {
    const projectId = this.getSingleProjectId('create');
    const backlogStateId = await this.resolveStateIdForStage('stage:backlog');

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
        issuesRaw ?? ((await this.runJson(['issues', 'list', '--project', projectId])) ?? []),
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

      const stateName = issue.state?.name ?? issue.state_detail?.name;
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

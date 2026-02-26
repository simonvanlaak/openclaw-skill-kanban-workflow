import type { Adapter } from '../adapter.js';
import type { WorkItem } from '../models.js';

import { z } from 'zod';

import { Stage } from '../stage.js';

function discoverPlaneOrderField(issues: any[]): string | undefined {
  // Best-effort heuristics. Plane often uses numeric ordering fields.
  const candidates = ['sort_order', 'sortOrder', 'rank', 'position', 'order', 'sequence_id', 'sequenceId'];
  for (const field of candidates) {
    const has = issues.some((x: any) => x && typeof x === 'object' && field in x);
    if (has) return field;
  }
  return undefined;
}

import { CliRunner } from './cli.js';

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
  private readonly workspaceSlug: string;
  private readonly projectId: string;
  private readonly stateMap: Readonly<Record<string, string>>;
  private readonly orderField?: string;

  constructor(opts: {
    workspaceSlug: string;
    projectId: string;
    bin?: string;
    baseArgs?: readonly string[];
    /** Optional mapping: Plane state name -> canonical stage key (or any Stage.fromAny input). */
    stateMap?: Readonly<Record<string, string>>;
    /** Explicit ordering field name when UI order can't be discovered. */
    orderField?: string;
  }) {
    this.cli = new CliRunner(opts.bin ?? 'plane');
    this.baseArgs = opts.baseArgs ?? [];
    this.workspaceSlug = opts.workspaceSlug;
    this.projectId = opts.projectId;
    this.stateMap = opts.stateMap ?? {};
    this.orderField = opts.orderField;
  }

  name(): string {
    return 'plane';
  }

  // ---- Verb-level (workflow) API (best-effort; depends on plane-cli surface) ----

  async whoami(): Promise<{ id?: string; username?: string; name?: string }> {
    const out = await this.cli.run([
      ...this.baseArgs,
      'request',
      this.workspaceSlug,
      '/api/v1/users/me/',
    ]);

    const parsed = out.trim().length > 0 ? JSON.parse(out) : {};
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
    const out = await this.cli.run([
      ...this.baseArgs,
      'workitems',
      this.workspaceSlug,
      this.projectId,
    ]);

    const issues = JSON.parse(out || '[]');

    const orderField = this.orderField ?? discoverPlaneOrderField(issues);

    if (this.orderField === undefined && orderField === undefined) {
      // Can't discover; ask setup to provide.
      throw new Error(
        'Plane ordering not discoverable. Re-run setup with --plane-order-field <fieldName> to match UI order, or accept updatedAt fallback by specifying a field.',
      );
    }

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

  async listLinkedWorkItems(_id: string): Promise<Array<{ id: string; title: string }>> {
    return [];
  }

  async setStage(_id: string, _stage: import('../stage.js').StageKey): Promise<void> {
    throw new Error('PlaneAdapter.setStage not implemented (requires plane-cli write support)');
  }

  async addComment(_id: string, _body: string): Promise<void> {
    throw new Error('PlaneAdapter.addComment not implemented (requires plane-cli write support)');
  }

  async createInBacklogAndAssignToSelf(_input: { title: string; body: string }): Promise<{ id: string; url?: string }> {
    throw new Error('PlaneAdapter.create not implemented (requires plane-cli write support)');
  }

  async fetchSnapshot(): Promise<ReadonlyMap<string, WorkItem>> {
    const out = await this.cli.run([
      ...this.baseArgs,
      'workitems',
      this.workspaceSlug,
      this.projectId,
    ]);

    const StateSchema = z
      .object({
        name: z.string().optional(),
      })
      .passthrough();

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

      const stageSource = this.stateMap[stateName] ?? stateName;

      let stage: Stage;
      try {
        stage = Stage.fromAny(stageSource);
      } catch {
        // If Plane states don't match canonical stages, skip rather than mis-classify.
        continue;
      }

      const updatedAtRaw = issue.updatedAt ?? issue.updated_at;

      items.set(issue.id, {
        id: issue.id,
        title,
        stage,
        url: issue.url,
        labels: issue.labels,
        updatedAt: updatedAtRaw ? new Date(updatedAtRaw) : undefined,
        raw: issue,
      });
    }

    return items;
  }
}

import type { Adapter } from '../adapter.js';
import type { WorkItem } from '../models.js';

import { z } from 'zod';

import { Stage, type StageKey } from '../stage.js';

import { CliRunner } from './cli.js';

function discoverPlaneOrderField(issues: any[]): string | undefined {
  // Best-effort heuristics. Plane often uses numeric ordering fields.
  const candidates = ['sort_order', 'sortOrder', 'rank', 'position', 'order', 'sequence_id', 'sequenceId'];
  for (const field of candidates) {
    const has = issues.some((x: any) => x && typeof x === 'object' && field in x);
    if (has) return field;
  }
  return undefined;
}

/**
 * Plane adapter (CLI-auth only).
 *
 * Expected CLI:
 * - ClawHub skill: `plane` (owner: vaguilera-jinko)
 * - Binary: `plane`
 *
 * Auth is handled by that CLI via environment variables (no direct HTTP auth here):
 * - `PLANE_API_KEY`
 * - `PLANE_WORKSPACE`
 *
 * Commands used (JSON format):
 * - `plane me -f json`
 * - `plane projects list -f json`
 * - `plane issues list -p <project_id> -f json`
 * - `plane issues get -p <project_id> <issue_id> -f json`
 * - `plane issues update -p <project_id> <issue_id> --state <state_id>`
 */
export class PlaneAdapter implements Adapter {
  private readonly cli: CliRunner;
  private readonly baseArgs: readonly string[];

  // NOTE: kept for backwards compatibility with current config surface.
  // The plane CLI itself uses `PLANE_WORKSPACE` for workspace selection.
  private readonly workspaceSlug: string;

  private readonly projectId: string;
  private readonly stageMap: Readonly<Record<string, StageKey>>;
  private readonly orderField?: string;

  constructor(opts: {
    workspaceSlug: string;
    projectId: string;
    bin?: string;
    baseArgs?: readonly string[];
    /** Required mapping: Plane state/list names -> canonical stage key. */
    stageMap: Readonly<Record<string, StageKey>>;
    /** Explicit ordering field name when UI order can't be discovered. */
    orderField?: string;
  }) {
    this.cli = new CliRunner(opts.bin ?? 'plane');
    this.baseArgs = opts.baseArgs ?? [];
    this.workspaceSlug = opts.workspaceSlug;
    this.projectId = opts.projectId;
    this.stageMap = opts.stageMap;
    this.orderField = opts.orderField;
  }

  name(): string {
    return 'plane';
  }

  async whoami(): Promise<{ id?: string; username?: string; name?: string }> {
    // Setup validation expects both identity AND basic read access.
    const meOut = await this.cli.run([...this.baseArgs, 'me', '-f', 'json']);

    // Validate we can read project metadata too.
    await this.cli.run([...this.baseArgs, 'projects', 'list', '-f', 'json']);

    const parsed = meOut.trim().length > 0 ? JSON.parse(meOut) : {};
    const me = parsed?.me ?? parsed?.data?.me ?? parsed;

    return {
      id: me?.id ? String(me.id) : undefined,
      username: me?.email ? String(me.email) : me?.username ? String(me.username) : undefined,
      name: me?.display_name
        ? String(me.display_name)
        : me?.displayName
          ? String(me.displayName)
          : me?.name
            ? String(me.name)
            : undefined,
    };
  }

  async listIdsByStage(stage: StageKey): Promise<string[]> {
    const snap = await this.fetchSnapshot();
    return [...snap.values()]
      .filter((i) => i.stage.key === stage)
      .map((i) => i.id);
  }

  private async listIssuesRaw(): Promise<unknown[]> {
    const out = await this.cli.run([...this.baseArgs, 'issues', 'list', '-p', this.projectId, '-f', 'json']);
    const parsed = out.trim().length > 0 ? JSON.parse(out) : [];

    return Array.isArray(parsed)
      ? parsed
      : parsed?.results && Array.isArray(parsed.results)
        ? parsed.results
        : [];
  }

  private async getIssueRaw(issueId: string): Promise<any> {
    const out = await this.cli.run([
      ...this.baseArgs,
      'issues',
      'get',
      '-p',
      this.projectId,
      issueId,
      '-f',
      'json',
    ]);

    const parsed = out.trim().length > 0 ? JSON.parse(out) : {};
    return parsed?.issue ?? parsed?.data?.issue ?? parsed;
  }

  private async listStatesRaw(): Promise<Array<{ id?: string; name?: string }>> {
    // Best-effort: the plane CLI may expose this as `states list`.
    const out = await this.cli.run([...this.baseArgs, 'states', 'list', '-p', this.projectId, '-f', 'json']);
    const parsed = out.trim().length > 0 ? JSON.parse(out) : [];

    const arr: unknown[] = Array.isArray(parsed)
      ? parsed
      : parsed?.results && Array.isArray(parsed.results)
        ? parsed.results
        : [];

    return arr
      .filter((x): x is any => x && typeof x === 'object')
      .map((x: any) => ({ id: x.id ? String(x.id) : undefined, name: x.name ? String(x.name) : undefined }));
  }

  private mapIssuesToSnapshot(rawIssues: unknown[]): ReadonlyMap<string, WorkItem> {
    const StateSchema = z
      .object({
        id: z.union([z.string(), z.number()]).optional().transform((v) => (v == null ? undefined : String(v))),
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
    const issues = ParsedSchema.parse(rawIssues);

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
        updatedAt: updatedAtRaw ? new Date(updatedAtRaw) : undefined,
        raw: issue,
      });
    }

    return items;
  }

  async listBacklogIdsInOrder(): Promise<string[]> {
    // Try to preserve explicit UI ordering if we can discover it from issue fields.
    // Otherwise require an explicit order field from setup, and finally fall back to updatedAt desc.
    const rawIssues = await this.listIssuesRaw();

    const orderField = this.orderField ?? discoverPlaneOrderField(rawIssues as any[]);

    if (this.orderField === undefined && orderField === undefined) {
      throw new Error(
        'Plane ordering not discoverable. Re-run setup with --plane-order-field <fieldName> to match UI order, or accept updatedAt fallback by specifying a field.',
      );
    }

    const snap = this.mapIssuesToSnapshot(rawIssues);
    const backlog = [...snap.values()].filter((i) => i.stage.key === 'stage:backlog');

    if (orderField) {
      const byId = new Map((rawIssues as any[]).map((x: any) => [String(x?.id), x] as const));
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

    return [...backlog]
      .sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0))
      .map((i) => i.id);
  }

  async getWorkItem(id: string): Promise<{
    id: string;
    title: string;
    url?: string;
    stage: StageKey;
    body?: string;
    labels: string[];
    updatedAt?: Date;
  }> {
    const issue = await this.getIssueRaw(id);

    const snap = this.mapIssuesToSnapshot([issue]);
    const item = snap.get(String(id));
    if (!item) throw new Error(`Plane work item not found or unmapped stage: ${id}`);

    return {
      id: item.id,
      title: item.title,
      url: item.url,
      stage: item.stage.key,
      body: issue?.description_html ? String(issue.description_html) : issue?.description ? String(issue.description) : undefined,
      labels: item.labels,
      updatedAt: item.updatedAt,
    };
  }

  async listComments(
    id: string,
    opts: { limit: number; newestFirst: boolean; includeInternal: boolean },
  ): Promise<Array<{ id: string; body: string }>> {
    // Best-effort: not all plane CLIs expose comments.
    try {
      const out = await this.cli.run([
        ...this.baseArgs,
        'comments',
        'list',
        '-p',
        this.projectId,
        id,
        '-f',
        'json',
      ]);

      const parsed = out.trim().length > 0 ? JSON.parse(out) : [];
      const arr: any[] = Array.isArray(parsed)
        ? parsed
        : parsed?.results && Array.isArray(parsed.results)
          ? parsed.results
          : [];

      let mapped = arr
        .map((c: any) => ({ id: c?.id ? String(c.id) : undefined, body: c?.comment_html ?? c?.comment ?? c?.body }))
        .filter((c) => c.id && typeof c.body === 'string')
        .map((c) => ({ id: c.id as string, body: String(c.body) }));

      if (opts.newestFirst) mapped = mapped.reverse();
      return mapped.slice(0, opts.limit);
    } catch {
      return [];
    }
  }

  async listAttachments(id: string): Promise<Array<{ filename: string; url: string }>> {
    const issue = await this.getIssueRaw(id);

    const raw: any[] = Array.isArray(issue?.attachments)
      ? issue.attachments
      : Array.isArray(issue?.attachment)
        ? issue.attachment
        : [];

    return raw
      .map((a: any) => ({
        filename: a?.file_name ?? a?.fileName ?? a?.name ?? a?.filename,
        url: a?.url ?? a?.asset_url ?? a?.assetUrl,
      }))
      .filter(
        (x) => typeof x.filename === 'string' && x.filename.length > 0 && typeof x.url === 'string' && x.url.length > 0,
      )
      .map((x) => ({ filename: String(x.filename), url: String(x.url) }));
  }

  async listLinkedWorkItems(id: string): Promise<Array<{ id: string; title: string }>> {
    // Best-effort: relation schemas vary.
    const issue = await this.getIssueRaw(id);

    const rels: any[] = Array.isArray(issue?.relations)
      ? issue.relations
      : Array.isArray(issue?.related_issues)
        ? issue.related_issues
        : Array.isArray(issue?.linked_issues)
          ? issue.linked_issues
          : [];

    return rels
      .map((r: any) => {
        const other = r?.issue ?? r?.related_issue ?? r?.linked_issue ?? r;
        return {
          id: other?.id ? String(other.id) : undefined,
          title: other?.name ?? other?.title,
        };
      })
      .filter((x) => typeof x.id === 'string' && x.id.length > 0 && typeof x.title === 'string' && x.title.length > 0)
      .map((x) => ({ id: String(x.id), title: String(x.title) }));
  }

  async setStage(id: string, stage: StageKey): Promise<void> {
    const states = await this.listStatesRaw();

    const state = states.find((s) => {
      if (!s?.name) return false;
      const mapped = this.stageMap[String(s.name)];
      return mapped === stage;
    });

    const stateId = state?.id;
    if (!stateId) {
      throw new Error(
        `No Plane state found mapping to ${stage}. Check your stageMap and Plane states (workspace=${this.workspaceSlug}, project=${this.projectId}).`,
      );
    }

    await this.cli.run([
      ...this.baseArgs,
      'issues',
      'update',
      '-p',
      this.projectId,
      id,
      '--state',
      stateId,
    ]);
  }

  async addComment(_id: string, _body: string): Promise<void> {
    throw new Error('PlaneAdapter.addComment not implemented (CLI surface not confirmed)');
  }

  async createInBacklogAndAssignToSelf(_input: { title: string; body: string }): Promise<{ id: string; url?: string }> {
    throw new Error('PlaneAdapter.create not implemented (CLI surface not confirmed)');
  }

  async fetchSnapshot(): Promise<ReadonlyMap<string, WorkItem>> {
    const rawIssues = await this.listIssuesRaw();
    return this.mapIssuesToSnapshot(rawIssues);
  }
}

import type { Adapter } from '../adapter.js';
import type { WorkItem } from '../models.js';

import { z } from 'zod';

import { Stage } from '../stage.js';

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

  constructor(opts: {
    workspaceSlug: string;
    projectId: string;
    bin?: string;
    baseArgs?: readonly string[];
    /** Optional mapping: Plane state name -> canonical stage key (or any Stage.fromAny input). */
    stateMap?: Readonly<Record<string, string>>;
  }) {
    this.cli = new CliRunner(opts.bin ?? 'plane');
    this.baseArgs = opts.baseArgs ?? [];
    this.workspaceSlug = opts.workspaceSlug;
    this.projectId = opts.projectId;
    this.stateMap = opts.stateMap ?? {};
  }

  name(): string {
    return 'plane';
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

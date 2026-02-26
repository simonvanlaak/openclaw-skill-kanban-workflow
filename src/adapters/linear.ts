import type { Adapter } from '../adapter.js';
import type { WorkItem } from '../models.js';

import { Stage, type StageKey } from '../stage.js';

import { CliRunner } from './cli.js';

type LinearIssueNode = {
  id: string;
  title: string;
  url?: string;
  updatedAt?: string;
  state?: {
    id?: string;
    name?: string;
    type?: string;
  };
};

type LinearCliIssuesResponse = {
  data?: {
    issues?: {
      nodes?: LinearIssueNode[];
    };
  };
};

export type LinearAdapterOptions = {
  /**
   * Binary to execute.
   *
   * Default: `linear` (wrapper script from https://github.com/simonvanlaak/linear-cli)
   */
  bin?: string;

  /**
   * Optional arguments prepended to every command.
   *
   * Example (Api2Cli direct):
   *   ["--config", ".../linear-cli/a2c", "--workspace", "linear"]
   */
  baseArgs?: readonly string[];

  /** Provide either teamId OR projectId (exactly one). */
  teamId?: string;
  projectId?: string;

  /** Map Linear workflow state name -> canonical StageKey. */
  stateMap?: Readonly<Record<string, StageKey>>;
};

/**
 * Linear adapter (CLI-auth only).
 *
 * Expected CLI:
 * - https://github.com/simonvanlaak/linear-cli
 *
 * It should support:
 * - `issues-team <team_id>`
 * - `issues-project <project_id>`
 * and return JSON containing `data.issues.nodes[]`.
 */
export class LinearAdapter implements Adapter {
  private readonly cli: CliRunner;
  private readonly baseArgs: readonly string[];
  private readonly teamId?: string;
  private readonly projectId?: string;
  private readonly stateMap: Readonly<Record<string, StageKey>>;

  constructor(opts: LinearAdapterOptions) {
    this.cli = new CliRunner(opts.bin ?? 'linear');
    this.baseArgs = opts.baseArgs ?? [];
    this.teamId = opts.teamId;
    this.projectId = opts.projectId;
    this.stateMap = opts.stateMap ?? {};
  }

  name(): string {
    return 'linear';
  }

  async fetchSnapshot(): Promise<ReadonlyMap<string, WorkItem>> {
    if ((this.teamId && this.projectId) || (!this.teamId && !this.projectId)) {
      throw new Error('LinearAdapter requires exactly one of: teamId, projectId');
    }

    const cmd = this.teamId
      ? (['issues-team', this.teamId] as const)
      : (['issues-project', this.projectId!] as const);

    const out = await this.cli.run([...this.baseArgs, ...cmd]);
    const parsed: LinearCliIssuesResponse = out.trim().length > 0 ? JSON.parse(out) : {};
    const nodes = parsed.data?.issues?.nodes ?? [];

    const items = new Map<string, WorkItem>();

    for (const node of nodes) {
      const stateName = node.state?.name;
      if (!stateName) continue;

      const mapped = this.stateMap[stateName];
      let stage: Stage;

      try {
        stage = mapped ? Stage.fromAny(mapped) : Stage.fromAny(stateName);
      } catch {
        // If the workflow state isn't part of our canonical set (and isn't mapped), skip it.
        continue;
      }

      const updatedAt = node.updatedAt ? new Date(node.updatedAt) : undefined;
      if (updatedAt && Number.isNaN(updatedAt.getTime())) {
        throw new Error(`Invalid Linear updatedAt datetime: ${node.updatedAt}`);
      }

      items.set(node.id, {
        id: node.id,
        title: node.title,
        stage,
        url: node.url,
        labels: [],
        updatedAt,
        raw: node as unknown as Record<string, unknown>,
      });
    }

    return items;
  }
}

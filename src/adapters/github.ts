import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { Adapter } from '../adapter.js';
import type { WorkItem } from '../models.js';
import { Stage } from '../stage.js';

import { CliRunner } from './cli.js';

export type GitHubIssue = {
  number: number;
  title: string;
  url: string;
  state: string;
  updatedAt: Date;
  labels: string[];
};

export type GitHubIssueEvent = {
  kind: 'created' | 'updated' | 'labels_changed';
  issueNumber: number;
  updatedAt: Date;
  details: Record<string, unknown>;
};

type GhIssueListJson = {
  number: number;
  title?: string;
  url?: string;
  state?: string;
  updatedAt: string;
  labels?: Array<{ name: string }>;
};

function parseGitHubDate(value: string): Date {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) {
    throw new Error(`Invalid GitHub datetime: ${value}`);
  }
  return dt;
}

function toIsoZ(dt: Date): string {
  return dt.toISOString();
}

function pickStageLabel(labels: readonly string[]): string | undefined {
  const stageLabels = labels.filter((l) => l.toLowerCase().startsWith('stage:')).sort();
  return stageLabels[0];
}

export class GhCli extends CliRunner {
  constructor() {
    super('gh');
  }
}

type SnapshotIssue = {
  updatedAt: string;
  labels: string[];
  title: string;
  url: string;
  state: string;
};

type Snapshot = Record<string, SnapshotIssue> & {
  _meta?: {
    repo: string;
    lastPolledAt: string;
  };
};

export class GitHubAdapter implements Adapter {
  private readonly repo: string;
  private readonly snapshotPath: string;
  private readonly gh: GhCli;
  private readonly project?: { owner: string; number: number };

  constructor(opts: { repo: string; snapshotPath: string; gh?: GhCli; project?: { owner: string; number: number } }) {
    this.repo = opts.repo;
    this.snapshotPath = opts.snapshotPath;
    this.gh = opts.gh ?? new GhCli();
    this.project = opts.project;
  }

  name(): string {
    return `github:${this.repo}`;
  }

  async fetchSnapshot(): Promise<ReadonlyMap<string, WorkItem>> {
    const issues = await this.listOpenIssuesWithStageLabels({ limit: 200 });
    const items = new Map<string, WorkItem>();

    for (const issue of issues) {
      const stageLabel = pickStageLabel(issue.labels);
      if (!stageLabel) continue;

      items.set(String(issue.number), {
        id: String(issue.number),
        title: issue.title,
        stage: Stage.fromAny(stageLabel),
        url: issue.url,
        labels: issue.labels,
        updatedAt: issue.updatedAt,
        raw: {
          number: issue.number,
          state: issue.state,
          updatedAt: issue.updatedAt.toISOString(),
        },
      });
    }

    return items;
  }

  async listOpenIssuesWithStageLabels(opts?: { limit?: number }): Promise<GitHubIssue[]> {
    const limit = opts?.limit ?? 200;
    const issues = await this.listIssues({ state: 'open', limit });

    return issues
      .filter((i) => i.labels.some((l) => l.startsWith('stage:')))
      .map((i) => {
        const stageLabels = [...i.labels].filter((l) => l.startsWith('stage:')).sort();
        const otherLabels = [...i.labels].filter((l) => !l.startsWith('stage:')).sort();
        return {
          ...i,
          labels: [...stageLabels, ...otherLabels]
        };
      });
  }

  async addComment(opts: { issueNumber: number; body: string }): Promise<void> {
    await this.gh.run([
      'issue',
      'comment',
      String(opts.issueNumber),
      '--repo',
      this.repo,
      '--body',
      opts.body
    ]);
  }

  async addLabels(opts: { issueNumber: number; labels: Iterable<string> }): Promise<void> {
    const labels = Array.from(opts.labels);
    if (labels.length === 0) return;

    await this.gh.run([
      'issue',
      'edit',
      String(opts.issueNumber),
      '--repo',
      this.repo,
      '--add-label',
      labels.join(',')
    ]);
  }

  async removeLabels(opts: { issueNumber: number; labels: Iterable<string> }): Promise<void> {
    const labels = Array.from(opts.labels);
    if (labels.length === 0) return;

    await this.gh.run([
      'issue',
      'edit',
      String(opts.issueNumber),
      '--repo',
      this.repo,
      '--remove-label',
      labels.join(',')
    ]);
  }

  // ---- Verb-level (workflow) API ----

  async whoami(): Promise<{ username: string }> {
    const out = await this.gh.run(['api', 'user', '--jq', '.login']);
    const login = out.trim().replaceAll('"', '');
    if (!login) throw new Error('gh api user did not return login');
    return { username: login };
  }

  async listIdsByStage(stage: string): Promise<string[]> {
    const issues = await this.listIssues({ state: 'open', limit: 200, search: `label:${stage}` });
    return issues.map((i) => String(i.number));
  }

  async listBacklogIdsInOrder(): Promise<string[]> {
    const all = await this.listOpenIssuesWithStageLabels({ limit: 200 });
    const backlog = all.filter((i) => i.labels.includes('stage:backlog'));

    const byUpdatedDesc = [...backlog].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    if (!this.project) {
      return byUpdatedDesc.map((i) => String(i.number));
    }

    const projectOrdered = await this.listProjectIssueNumbersInOrder({
      owner: this.project.owner,
      number: this.project.number,
    });

    const backlogByNumber = new Map(backlog.map((i) => [i.number, i] as const));
    const picked: number[] = [];

    for (const n of projectOrdered) {
      if (backlogByNumber.has(n)) picked.push(n);
    }

    const pickedSet = new Set(picked);
    for (const i of byUpdatedDesc) {
      if (!pickedSet.has(i.number)) picked.push(i.number);
    }

    return picked.map(String);
  }

  async getWorkItem(id: string): Promise<{
    id: string;
    title: string;
    url?: string;
    stage: import('../stage.js').StageKey;
    body?: string;
    labels: string[];
    assignees?: Array<{ username?: string; name?: string; id?: string }>;
    updatedAt?: Date;
  }> {
    const out = await this.gh.run([
      'issue',
      'view',
      String(id),
      '--repo',
      this.repo,
      '--json',
      'number,title,url,body,updatedAt,labels,assignees'
    ]);

    const parsed = out.trim().length > 0 ? JSON.parse(out) : {};
    const labels = (parsed.labels ?? []).map((l: any) => String(l.name)).sort();
    const stageLabel = pickStageLabel(labels);
    if (!stageLabel) throw new Error(`Issue ${id} missing stage:* label`);

    const assignees = (parsed.assignees ?? []).map((a: any) => ({ username: a?.login, name: a?.name }));

    return {
      id: String(parsed.number ?? id),
      title: String(parsed.title ?? ''),
      url: parsed.url ? String(parsed.url) : undefined,
      stage: Stage.fromAny(stageLabel).key,
      body: parsed.body ? String(parsed.body) : undefined,
      labels,
      assignees,
      updatedAt: parsed.updatedAt ? parseGitHubDate(String(parsed.updatedAt)) : undefined,
    };
  }

  async listComments(
    id: string,
    opts: { limit: number; newestFirst: boolean; includeInternal: boolean },
  ): Promise<Array<{ id: string; body: string; createdAt?: Date; author?: { username?: string } }>> {
    void opts.includeInternal; // GitHub issue comments have no "internal" concept.

    const out = await this.gh.run([
      'issue',
      'view',
      String(id),
      '--repo',
      this.repo,
      '--json',
      'comments'
    ]);

    const parsed = out.trim().length > 0 ? JSON.parse(out) : {};
    const comments = (parsed.comments ?? []).map((c: any) => ({
      id: String(c.id ?? ''),
      body: String(c.body ?? ''),
      createdAt: c.createdAt ? parseGitHubDate(String(c.createdAt)) : undefined,
      author: c.author ? { username: String(c.author.login ?? '') } : undefined,
    }));

    const sorted = [...comments].sort((a: any, b: any) => {
      const at = a.createdAt ? a.createdAt.getTime() : 0;
      const bt = b.createdAt ? b.createdAt.getTime() : 0;
      return opts.newestFirst ? bt - at : at - bt;
    });

    return sorted.slice(0, opts.limit);
  }

  async listLinkedWorkItems(_id: string): Promise<Array<{ id: string; title: string }>> {
    // TODO: GitHub linked/related issues require GraphQL or parsing timeline items.
    return [];
  }

  async setStage(id: string, stage: import('../stage.js').StageKey): Promise<void> {
    const details = await this.getWorkItem(id);
    const currentStageLabels = details.labels.filter((l) => l.toLowerCase().startsWith('stage:'));
    const desired = stage;

    const toRemove = currentStageLabels.filter((l) => l !== desired);
    if (toRemove.length > 0) {
      await this.removeLabels({ issueNumber: Number(id), labels: toRemove });
    }
    if (!details.labels.includes(desired)) {
      await this.addLabels({ issueNumber: Number(id), labels: [desired] });
    }
  }

  async createInBacklogAndAssignToSelf(input: { title: string; body: string }): Promise<{ id: string; url?: string }> {
    const self = await this.whoami();
    const out = await this.gh.run([
      'issue',
      'create',
      '--repo',
      this.repo,
      '--title',
      input.title,
      '--body',
      input.body,
      '--assignee',
      self.username,
      '--label',
      'stage:backlog'
    ]);

    const url = out.trim();
    const m = url.match(/\/issues\/(\d+)(?:\b|\/|$)/);
    const id = m?.[1];
    if (!id) {
      throw new Error(`Unable to parse created issue number from gh output: ${JSON.stringify(out)}`);
    }

    return { id, url };
  }

  private async listProjectIssueNumbersInOrder(opts: { owner: string; number: number }): Promise<number[]> {
    const out = await this.gh.run([
      'project',
      'item-list',
      String(opts.number),
      '--owner',
      opts.owner,
      '--limit',
      '200',
      '--format',
      'json'
    ]);

    const parsed = out.trim().length > 0 ? JSON.parse(out) : {};
    const items = Array.isArray(parsed.items) ? parsed.items : Array.isArray(parsed) ? parsed : [];

    const numbers: number[] = [];
    for (const item of items) {
      const n = item?.content?.number;
      if (typeof n === 'number') numbers.push(n);
    }
    return numbers;
  }

  async pollEventsSince(opts: { since: Date }): Promise<GitHubIssueEvent[]> {
    const since = opts.since;
    const snapshot = await this.loadSnapshot();

    const day = since.toISOString().slice(0, 10);
    const search = `is:issue updated:>=${day}`;
    const updated = await this.listIssues({ state: 'open', limit: 200, search });

    const events: GitHubIssueEvent[] = [];

    for (const issue of updated) {
      if (issue.updatedAt.getTime() < since.getTime()) continue;

      const prev = snapshot[String(issue.number)];
      if (!prev) {
        events.push({
          kind: 'created',
          issueNumber: issue.number,
          updatedAt: issue.updatedAt,
          details: { title: issue.title, labels: [...issue.labels] }
        });
      } else {
        const prevUpdatedAt = parseGitHubDate(prev.updatedAt);
        const prevLabels = new Set(prev.labels ?? []);
        const currLabels = new Set(issue.labels);

        const added = [...currLabels].filter((l) => !prevLabels.has(l)).sort();
        const removed = [...prevLabels].filter((l) => !currLabels.has(l)).sort();

        if (added.length > 0 || removed.length > 0) {
          events.push({
            kind: 'labels_changed',
            issueNumber: issue.number,
            updatedAt: issue.updatedAt,
            details: { added, removed }
          });
        } else if (issue.updatedAt.getTime() > prevUpdatedAt.getTime()) {
          events.push({
            kind: 'updated',
            issueNumber: issue.number,
            updatedAt: issue.updatedAt,
            details: {}
          });
        }
      }

      snapshot[String(issue.number)] = {
        updatedAt: toIsoZ(issue.updatedAt),
        labels: [...issue.labels],
        title: issue.title,
        url: issue.url,
        state: issue.state
      };
    }

    snapshot._meta = {
      repo: this.repo,
      lastPolledAt: toIsoZ(new Date())
    };

    await this.saveSnapshot(snapshot);
    return events;
  }

  private async listIssues(opts: {
    state: 'open' | 'closed' | 'all';
    limit: number;
    search?: string;
  }): Promise<GitHubIssue[]> {
    const args = [
      'issue',
      'list',
      '--repo',
      this.repo,
      '--state',
      opts.state,
      '--limit',
      String(opts.limit),
      '--json',
      'number,title,url,state,updatedAt,labels'
    ];
    if (opts.search) {
      args.push('--search', opts.search);
    }

    const out = await this.gh.run(args);
    const raw: GhIssueListJson[] = out.trim().length > 0 ? JSON.parse(out) : [];

    return raw.map((obj) => {
      const labels = (obj.labels ?? []).map((l) => l.name).sort();
      return {
        number: Number(obj.number),
        title: String(obj.title ?? ''),
        url: String(obj.url ?? ''),
        state: String(obj.state ?? ''),
        updatedAt: parseGitHubDate(String(obj.updatedAt)),
        labels
      };
    });
  }

  private async loadSnapshot(): Promise<Snapshot> {
    try {
      const text = await fs.readFile(this.snapshotPath, 'utf-8');
      return JSON.parse(text) as Snapshot;
    } catch (err: any) {
      if (err?.code === 'ENOENT') return {};
      throw err;
    }
  }

  private async saveSnapshot(snapshot: Snapshot): Promise<void> {
    await fs.mkdir(path.dirname(this.snapshotPath), { recursive: true });
    await fs.writeFile(this.snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8');
  }
}

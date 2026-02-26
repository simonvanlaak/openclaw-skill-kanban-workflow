import { execa } from 'execa';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export class GhCliError extends Error {
  override name = 'GhCliError';
}

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

export class GhCli {
  async run(args: string[]): Promise<string> {
    try {
      const proc = await execa('gh', args, {
        stdout: 'pipe',
        stderr: 'pipe'
      });
      return proc.stdout;
    } catch (err: any) {
      const message = typeof err?.message === 'string' ? err.message : String(err);
      const stderr = typeof err?.stderr === 'string' ? err.stderr : '';
      throw new GhCliError(
        `gh command failed: gh ${args.join(' ')}\n${message}${stderr ? `\n${stderr}` : ''}`.trim()
      );
    }
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

export class GitHubAdapter {
  private readonly repo: string;
  private readonly snapshotPath: string;
  private readonly gh: GhCli;

  constructor(opts: { repo: string; snapshotPath: string; gh?: GhCli }) {
    this.repo = opts.repo;
    this.snapshotPath = opts.snapshotPath;
    this.gh = opts.gh ?? new GhCli();
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

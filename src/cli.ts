import * as fs from 'node:fs/promises';

import { loadConfigFromFile } from './config.js';
import { runSetup } from './setup.js';
import { GitHubAdapter } from './adapters/github.js';
import { LinearAdapter } from './adapters/linear.js';
import { PlaneAdapter } from './adapters/plane.js';
import { PlankaAdapter } from './adapters/planka.js';
import { ask, complete, create, next, show, start, update } from './verbs/verbs.js';

export type CliIo = {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string | boolean> } {
  const [cmd = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (!tok.startsWith('--')) continue;

    const key = tok.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }

  return { cmd, flags };
}

export async function runCli(rawArgv: string[], io: CliIo = { stdout: process.stdout, stderr: process.stderr }): Promise<number> {
  const { cmd, flags } = parseArgs(rawArgv);
  const configPath = String(flags.config ?? 'config/clawban.json');

  try {
    if (cmd === 'setup') {
      const force = Boolean(flags.force);

      const adapters: any[] = [];

      if (flags['github-repo']) {
        const repo = String(flags['github-repo']);
        const owner = flags['github-project-owner'] ? String(flags['github-project-owner']) : undefined;
        const number = flags['github-project-number'] ? Number(flags['github-project-number']) : undefined;
        adapters.push({
          kind: 'github',
          repo,
          project: owner && number ? { owner, number } : undefined,
        });
      }

      if (flags['linear-team-id'] || flags['linear-project-id']) {
        adapters.push({
          kind: 'linear',
          teamId: flags['linear-team-id'] ? String(flags['linear-team-id']) : undefined,
          projectId: flags['linear-project-id'] ? String(flags['linear-project-id']) : undefined,
        });
      }

      if (flags['plane-workspace'] && flags['plane-project-id']) {
        adapters.push({
          kind: 'plane',
          workspaceSlug: String(flags['plane-workspace']),
          projectId: String(flags['plane-project-id']),
        });
      }

      if (flags['planka']) {
        adapters.push({ kind: 'planka' });
      }

      await runSetup({
        fs,
        configPath,
        force,
        config: { version: 1, adapters },
        validate: async () => {
          // Run adapter validations (whoami + backlog list), read-only.
          for (const a of adapters) {
            const adapter = await adapterFromConfig(a);
            await adapter.whoami();
            await adapter.listBacklogIdsInOrder();
          }
        },
      });

      io.stdout.write(`Wrote ${configPath}\n`);
      return 0;
    }

    const config = await loadConfigFromFile({ fs, path: configPath });
    const kind = (flags.adapter ? String(flags.adapter) : config.adapters[0]?.kind) ?? '';
    const adapterCfg = flags.adapter ? config.adapters.find((a: any) => a.kind === kind) : config.adapters[0];
    if (!adapterCfg) throw new Error(`No adapter config found for kind=${kind || '(none)'} in ${configPath}`);

    const adapter = await adapterFromConfig(adapterCfg);

    if (cmd === 'show') {
      const id = String(flags.id ?? '');
      if (!id) throw new Error('show requires --id');
      io.stdout.write(`${JSON.stringify(await show(adapter, id), null, 2)}\n`);
      return 0;
    }

    if (cmd === 'next') {
      io.stdout.write(`${JSON.stringify(await next(adapter), null, 2)}\n`);
      return 0;
    }

    if (cmd === 'start') {
      const id = String(flags.id ?? '');
      if (!id) throw new Error('start requires --id');
      await start(adapter, id);
      return 0;
    }

    if (cmd === 'update') {
      const id = String(flags.id ?? '');
      const text = String(flags.text ?? '');
      if (!id) throw new Error('update requires --id');
      if (!text) throw new Error('update requires --text');
      await update(adapter, id, text);
      return 0;
    }

    if (cmd === 'ask') {
      const id = String(flags.id ?? '');
      const text = String(flags.text ?? '');
      if (!id) throw new Error('ask requires --id');
      if (!text) throw new Error('ask requires --text');
      await ask(adapter, id, text);
      return 0;
    }

    if (cmd === 'complete') {
      const id = String(flags.id ?? '');
      const summary = String(flags.summary ?? '');
      if (!id) throw new Error('complete requires --id');
      if (!summary) throw new Error('complete requires --summary');
      await complete(adapter, id, summary);
      return 0;
    }

    if (cmd === 'create') {
      const title = String(flags.title ?? '');
      const body = String(flags.body ?? '');
      if (!title) throw new Error('create requires --title');
      io.stdout.write(`${JSON.stringify(await create(adapter, { title, body }), null, 2)}\n`);
      return 0;
    }

    io.stderr.write(`Unknown command: ${cmd}\n`);
    return 2;
  } catch (err: any) {
    io.stderr.write(`${err?.message ?? String(err)}\n`);
    return 1;
  }
}

async function adapterFromConfig(cfg: any): Promise<any> {
  switch (cfg.kind) {
    case 'github':
      return new GitHubAdapter({ repo: cfg.repo, snapshotPath: 'data/github_snapshot.json', project: cfg.project });
    case 'linear':
      return new LinearAdapter({ teamId: cfg.teamId, projectId: cfg.projectId });
    case 'plane':
      return new PlaneAdapter({ workspaceSlug: cfg.workspaceSlug, projectId: cfg.projectId });
    case 'planka':
      return new PlankaAdapter();
    default:
      throw new Error(`Unknown adapter kind: ${cfg.kind}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

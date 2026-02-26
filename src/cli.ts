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

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string | boolean | string[]> } {
  const [cmd = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean | string[]> = {};

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (!tok.startsWith('--')) continue;

    const key = tok.slice(2);
    const next = rest[i + 1];

    const value: string | boolean = next && !next.startsWith('--') ? next : true;
    if (value !== true) i++;

    const prev = flags[key];
    if (prev === undefined) {
      flags[key] = value;
    } else if (typeof prev === 'string') {
      flags[key] = [prev, String(value)];
    } else if (Array.isArray(prev)) {
      prev.push(String(value));
      flags[key] = prev;
    } else {
      // prev was boolean true; promote to array of strings
      flags[key] = [String(value)];
    }
  }

  return { cmd, flags };
}

export async function runCli(rawArgv: string[], io: CliIo = { stdout: process.stdout, stderr: process.stderr }): Promise<number> {
  const { cmd, flags } = parseArgs(rawArgv);
  const configPath = 'config/clawban.json';

  try {
    if (flags.config) {
      throw new Error('Only a single config file is supported: config/clawban.json (no --config override)');
    }

    if (cmd === 'setup') {
      const force = Boolean(flags.force);

      const stageMapJson = String(flags['stage-map-json'] ?? '').trim();
      if (!stageMapJson) {
        throw new Error('setup requires --stage-map-json (platformName -> canonical stage key mapping)');
      }
      const stageMap = JSON.parse(stageMapJson);

      const selected: any[] = [];

      if (flags['github-repo']) {
        const repo = String(flags['github-repo']);
        const owner = flags['github-project-owner'] ? String(flags['github-project-owner']) : undefined;
        const number = flags['github-project-number'] ? Number(flags['github-project-number']) : undefined;
        selected.push({
          kind: 'github',
          repo,
          project: owner && number ? { owner, number } : undefined,
          stageMap,
        });
      }

      if (flags['linear-view-id'] || flags['linear-team-id'] || flags['linear-project-id']) {
        selected.push({
          kind: 'linear',
          viewId: flags['linear-view-id'] ? String(flags['linear-view-id']) : undefined,
          teamId: flags['linear-team-id'] ? String(flags['linear-team-id']) : undefined,
          projectId: flags['linear-project-id'] ? String(flags['linear-project-id']) : undefined,
          stageMap,
        });
      }

      if (flags['plane-workspace'] && flags['plane-project-id']) {
        selected.push({
          kind: 'plane',
          workspaceSlug: String(flags['plane-workspace']),
          projectId: String(flags['plane-project-id']),
          orderField: flags['plane-order-field'] ? String(flags['plane-order-field']) : undefined,
          stageMap,
        });
      }

      if (flags['planka']) {
        selected.push({ kind: 'planka', stageMap });
      }

      if (selected.length !== 1) {
        throw new Error(`setup requires selecting exactly one adapter; found ${selected.length}`);
      }

      const adapterCfg = selected[0];

      await runSetup({
        fs,
        configPath,
        force,
        config: { version: 1, adapter: adapterCfg },
        validate: async () => {
          // Validate ALL read-only verb prerequisites.
          const adapter = await adapterFromConfig(adapterCfg);
          await adapter.whoami();

          // next prerequisites
          await adapter.listBacklogIdsInOrder();
          await adapter.listIdsByStage('stage:backlog');
          await adapter.listIdsByStage('stage:blocked');
          await adapter.listIdsByStage('stage:in-progress');
          await adapter.listIdsByStage('stage:in-review');

          // show prerequisites (best-effort: validate on at least one work item if any exist)
          const candidates = [
            ...(await adapter.listIdsByStage('stage:backlog')),
            ...(await adapter.listIdsByStage('stage:blocked')),
            ...(await adapter.listIdsByStage('stage:in-progress')),
            ...(await adapter.listIdsByStage('stage:in-review')),
          ];

          const id = candidates[0];
          if (id) {
            await adapter.getWorkItem(id);
            await adapter.listComments(id, { limit: 1, newestFirst: true, includeInternal: true });
            await adapter.listAttachments(id);
            await adapter.listLinkedWorkItems(id);
          }
        },
      });

      io.stdout.write(`Wrote ${configPath}\n`);
      return 0;
    }

    const config = await loadConfigFromFile({ fs, path: configPath });
    const adapter = await adapterFromConfig(config.adapter);

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
      return new GitHubAdapter({
        repo: cfg.repo,
        snapshotPath: 'data/github_snapshot.json',
        project: cfg.project,
        stageMap: cfg.stageMap,
      });
    case 'linear':
      return new LinearAdapter({ viewId: cfg.viewId, teamId: cfg.teamId, projectId: cfg.projectId, stageMap: cfg.stageMap });
    case 'plane':
      return new PlaneAdapter({ workspaceSlug: cfg.workspaceSlug, projectId: cfg.projectId, orderField: cfg.orderField, stageMap: cfg.stageMap });
    case 'planka':
      return new PlankaAdapter({ stageMap: cfg.stageMap, bin: cfg.bin });
    default:
      throw new Error(`Unknown adapter kind: ${cfg.kind}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

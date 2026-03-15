import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { execa } from 'execa';

import { loadConfigFromFile } from './config.js';
import { runSetup } from './setup.js';
import { PlaneAdapter } from './adapters/plane.js';
import {
  loadSessionMap,
} from './automation/session_dispatcher.js';
import { archiveStaleBlockedWorkerSessions } from './workflow/ticket_runtime.js';
import { type WorkerRuntimeOptions } from './workflow/worker_runtime.js';
import { runWorkflowLoopController } from './workflow/workflow_loop_controller.js';
import { runWorkflowLoopSelection } from './workflow/workflow_loop_selection.js';
import { StageKeySchema } from './stage.js';
import { create, show } from './verbs/verbs.js';

export type CliIo = {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};

function whatNextTipForCommand(cmd: string): string {
  switch (cmd) {
    case 'setup':
      return 'run `kanban-workflow workflow-loop`';
    case 'workflow-loop':
      return 'wait for the next scheduler tick';
    case 'show':
    case 'create':
      return 'run `kanban-workflow workflow-loop`';
    default:
      return 'run `kanban-workflow workflow-loop`';
  }
}

function writeWhatNext(io: CliIo, cmd: string): void {
  io.stdout.write(`What next: ${whatNextTipForCommand(cmd)}\n`);
}

function writeSetupRequiredError(io: CliIo): void {
  io.stderr.write('Setup not completed: missing or invalid config/kanban-workflow.json\n');
  io.stderr.write('What next: run `kanban-workflow setup`\n');
}

function setupFsCompat(): { readFile(path: string, encoding: 'utf-8'): Promise<string>; writeFile(path: string, content: string, encoding: 'utf-8'): Promise<void>; mkdir(path: string, opts: { recursive: boolean }): Promise<void> } {
  return {
    readFile: (path, encoding) => fs.readFile(path, encoding),
    writeFile: (path, content, encoding) => fs.writeFile(path, content, encoding),
    mkdir: (path, opts) => fs.mkdir(path, opts).then(() => undefined),
  };
}


function writeHelp(io: CliIo): void {
  io.stdout.write(
    [
      'kanban-workflow help',
      '',
      'Core commands:',
      '  kanban-workflow setup --adapter plane ...',
      '  kanban-workflow workflow-loop [--dry-run]',
      '  kanban-workflow show --id <ticket-id>',
      '',
      'Other:',
      '  kanban-workflow create --project-id <uuid> --title "..." [--body "..."]',
      '',
    ].join('\n'),
  );
}

const PLANE_ENV_HELPER = '/root/.openclaw/workspace/scripts/plane_env.sh';
const WORKFLOW_LOOP_AGENT_ID = 'kanban-workflow-workflow-loop';
const WORKER_AGENT_ID = 'kanban-workflow-worker';
const WORKER_DELEGATION_DIR = '.tmp/kwf-worker-delegations';
const DEFAULT_WORKER_SYNC_TIMEOUT_MS = 30_000;
const DEFAULT_WORKER_BACKGROUND_TIMEOUT_MS = 15 * 60_000;

function envBool(name: string, fallback = false): boolean {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function isBackgroundWorkerDelegationAllowed(agentId: string): boolean {
  // Background delegation produces a visible “No final worker response after …” notice.
  // That behavior is acceptable for the human-facing workflow-loop, but it is too noisy for
  // per-ticket worker turns unless explicitly enabled.
  if (agentId === WORKFLOW_LOOP_AGENT_ID) return true;
  if (agentId === WORKER_AGENT_ID) return envBool('KWF_WORKER_BACKGROUND_DELEGATION', false);

  // Default: disabled. (If we ever need it for other agents, add an explicit allowlist.)
  return false;
}

const WORKER_RUNTIME_OPTIONS: WorkerRuntimeOptions = {
  delegationDir: WORKER_DELEGATION_DIR,
  defaultSyncTimeoutMs: DEFAULT_WORKER_SYNC_TIMEOUT_MS,
  defaultBackgroundTimeoutMs: DEFAULT_WORKER_BACKGROUND_TIMEOUT_MS,
  isBackgroundDelegationAllowed: isBackgroundWorkerDelegationAllowed,
  shouldStartInBackground: (agentId: string) => {
    if (agentId !== WORKER_AGENT_ID) return false;
    return envBool('KWF_WORKER_BACKGROUND_DELEGATION', false);
  },
};

async function ensurePlaneEnvFromHelper(): Promise<void> {
  if ((process.env.PLANE_API_KEY ?? '').trim()) return;

  try {
    const { stdout } = await execa('bash', [
      '-lc',
      `source ${PLANE_ENV_HELPER} >/dev/null 2>&1; printf "%s\\n%s\\n%s" "${'$'}{PLANE_API_KEY:-}" "${'$'}{PLANE_WORKSPACE:-}" "${'$'}{PLANE_BASE_URL:-}"`,
    ]);

    const [apiKey = '', workspace = '', baseUrl = ''] = stdout.split('\n');
    if (apiKey.trim()) process.env.PLANE_API_KEY = apiKey.trim();
    if (workspace.trim()) process.env.PLANE_WORKSPACE = workspace.trim();
    if (baseUrl.trim()) process.env.PLANE_BASE_URL = baseUrl.trim();
  } catch {
    // best-effort only; adapter auth will error with actionable message if still missing
  }
}

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
  const configPath = 'config/kanban-workflow.json';

  try {
    if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
      writeHelp(io);
      return 0;
    }
    if (flags.config) {
      throw new Error('Only a single config file is supported: config/kanban-workflow.json (no --config override)');
    }

    if (cmd === 'setup') {
      const force = Boolean(flags.force);

      const adapterKind = String(flags.adapter ?? '').trim();
      if (!adapterKind) throw new Error('setup requires --adapter plane');
      if (adapterKind !== 'plane') throw new Error('setup currently supports only --adapter plane');

      const mapBacklog = String(flags['map-backlog'] ?? '').trim();
      const mapBlocked = String(flags['map-blocked'] ?? '').trim();
      const mapInProgress = String(flags['map-in-progress'] ?? '').trim();
      const mapInReview = String(flags['map-in-review'] ?? '').trim();

      if (!mapBacklog || !mapBlocked || !mapInProgress || !mapInReview) {
        throw new Error('setup requires all stage mappings: --map-backlog, --map-blocked, --map-in-progress, --map-in-review');
      }

      const stageMap: Record<string, import('./stage.js').StageKey> = {
        [mapBacklog]: 'stage:todo',
        [mapBlocked]: 'stage:blocked',
        [mapInProgress]: 'stage:in-progress',
        [mapInReview]: 'stage:in-review',
      };

      // Detect accidental duplicates (which would silently drop a mapping).
      if (new Set([mapBacklog, mapBlocked, mapInProgress, mapInReview]).size !== 4) {
        throw new Error('setup stage mapping values must be unique (a platform stage/list/status can only map to one canonical stage)');
      }

      let adapterCfg: any;

      if (adapterKind === 'plane') {
        const workspaceSlug = String(flags['plane-workspace-slug'] ?? '').trim();
        const scope = String(flags['plane-scope'] ?? '').trim();
        const projectId = String(flags['plane-project-id'] ?? '').trim();
        if (!workspaceSlug) throw new Error('setup --adapter plane requires --plane-workspace-slug <slug>');

        if (scope !== 'all-projects') {
          throw new Error('setup --adapter plane requires --plane-scope all-projects');
        }

        const adapterTmp = new PlaneAdapter({
          workspaceSlug,
          projectId: projectId || undefined,
          stageMap,
          orderField: flags['plane-order-field'] ? String(flags['plane-order-field']) : undefined,
        });

        let projectIds: string[] | undefined;
        if (scope === 'all-projects') {
          const out = await (adapterTmp as any).cli.run(['projects', 'list', '-f', 'json']);
          const parsed = out.trim().length > 0 ? JSON.parse(out) : [];
          const arr: any[] = Array.isArray(parsed)
            ? parsed
            : parsed?.results && Array.isArray(parsed.results)
              ? parsed.results
              : [];
          projectIds = arr.map((p: any) => String(p?.id)).filter((x) => x && x !== 'undefined');
          if (projectIds.length === 0) {
            throw new Error('plane --plane-scope all-projects: no projects discovered');
          }

          // Validate state name consistency: all mapped keys must exist in every project.
          const requiredNames = Object.keys(stageMap);
          for (const pid of projectIds) {
            const statesOut = await (adapterTmp as any).cli.run(['states', 'list', '-p', pid, '-f', 'json']);
            const statesParsed = statesOut.trim().length > 0 ? JSON.parse(statesOut) : [];
            const statesArr: any[] = Array.isArray(statesParsed)
              ? statesParsed
              : statesParsed?.results && Array.isArray(statesParsed.results)
                ? statesParsed.results
                : [];
            const names = new Set(statesArr.map((s: any) => String(s?.name)).filter(Boolean));
            const missing = requiredNames.filter((n) => !names.has(n));
            if (missing.length > 0) {
              throw new Error(`Plane state names mismatch for project ${pid}: missing ${missing.join(', ')}`);
            }
          }
        }

        adapterCfg = {
          kind: 'plane',
          workspaceSlug,
          projectId: projectId || undefined,
          projectIds: scope === 'all-projects' ? projectIds : undefined,
          orderField: flags['plane-order-field'] ? String(flags['plane-order-field']) : undefined,
          stageMap,
        };
      } else {
        throw new Error(`Unknown adapter kind: ${adapterKind}`);
      }

      const autopilotCronExpr = String(flags['autopilot-cron-expr'] ?? '*/5 * * * *').trim();
      const autopilotTz = flags['autopilot-cron-tz'] ? String(flags['autopilot-cron-tz']).trim() : undefined;
      const autopilotInstallCron = Boolean(flags['autopilot-install-cron']);

      const autopilotRequeueTargetStage = StageKeySchema.safeParse(String(flags['autopilot-requeue-target-stage'] ?? 'stage:todo').trim());

      if (!autopilotRequeueTargetStage.success) {
        throw new Error('setup --autopilot-requeue-target-stage must be one of: stage:todo, stage:blocked, stage:in-progress, stage:in-review');
      }

      await runSetup({
        fs: setupFsCompat(),
        configPath,
        force,
        config: {
          version: 1,
          autopilot: {
            cronExpr: autopilotCronExpr,
            tz: autopilotTz || undefined,
            requeueTargetStage: autopilotRequeueTargetStage.data,
          },
          adapter: adapterCfg,
        },
        validate: async () => {
          // Validate ALL read-only verb prerequisites.
          const adapter = await adapterFromConfig(adapterCfg);
          await adapter.whoami();

          // workflow-loop selection prerequisites
          await adapter.listBacklogIdsInOrder();
          await adapter.listIdsByStage('stage:todo');
          await adapter.listIdsByStage('stage:blocked');
          await adapter.listIdsByStage('stage:in-progress');
          await adapter.listIdsByStage('stage:in-review');

          // show prerequisites (best-effort: validate on at least one work item if any exist)
          const candidates = [
            ...(await adapter.listIdsByStage('stage:todo')),
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
      io.stdout.write(
        `Workflow-loop suggestion: for token-free dispatching, schedule this system cron command every ${autopilotCronExpr}: /root/.openclaw/workspace/skills/kanban-workflow/scripts/dispatcher-cron.sh (runs kanban-workflow workflow-loop).\n`,
      );

      if (autopilotInstallCron) {
        const tz = autopilotTz ?? '';
        const message = 'Run npm run -s kanban-workflow -- workflow-loop from /root/.openclaw/workspace/skills/kanban-workflow.';

        const args = [
          'cron',
          'add',
          '--name',
          'kanban-workflow workflow-loop',
          '--agent',
          WORKFLOW_LOOP_AGENT_ID,
          '--session',
          'isolated',
          '--cron',
          autopilotCronExpr,
          '--exact',
          '--message',
          message,
          '--no-deliver',
          '--json',
        ];

        if (tz) {
          args.push('--tz', tz);
        }

        const out = await execa('openclaw', args);
        io.stdout.write(`Installed OpenClaw cron job: ${out.stdout.trim()}\n`);
      }

      writeWhatNext(io, cmd);
      return 0;
    }

    let config: any;
    try {
      config = await loadConfigFromFile({ fs: setupFsCompat(), path: configPath });
    } catch {
      writeSetupRequiredError(io);
      return 1;
    }

    if (config?.adapter?.kind === 'plane') {
      await ensurePlaneEnvFromHelper();
    }

    const adapter = await adapterFromConfig(config.adapter);
    const requeueTargetStage = (config?.autopilot?.requeueTargetStage ?? 'stage:todo') as import('./stage.js').StageKey;

    if (cmd === 'show') {
      const id = String(flags.id ?? '');
      if (!id) throw new Error('show requires --id');
      io.stdout.write(`${JSON.stringify(await show(adapter, id), null, 2)}\n`);
      writeWhatNext(io, cmd);
      return 0;
    }

    if (cmd === 'workflow-loop') {
      // Per-loop identity cache: avoid repeated `whoami` calls across selection,
      // auto-reopen, queue reconciliation, and adapter internals in the same run.
      if (typeof (adapter as any).whoami === 'function') {
        const originalWhoami = (adapter as any).whoami.bind(adapter);
        let cachedWhoami: Promise<any> | null = null;
        (adapter as any).whoami = async () => {
          if (!cachedWhoami) {
            cachedWhoami = originalWhoami();
          }
          return cachedWhoami;
        };
      }

      const dryRun = Boolean(flags['dry-run']);
      const dispatchRunId = randomUUID();
      const previousMap = await loadSessionMap();
      archiveStaleBlockedWorkerSessions(previousMap, new Date(), 7);
      const output = await runWorkflowLoopSelection({
        adapter,
        map: previousMap,
        dryRun,
        requeueTargetStage,
        workerRuntimeOptions: WORKER_RUNTIME_OPTIONS,
      });
      const result = await runWorkflowLoopController({
        adapter,
        output,
        previousMap,
        dryRun,
        dispatchRunId,
        workerAgentId: WORKER_AGENT_ID,
        workerRuntimeOptions: WORKER_RUNTIME_OPTIONS,
      });

      if (result.quiet) {
        return result.exitCode;
      }

      io.stdout.write(`${JSON.stringify(result.payload, null, 2)}\n`);
      writeWhatNext(io, cmd);
      return result.exitCode;
    }

    if (cmd === 'create') {
      const projectId = String(flags['project-id'] ?? '').trim();
      const title = String(flags.title ?? '');
      const body = String(flags.body ?? '');
      if (!projectId) throw new Error('create requires --project-id');
      if (!title) throw new Error('create requires --title');
      io.stdout.write(`${JSON.stringify(await create(adapter, { projectId, title, body }), null, 2)}\n`);
      writeWhatNext(io, cmd);
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
    case 'plane':
      return new PlaneAdapter({
        workspaceSlug: cfg.workspaceSlug,
        projectId: cfg.projectId,
        projectIds: cfg.projectIds,
        orderField: cfg.orderField,
        stageMap: cfg.stageMap,
      });
    default:
      throw new Error(`Unknown adapter kind (only plane supported): ${cfg.kind}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

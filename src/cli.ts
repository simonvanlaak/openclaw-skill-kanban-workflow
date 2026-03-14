import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { execa } from 'execa';

import { loadConfigFromFile } from './config.js';
import { runSetup } from './setup.js';
import { PlaneAdapter } from './adapters/plane.js';
import { runAutoReopenOnHumanComment } from './automation/auto_reopen.js';
import {
  applyWorkerCommandToSessionMap,
  buildWorkflowLoopPlan,
  loadSessionMap,
  saveSessionMap,
  type WorkerCommandResult,
} from './automation/session_dispatcher.js';
import { shouldQuietPollAfterCarryForward } from './workflow/decision_policy.js';
import {
  maybeSendNoWorkFirstHitAlert,
  type NoWorkAlertResult,
} from './workflow/no_work_alert.js';
import {
  maybeUpdateRocketChatStatusFromWorkflowLoop,
  type RocketChatStatusUpdate,
} from './workflow/rocketchat_status.js';
import {
  reconcileQueuePositionComments,
  type QueuePositionReconcileResult,
} from './workflow/queue_position_comments.js';
import {
  archiveStaleBlockedWorkerSessions,
  buildRetryPrompt,
} from './workflow/ticket_runtime.js';
import {
  formatForcedBlockedComment,
  formatWorkerResultComment,
  validateWorkerResult,
} from './workflow/worker_result.js';
import {
  dispatchWorkerTurn,
  loadWorkerDelegationState,
  type WorkerRuntimeOptions,
} from './workflow/worker_runtime.js';
import { StageKeySchema } from './stage.js';
import { ask, create, setStage, show, start, update } from './verbs/verbs.js';

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

function isBackgroundWorkerDelegationAllowed(agentId: string): boolean {
  // Background delegation produces a visible “No final worker response after …” notice.
  // That behavior is acceptable for the human-facing workflow-loop, but it is too noisy for
  // per-ticket worker turns (it ends up as spammy comments on the work item).
  if (agentId === WORKFLOW_LOOP_AGENT_ID) return true;
  if (agentId === WORKER_AGENT_ID) return true;

  // Default: disabled. (If we ever need it for other agents, add an explicit allowlist.)
  return false;
}

const WORKER_RUNTIME_OPTIONS: WorkerRuntimeOptions = {
  delegationDir: WORKER_DELEGATION_DIR,
  defaultSyncTimeoutMs: DEFAULT_WORKER_SYNC_TIMEOUT_MS,
  defaultBackgroundTimeoutMs: DEFAULT_WORKER_BACKGROUND_TIMEOUT_MS,
  isBackgroundDelegationAllowed: isBackgroundWorkerDelegationAllowed,
  shouldStartInBackground: (agentId: string) => agentId === WORKER_AGENT_ID,
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

function actorKeys(actor: { id?: string; username?: string; name?: string } | undefined): string[] {
  if (!actor) return [];
  return [actor.id, actor.username, actor.name]
    .filter((x): x is string => Boolean(x && String(x).trim().length > 0))
    .map((x) => String(x).trim().toLowerCase());
}

function isAssignedToSelf(assignees: readonly { id?: string; username?: string; name?: string }[] | undefined, me: { id?: string; username?: string; name?: string }): boolean {
  if (!assignees || assignees.length === 0) return false;
  const meKeys = new Set(actorKeys(me));
  if (meKeys.size === 0) return false;
  return assignees.some((a) => actorKeys(a).some((k) => meKeys.has(k)));
}

/** Tokenize a string into lowercase alphanumeric words (3+ chars). */
function tokenize(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/);
  return new Set(words.filter((w) => w.length >= 3));
}

/** Jaccard similarity between two token sets (0..1). */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const tok of a) {
    if (b.has(tok)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Find potential duplicate tickets across all open stages by comparing title similarity.
 * Returns up to `maxResults` candidates sorted by descending similarity score.
 */
async function findPotentialDuplicates(
  adapter: any,
  selectedTicketId: string,
  selectedTitle: string,
  maxResults = 10,
): Promise<Array<{ id: string; identifier?: string; title: string; url?: string; stage?: string; score: number }>> {
  const selectedTokens = tokenize(selectedTitle);
  if (selectedTokens.size === 0) return [];

  // Gather candidate IDs from all open stages (deduplicated, excluding the selected ticket).
  const stageKeys: Array<import('./stage.js').StageKey> = ['stage:todo', 'stage:blocked', 'stage:in-progress', 'stage:in-review'];
  const candidateIds = new Set<string>();
  for (const stage of stageKeys) {
    try {
      const ids: string[] = await adapter.listIdsByStage(stage);
      for (const id of ids) {
        if (id !== selectedTicketId) candidateIds.add(id);
      }
    } catch {
      // If a stage isn't configured or errors, skip it.
    }
  }

  // Also include backlog items not yet captured.
  try {
    const backlogIds: string[] = await adapter.listBacklogIdsInOrder();
    for (const id of backlogIds) {
      if (id !== selectedTicketId) candidateIds.add(id);
    }
  } catch {
    // best-effort
  }

  // Score each candidate by title similarity.
  const scored: Array<{ id: string; identifier?: string; title: string; url?: string; stage?: string; score: number }> = [];
  for (const id of candidateIds) {
    try {
      const item = await adapter.getWorkItem(id);
      const title = String(item?.title ?? '');
      const tokens = tokenize(title);
      const score = jaccardSimilarity(selectedTokens, tokens);
      if (score > 0.15) {
        scored.push({
          id,
          identifier: item?.identifier,
          title,
          url: item?.url,
          stage: item?.stage,
          score: Math.round(score * 1000) / 1000,
        });
      }
    } catch {
      // Skip items that fail to load.
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults);
}

async function runWorkflowLoopSelection(adapter: any, dryRun: boolean, requeueTargetStage: import('./stage.js').StageKey = 'stage:todo'): Promise<any> {
  const autoReopen = await runAutoReopenOnHumanComment({ adapter, dryRun, requeueTargetStage });
  const me = await adapter.whoami();
  const inProgressIds: string[] = await adapter.listIdsByStage('stage:in-progress');

  const ownInProgress: Array<{ id: string; updatedAt?: Date }> = [];
  for (const id of inProgressIds) {
    const item = await adapter.getWorkItem(id);
    if (isAssignedToSelf(item.assignees, me)) {
      ownInProgress.push({ id, updatedAt: item.updatedAt });
    }
  }

  if (ownInProgress.length > 0) {
    ownInProgress.sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
    const keep = ownInProgress[0]!;
    if (!dryRun) {
      for (const extra of ownInProgress.slice(1)) {
        await adapter.setStage(extra.id, 'stage:todo');
      }
    }
    const payload = await show(adapter, keep.id);
    const potentialDuplicates = await findPotentialDuplicates(
      adapter, keep.id, String(payload?.item?.title ?? ''),
    );
    return {
      tick: { kind: 'in_progress', id: keep.id, inProgressIds: [keep.id] },
      nextTicket: { ...payload, potentialDuplicates },
      autoReopen,
      dryRun,
    };
  }

  const backlogIds: string[] = await adapter.listBacklogIdsInOrder();
  for (const id of backlogIds) {
    const item = await adapter.getWorkItem(id);
    if (!isAssignedToSelf(item.assignees, me)) continue;
    if (!dryRun) {
      await start(adapter, id);
    }
    const payload = await show(adapter, id);
    const potentialDuplicates = await findPotentialDuplicates(
      adapter, id, String(payload?.item?.title ?? ''),
    );
    return {
      tick: { kind: 'started', id, reasonCode: 'start_next_assigned_backlog' },
      nextTicket: { ...payload, potentialDuplicates },
      autoReopen,
      dryRun,
    };
  }

  return {
    tick: { kind: 'no_work', reasonCode: 'no_backlog_assigned' },
    autoReopen,
    dryRun,
  };
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
      const output = await runWorkflowLoopSelection(adapter, dryRun, requeueTargetStage);
      const previousMap = await loadSessionMap();
      archiveStaleBlockedWorkerSessions(previousMap, new Date(), 7);
      const plan = buildWorkflowLoopPlan({ autopilotOutput: output, previousMap, now: new Date() });

      const activeCarryForward = Boolean(
        !dryRun &&
          output?.tick?.kind === 'in_progress' &&
          previousMap.active?.ticketId &&
          previousMap.active.ticketId === plan.activeTicketId,
      );

      const execution: Array<{
        sessionId: string;
        ticketId: string;
        parsed: WorkerCommandResult | null;
        workerOutput: string;
        outcome: 'applied' | 'mutation_error' | 'delegated_started' | 'delegated_running';
        detail?: string;
      }> = [];
      let noWorkAlert: NoWorkAlertResult | null = null;
      let rocketChatStatusUpdate: RocketChatStatusUpdate | null = null;
      let queuePositionUpdate: QueuePositionReconcileResult | null = null;

      const recordCompletedWorkDuration = (ticketId: string, completedAt: Date): void => {
        const entry = plan.map.sessionsByTicket?.[ticketId];
        const startedAtIso = entry?.workStartedAt;
        if (!startedAtIso) return;
        const startedMs = Date.parse(startedAtIso);
        const endedMs = completedAt.getTime();
        if (!Number.isFinite(startedMs) || endedMs <= startedMs) return;
        const durationMs = endedMs - startedMs;
        const queueState =
          plan.map.queuePosition ??
          (plan.map.queuePosition = {
            commentsByTicket: {},
            recentCompletionDurationsMs: [],
          });
        const samples = Array.isArray(queueState.recentCompletionDurationsMs)
          ? queueState.recentCompletionDurationsMs
          : [];
        queueState.recentCompletionDurationsMs = [...samples, durationMs].slice(-3);
      };

      const buildSessionRoutingWarning = (
        action: { sessionId: string; ticketId: string },
        routing?: { sessionKey?: string; sessionId?: string; agentSessionId?: string },
      ): string | null => {
        const sessionKey = String(routing?.sessionKey ?? '').trim();
        if (!sessionKey) return null;

        const expectedSuffix = `:${action.sessionId}`;
        if (sessionKey.endsWith(expectedSuffix)) return null;

        return [
          'session_routing_mismatch',
          `ticketId=${action.ticketId}`,
          `requested_session_id=${action.sessionId}`,
          `effective_session_key=${sessionKey}`,
          routing?.sessionId ? `effective_session_id=${routing.sessionId}` : undefined,
          routing?.agentSessionId ? `agent_session_id=${routing.agentSessionId}` : undefined,
        ]
          .filter(Boolean)
          .join('; ');
      };

      const applyWorkerOutput = async (
        action: { sessionId: string; ticketId: string; projectId?: string },
        workerOutput: string,
        detailPrefix?: string,
        routing?: { sessionKey?: string; sessionId?: string; agentSessionId?: string },
      ): Promise<void> => {
        let payload = workerOutput;
        let validation = validateWorkerResult(payload);
        let retryCount = 0;
        const routingWarning = buildSessionRoutingWarning(action, routing);
        if (routingWarning) {
          console.warn(`[kwf][warn] ${routingWarning}`);
        }

        while (!validation.ok && retryCount < 2) {
          retryCount += 1;
          const retry = await dispatchWorkerTurn({
            ticketId: action.ticketId,
            projectId: action.projectId,
            dispatchRunId,
            agentId: WORKER_AGENT_ID,
            sessionId: action.sessionId,
            text: buildRetryPrompt(validation.errors),
            thinking: 'low',
          }, WORKER_RUNTIME_OPTIONS);

          if (retry.kind === 'delegated') {
            execution.push({
              sessionId: action.sessionId,
              ticketId: action.ticketId,
              parsed: null,
              workerOutput: retry.notice,
              outcome: 'delegated_started',
              detail: routingWarning
                ? `source=retry-request; ticket_notified=false; ${routingWarning}`
                : 'source=retry-request; ticket_notified=false',
            });
            return;
          }

          payload = retry.workerOutput;
          validation = validateWorkerResult(payload);
        }

        let parsed: WorkerCommandResult;
        let detail: string;

        if (!validation.ok) {
          const fallbackText = formatForcedBlockedComment(validation.errors);
          parsed = { kind: 'blocked', text: fallbackText };
          detail = `decision=blocked; reason=validation_failed_after_retries; retryCount=${retryCount}; errors=${validation.errors.length}`;
        } else if (validation.value.decision === 'completed') {
          const comment = formatWorkerResultComment(validation.value);
          parsed = { kind: 'completed', result: comment };
          detail = `decision=completed; retryCount=${retryCount}`;
        } else if (validation.value.decision === 'uncertain') {
          const comment = formatWorkerResultComment(validation.value);
          parsed = { kind: 'uncertain', text: comment };
          detail = `decision=uncertain; retryCount=${retryCount}`;
        } else {
          const comment = formatWorkerResultComment(validation.value);
          parsed = { kind: 'blocked', text: comment };
          detail = `decision=blocked; retryCount=${retryCount}`;
        }

        const workerLinks = validation.ok ? validation.value.links : undefined;

        try {
          if (parsed.kind === 'completed') {
            // Append @mentions for stakeholders so they get notified of completion.
            let commentText = parsed.result;
            if (typeof (adapter as any).getStakeholderMentions === 'function') {
              const mentions: string[] = await (adapter as any).getStakeholderMentions(action.ticketId);
              if (mentions.length > 0) {
                commentText += `\n\ncc ${mentions.join(' ')} - ready for review.`;
              }
            }
            await update(adapter, action.ticketId, commentText);
            await setStage(adapter, action.ticketId, 'stage:in-review');
          } else {
            // Append @mentions for blocked/uncertain so stakeholders are aware.
            let askText = parsed.text;
            if (typeof (adapter as any).getStakeholderMentions === 'function') {
              const mentions: string[] = await (adapter as any).getStakeholderMentions(action.ticketId);
              if (mentions.length > 0) {
                const verb = parsed.kind === 'blocked' ? 'blocked, needs input' : 'needs clarification';
                askText += `\n\ncc ${mentions.join(' ')} - ${verb}.`;
              }
            }
            await ask(adapter, action.ticketId, askText);
          }

          if (Array.isArray(workerLinks) && workerLinks.length > 0 && typeof (adapter as any).addLinks === 'function') {
            await (adapter as any).addLinks(action.ticketId, workerLinks);
          }

          const appliedAt = new Date();
          if (parsed.kind === 'completed') {
            recordCompletedWorkDuration(action.ticketId, appliedAt);
          }
          applyWorkerCommandToSessionMap(plan.map, action.ticketId, parsed, appliedAt);
          execution.push({
            sessionId: action.sessionId,
            ticketId: action.ticketId,
            parsed,
            workerOutput: payload,
            outcome: 'applied',
            detail: [detailPrefix, detail, routingWarning].filter(Boolean).join('; '),
          });
        } catch (err: any) {
          execution.push({
            sessionId: action.sessionId,
            ticketId: action.ticketId,
            parsed,
            workerOutput: payload,
            outcome: 'mutation_error',
            detail: err?.message ?? String(err),
          });
          throw err;
        }
      };

      if (!dryRun) {
        for (const action of plan.actions) {
          const effectiveAgent = WORKER_AGENT_ID;
          const effectiveThinking = 'high';

          if (action.kind === 'work') {
            const delegationState = await loadWorkerDelegationState(action.sessionId, action.ticketId, WORKER_RUNTIME_OPTIONS);
            if (delegationState.kind === 'running') {
              execution.push({
                sessionId: action.sessionId,
                ticketId: action.ticketId,
                parsed: null,
                workerOutput: '',
                outcome: 'delegated_running',
                detail: `background_started_at=${delegationState.meta.startedAt}`,
              });
              continue;
            }

            if (delegationState.kind === 'completed') {
              await applyWorkerOutput(
                action,
                delegationState.workerOutput,
                'source=background-delegation',
                delegationState.routing,
              );
              continue;
            }

          }

          const dispatched = await dispatchWorkerTurn({
            ticketId: action.ticketId,
            projectId: action.projectId,
            dispatchRunId,
            agentId: effectiveAgent,
            sessionId: action.sessionId,
            text: action.text,
            thinking: effectiveThinking,
          }, WORKER_RUNTIME_OPTIONS);

          if (action.kind !== 'work') {
            continue;
          }

          if (dispatched.kind === 'delegated') {
            // IMPORTANT: Do not write delegation timeout notices back to the ticket.
            // They are human-facing runtime artifacts and become spam when posted as comments.
            // The workflow-loop will pick up the background result on a later cron turn.
            execution.push({
              sessionId: action.sessionId,
              ticketId: action.ticketId,
              parsed: null,
              workerOutput: dispatched.notice,
              outcome: 'delegated_started',
              detail: 'source=sync-timeout; ticket_notified=false',
            });
            continue;
          }

          await applyWorkerOutput(action, dispatched.workerOutput, undefined, dispatched.routing);
        }

        noWorkAlert = await maybeSendNoWorkFirstHitAlert({
          output,
          previousMap,
          map: plan.map,
          dryRun,
        });

        try {
          queuePositionUpdate = await reconcileQueuePositionComments({
            adapter,
            map: plan.map,
            dryRun,
          });
        } catch (err: any) {
          queuePositionUpdate = {
            outcome: 'error',
            queuedTickets: 0,
            activeOffset: 0,
            created: 0,
            updated: 0,
            deleted: 0,
            unchanged: 0,
            errors: [err?.message ?? String(err)],
          };
        }

        rocketChatStatusUpdate = await maybeUpdateRocketChatStatusFromWorkflowLoop({
          output,
          previousMap,
          map: plan.map,
          dryRun,
        });

        await saveSessionMap(plan.map);

        if (
          shouldQuietPollAfterCarryForward({
            activeCarryForward,
            executionOutcomes: execution.map((x) => x.outcome),
          })
        ) {
          // Quiet poll when active ticket has no new completed worker output.
          return 0;
        }
      } else {
        noWorkAlert = await maybeSendNoWorkFirstHitAlert({
          output,
          previousMap,
          map: plan.map,
          dryRun,
        });

        try {
          queuePositionUpdate = await reconcileQueuePositionComments({
            adapter,
            map: plan.map,
            dryRun,
          });
        } catch (err: any) {
          queuePositionUpdate = {
            outcome: 'error',
            queuedTickets: 0,
            activeOffset: 0,
            created: 0,
            updated: 0,
            deleted: 0,
            unchanged: 0,
            errors: [err?.message ?? String(err)],
          };
        }

        rocketChatStatusUpdate = await maybeUpdateRocketChatStatusFromWorkflowLoop({
          output,
          previousMap,
          map: plan.map,
          dryRun,
        });
      }

      io.stdout.write(
        `${JSON.stringify({
          workflowLoop: {
            dryRun,
            dispatchRunId,
            actions: plan.actions,
            execution,
            noWorkAlert,
            queuePositionUpdate,
            rocketChatStatusUpdate,
            activeTicketId: plan.activeTicketId,
            mapPath: '.tmp/kwf-session-map.json',
          },
          autopilot: output,
        }, null, 2)}\n`,
      );
      writeWhatNext(io, cmd);
      return 0;
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

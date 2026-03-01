import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { execa } from 'execa';

import { loadConfigFromFile } from './config.js';
import { runSetup } from './setup.js';
import { GitHubAdapter } from './adapters/github.js';
import { LinearAdapter } from './adapters/linear.js';
import { PlaneAdapter } from './adapters/plane.js';
import { PlankaAdapter } from './adapters/planka.js';
import { runAutopilotTick } from './automation/autopilot_tick.js';
import { runAutoReopenOnHumanComment } from './automation/auto_reopen.js';
import { lockfile } from './automation/lockfile.js';
import {
  applyWorkerCommandToSessionMap,
  buildDispatcherPlan,
  loadSessionMap,
  saveSessionMap,
  type SessionMap,
} from './automation/session_dispatcher.js';
import { extractWorkerTerminalCommand, validateWorkerResponseContract, type WorkerTerminalCommand } from './automation/worker_contract.js';
import { StageKeySchema } from './stage.js';
import { ask, complete, create, next, show, start, update } from './verbs/verbs.js';

export { extractWorkerTerminalCommand } from './automation/worker_contract.js';

export type CliIo = {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};

function whatNextTipForCommand(cmd: string): string {
  switch (cmd) {
    case 'setup':
      return 'run `kanban-workflow next`';
    case 'next':
      return 'run `kanban-workflow autopilot-tick`';
    case 'start':
      return 'prefer `kanban-workflow autopilot-tick` for orchestrated flow';
    case 'ask':
    case 'update':
    case 'complete':
    case 'continue':
    case 'blocked':
    case 'completed':
      return 'run `kanban-workflow autopilot-tick`';
    case 'autopilot-tick':
    case 'cron-dispatch':
      return 'follow the returned instruction and use only: continue, blocked, completed';
    case 'show':
    case 'create':
    case 'needs-my-attention':
      return 'run `kanban-workflow next`';
    default:
      return 'run `kanban-workflow next`';
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
      '  kanban-workflow setup --adapter <github|plane|linear|planka> ...',
      '  kanban-workflow autopilot-tick [--dry-run]',
      '  kanban-workflow cron-dispatch [--dry-run] [--agent <id>] [--thinking <level>]',
      '  kanban-workflow enforce-runtime',
      '  kanban-workflow show --id <ticket-id>',
      '  kanban-workflow needs-my-attention',
      '  kanban-workflow next',
      '',
      'Execution commands (no --id required; uses active ticket context):',
      '  kanban-workflow continue --text "update + next steps"',
      '  kanban-workflow blocked --text "block reason + questions for humans"',
      '  kanban-workflow completed --result "what was done"',
      '',
      'Other:',
      '  kanban-workflow create --title "..." [--body "..."]',
      '',
    ].join('\n'),
  );
}

type NeedsMyAttentionPort = {
  listNeedsMyAttention?: () => Promise<Array<{
    id: string;
    title: string;
    projectId: string;
    stage: 'stage:blocked' | 'stage:in-review';
    url?: string;
    updatedAt?: Date;
  }>>;
};

const AUTOPILOT_CURRENT_ID_PATH = '.tmp/kanban_autopilot_current_id';
const PLANE_ENV_HELPER = '/root/.openclaw/workspace/scripts/plane_env.sh';
const DISPATCHER_AGENT_ID = 'kanban-workflow-dispatcher';
const WORKER_AGENT_ID = 'kanban-workflow-worker';
const DEFAULT_NO_WORK_ALERT_CHANNEL = 'rocketchat';
const DEFAULT_NO_WORK_ALERT_TARGET = 'simon.vanlaak';
const WORKER_DELEGATION_DIR = '.tmp/kwf-worker-delegations';
const DEFAULT_WORKER_SYNC_TIMEOUT_MS = 30_000;
const DEFAULT_WORKER_BACKGROUND_TIMEOUT_MS = 15 * 60_000;

function isBackgroundWorkerDelegationAllowed(agentId: string): boolean {
  // Background delegation produces a visible “No final worker response after …” notice.
  // That behavior is acceptable for the human-facing dispatcher, but it is too noisy for
  // per-ticket worker turns (it ends up as spammy comments on the work item).
  if (agentId === DISPATCHER_AGENT_ID) return true;
  if (agentId === WORKER_AGENT_ID) return false;

  // Default: disabled. (If we ever need it for other agents, add an explicit allowlist.)
  return false;
}

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

async function saveCurrentAutopilotId(id: string): Promise<void> {
  await fs.mkdir('.tmp', { recursive: true });
  await fs.writeFile(AUTOPILOT_CURRENT_ID_PATH, `${id}\n`, 'utf8');
}

async function loadCurrentAutopilotId(): Promise<string | null> {
  try {
    const v = (await fs.readFile(AUTOPILOT_CURRENT_ID_PATH, 'utf8')).trim();
    return v || null;
  } catch {
    return null;
  }
}

function buildHaltOptions() {
  return {
    continue: {
      command: 'kanban-workflow continue --text "update + next steps"',
      requires: 'single text message with update + next steps',
    },
    blocked: {
      command: 'kanban-workflow blocked --text "block reason + questions for humans"',
      requires: 'single text message with blocker reason + questions',
    },
    completed: {
      command: 'kanban-workflow completed --result "what was done"',
      requires: 'result/what was done message',
    },
  };
}

async function runAutopilotCommand(adapter: any, dryRun: boolean, requeueTargetStage: import('./stage.js').StageKey = 'stage:todo'): Promise<any> {
  const autoReopen = await runAutoReopenOnHumanComment({ adapter, dryRun, requeueTargetStage });
  const res = await runAutopilotTick({ adapter, lock: lockfile, now: new Date() });
  let output: any = res;

  if (res.kind === 'started') {
    if (!dryRun) {
      await start(adapter, res.id);
      await saveCurrentAutopilotId(res.id);
    }
    const current = await show(adapter, res.id);
    output = {
      tick: res,
      nextTicket: current,
      instruction: 'Work on this ticket now.',
      haltOptions: buildHaltOptions(),
      dryRun,
    };
  } else if (res.kind === 'in_progress') {
    // Long-term anti-noise policy: do not auto-post boilerplate progress comments from tick.
    // Progress comments must come from explicit worker outcomes via:
    // - kanban-workflow continue --text "..."
    // - kanban-workflow blocked --text "..."
    // - kanban-workflow completed --result "..."
    if (!dryRun) {
      await saveCurrentAutopilotId(res.id);
    }
    const current = await show(adapter, res.id);
    output = {
      tick: res,
      nextTicket: current,
      instruction: 'Continue working on this ticket now.',
      haltOptions: buildHaltOptions(),
      dryRun,
    };
  } else if (res.kind === 'blocked') {
    if (!dryRun) {
      await ask(
        adapter,
        res.id,
        `${res.reason} Last activity is ${res.minutesStale} minutes old. Please resolve dependency, then move back to In Progress.`,
      );
    }
    const nextRes = await next(adapter);
    if (nextRes.kind === 'item') {
      if (!dryRun) await saveCurrentAutopilotId(nextRes.item.id);
      output = {
        tick: res,
        nextTicket: nextRes,
        instruction: 'Previous ticket is blocked. Work on this next ticket now.',
        haltOptions: buildHaltOptions(),
        dryRun,
      };
    } else {
      output = {
        tick: res,
        noWork: true,
        instruction: 'No work instruction: no next ticket available. Wait for the next autopilot tick.',
        dryRun,
      };
    }
  } else if (res.kind === 'completed') {
    if (res.reasonCode !== 'completion_signal_strong') {
      output = { tick: res, action: 'hold', reason: 'completion_proof_gate_failed', dryRun };
    } else {
      if (!dryRun) {
        await complete(adapter, res.id, `${res.reason} (autopilot decision gate)`);
      }
      const nextRes = await next(adapter);
      if (nextRes.kind === 'item') {
        if (!dryRun) await saveCurrentAutopilotId(nextRes.item.id);
        output = {
          tick: res,
          nextTicket: nextRes,
          instruction: 'Previous ticket completed. Work on this next ticket now.',
          haltOptions: buildHaltOptions(),
          dryRun,
        };
      } else {
        output = {
          tick: res,
          noWork: true,
          instruction: 'No work instruction: no next ticket available. Wait for the next autopilot tick.',
          dryRun,
        };
      }
    }
  }

  if (output && typeof output === 'object') {
    output.autoReopen = autoReopen;
  } else {
    output = { tick: output, autoReopen, dryRun };
  }

  return output;
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

function makeWorkerSessionKey(agentId: string, workerSessionId: string): string {
  const normalizedAgent = agentId.trim().toLowerCase();
  const normalizedSession = workerSessionId.trim().toLowerCase();
  const withoutPrefix = normalizedSession
    .replace(new RegExp(`^agent:${normalizedAgent}:`, 'i'), '')
    .replace(new RegExp(`^${normalizedAgent}[-_:]+`, 'i'), '')
    .replace(/^kanban-workflow-worker[-_:]+/i, '');
  const sessionPart = withoutPrefix || normalizedSession || 'session';
  return `agent:${normalizedAgent}:${sessionPart}`;
}

type DispatchWorkerTurnResult =
  | { kind: 'immediate'; workerOutput: string; raw: string }
  | { kind: 'delegated'; notice: string };

type WorkerDelegationMeta = {
  ticketId: string;
  sessionId: string;
  agentId: string;
  thinking: string;
  startedAt: string;
  syncTimeoutMs: number;
  backgroundTimeoutMs: number;
};

type WorkerDelegationState =
  | { kind: 'none' }
  | { kind: 'running'; meta: WorkerDelegationMeta }
  | { kind: 'completed'; meta: WorkerDelegationMeta; workerOutput: string; raw: string };

function resolvePositiveTimeoutMs(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? '');
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function workerDelegationPaths(sessionId: string): {
  dir: string;
  payloadPath: string;
  resultPath: string;
  stderrPath: string;
  exitCodePath: string;
  donePath: string;
  metaPath: string;
} {
  const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 120) || 'session';
  const dir = path.join(WORKER_DELEGATION_DIR, safeSession);
  return {
    dir,
    payloadPath: path.join(dir, 'payload.json'),
    resultPath: path.join(dir, 'result.json'),
    stderrPath: path.join(dir, 'stderr.log'),
    exitCodePath: path.join(dir, 'exit.code'),
    donePath: path.join(dir, 'done'),
    metaPath: path.join(dir, 'meta.json'),
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseWorkerOutputFromGatewayCall(stdoutRaw: unknown, stderrRaw: unknown): { workerOutput: string; raw: string } {
  const raw = String(stdoutRaw ?? '').trim();
  let workerOutput = raw;

  try {
    const parsed = JSON.parse(raw);
    const payloads: any[] = Array.isArray(parsed?.result?.payloads) ? parsed.result.payloads : [];
    const asText = payloads
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .filter((x) => x.trim().length > 0)
      .join('\n');
    if (asText.trim()) workerOutput = asText;
  } catch {
    // fallback to raw stdout
  }

  const stderr = String(stderrRaw ?? '').trim();
  const combined = [workerOutput.trim(), stderr].filter((x) => x.length > 0).join('\n');
  return { workerOutput: combined, raw };
}

function collectErrText(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err ?? '');
  const e = err as Record<string, unknown>;
  return [e.message, e.shortMessage, e.stderr, e.stdout, e.all]
    .map((v) => String(v ?? ''))
    .join('\n');
}

function hasTimedOutFallbackMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes('request timed out before a response was generated') || lower.includes('llm request timed out');
}

function isRequestTimeoutErr(err: unknown): boolean {
  const text = collectErrText(err).toLowerCase();
  return text.includes('request timed out') || text.includes('llm request timed out') || text.includes('timeout');
}

function buildDelegationNotice(params: { ticketId: string; text: string; syncTimeoutMs: number; sessionId: string }): string {
  const seconds = Math.max(1, Math.round(params.syncTimeoutMs / 1000));
  const rawText = params.text.trim();
  const compactText = rawText.length > 1800 ? `${rawText.slice(0, 1800).trimEnd()}...` : rawText;

  return [
    `No final worker response after ${seconds}s for ticket ${params.ticketId}. Re-dispatching this ticket in background with full context to continue execution.`,
    '',
    'RESUME_CONTEXT',
    `sessionId: ${params.sessionId}`,
    compactText,
  ].join('\n');
}

async function startWorkerDelegation(params: {
  ticketId: string;
  agentId: string;
  sessionId: string;
  text: string;
  thinking: string;
  syncTimeoutMs: number;
}): Promise<void> {
  const payload = {
    idempotencyKey: randomUUID(),
    message: params.text,
    agentId: params.agentId,
    sessionKey: makeWorkerSessionKey(params.agentId, params.sessionId),
    thinking: params.thinking,
  };

  const backgroundTimeoutMs = resolvePositiveTimeoutMs(
    process.env.KWF_WORKER_BACKGROUND_TIMEOUT_MS,
    DEFAULT_WORKER_BACKGROUND_TIMEOUT_MS,
  );

  const paths = workerDelegationPaths(params.sessionId);
  const meta: WorkerDelegationMeta = {
    ticketId: params.ticketId,
    sessionId: params.sessionId,
    agentId: params.agentId,
    thinking: params.thinking,
    startedAt: new Date().toISOString(),
    syncTimeoutMs: params.syncTimeoutMs,
    backgroundTimeoutMs,
  };

  await fs.mkdir(paths.dir, { recursive: true });
  await Promise.all([
    fs.writeFile(paths.payloadPath, `${JSON.stringify(payload)}\n`, 'utf8'),
    fs.writeFile(paths.metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8'),
  ]);

  const script = [
    'set +e',
    `openclaw gateway call agent --expect-final --json --timeout ${backgroundTimeoutMs} --params "$(cat ${shellQuote(paths.payloadPath)})" > ${shellQuote(paths.resultPath)} 2> ${shellQuote(paths.stderrPath)}`,
    'status=$?',
    `printf "%s\\n" "$status" > ${shellQuote(paths.exitCodePath)}`,
    `touch ${shellQuote(paths.donePath)}`,
  ].join('\n');

  const detached: any = execa('bash', ['-lc', script], { detached: true, stdio: 'ignore' } as any);
  if (typeof detached?.unref === 'function') detached.unref();
  if (typeof detached?.catch === 'function') {
    detached.catch(() => undefined);
  }
}

async function clearWorkerDelegation(sessionId: string): Promise<void> {
  const paths = workerDelegationPaths(sessionId);
  await fs.rm(paths.dir, { recursive: true, force: true });
}

async function loadWorkerDelegationState(sessionId: string, ticketId: string): Promise<WorkerDelegationState> {
  const paths = workerDelegationPaths(sessionId);
  if (!(await fileExists(paths.metaPath))) return { kind: 'none' };

  let meta: WorkerDelegationMeta;
  try {
    meta = JSON.parse(await fs.readFile(paths.metaPath, 'utf8')) as WorkerDelegationMeta;
  } catch {
    await clearWorkerDelegation(sessionId);
    return { kind: 'none' };
  }

  if (meta.ticketId !== ticketId) {
    await clearWorkerDelegation(sessionId);
    return { kind: 'none' };
  }

  if (!(await fileExists(paths.donePath))) {
    // Self-heal: if the background delegation never produced a done marker,
    // avoid getting stuck in a permanent "delegated_running" state.
    const startedAtMs = Date.parse(meta.startedAt);
    const graceMs = 60_000;
    if (!Number.isFinite(startedAtMs)) {
      await clearWorkerDelegation(sessionId);
      return { kind: 'none' };
    }

    const deadlineMs = startedAtMs + meta.backgroundTimeoutMs + graceMs;
    if (Date.now() > deadlineMs) {
      await clearWorkerDelegation(sessionId);
      return { kind: 'none' };
    }

    return { kind: 'running', meta };
  }

  const stdoutRaw = await fs.readFile(paths.resultPath, 'utf8').catch(() => '');
  const stderrRaw = await fs.readFile(paths.stderrPath, 'utf8').catch(() => '');
  const parsed = parseWorkerOutputFromGatewayCall(stdoutRaw, stderrRaw);
  await clearWorkerDelegation(sessionId);

  return {
    kind: 'completed',
    meta,
    workerOutput: parsed.workerOutput,
    raw: parsed.raw,
  };
}

async function dispatchWorkerTurn(params: {
  ticketId: string;
  agentId: string;
  sessionId: string;
  text: string;
  thinking: string;
}): Promise<DispatchWorkerTurnResult> {
  const payload = {
    idempotencyKey: randomUUID(),
    message: params.text,
    agentId: params.agentId,
    sessionKey: makeWorkerSessionKey(params.agentId, params.sessionId),
    thinking: params.thinking,
  };

  const syncTimeoutMs = resolvePositiveTimeoutMs(process.env.KWF_WORKER_SYNC_TIMEOUT_MS, DEFAULT_WORKER_SYNC_TIMEOUT_MS);
  const allowBackgroundDelegation = isBackgroundWorkerDelegationAllowed(params.agentId);

  try {
    const run = await execa('openclaw', [
      'gateway',
      'call',
      'agent',
      '--expect-final',
      '--json',
      '--timeout',
      String(syncTimeoutMs),
      '--params',
      JSON.stringify(payload),
    ]);

    const parsed = parseWorkerOutputFromGatewayCall(run.stdout, run.stderr);
    if (hasTimedOutFallbackMessage(parsed.workerOutput) || hasTimedOutFallbackMessage(parsed.raw)) {
      if (!allowBackgroundDelegation) {
        return { kind: 'immediate', workerOutput: '', raw: '' };
      }

      await startWorkerDelegation({
        ticketId: params.ticketId,
        agentId: params.agentId,
        sessionId: params.sessionId,
        text: params.text,
        thinking: params.thinking,
        syncTimeoutMs,
      });
      return {
        kind: 'delegated',
        notice: buildDelegationNotice({
          ticketId: params.ticketId,
          text: params.text,
          syncTimeoutMs,
          sessionId: params.sessionId,
        }),
      };
    }

    return { kind: 'immediate', workerOutput: parsed.workerOutput, raw: parsed.raw };
  } catch (err) {
    if (!isRequestTimeoutErr(err)) throw err;

    if (!allowBackgroundDelegation) {
      return { kind: 'immediate', workerOutput: '', raw: '' };
    }

    await startWorkerDelegation({
      ticketId: params.ticketId,
      agentId: params.agentId,
      sessionId: params.sessionId,
      text: params.text,
      thinking: params.thinking,
      syncTimeoutMs,
    });

    return {
      kind: 'delegated',
      notice: buildDelegationNotice({
        ticketId: params.ticketId,
        text: params.text,
        syncTimeoutMs,
        sessionId: params.sessionId,
      }),
    };
  }
}

type NoWorkAlertResult = {
  outcome: 'first_hit_sent' | 'first_hit_skipped' | 'repeat_suppressed' | 'send_error';
  channel?: string;
  target?: string;
  message?: string;
  reasonCode?: string;
  detail?: string;
};

function noWorkTickFromOutput(output: any): { kind?: string; reasonCode?: string } {
  const tick = output?.tick ?? output;
  if (!tick || typeof tick !== 'object') return {};
  return {
    kind: typeof tick.kind === 'string' ? tick.kind : undefined,
    reasonCode: typeof tick.reasonCode === 'string' ? tick.reasonCode : undefined,
  };
}

function buildNoWorkFirstHitAlertMessage(reasonCode?: string): string {
  const reasonSuffix = reasonCode ? ` (reason: ${reasonCode})` : '';
  return `Kanban autopilot first no-work hit: there is no actionable ticket right now${reasonSuffix}. I will stay idle until a new ticket becomes actionable.`;
}

async function maybeSendNoWorkFirstHitAlert(params: {
  output: any;
  previousMap: SessionMap;
  map: SessionMap;
  dryRun: boolean;
}): Promise<NoWorkAlertResult | null> {
  const tick = noWorkTickFromOutput(params.output);
  if (tick.kind !== 'no_work') return null;

  const hasExistingNoWorkStreak = Boolean(params.previousMap.noWork);
  const alreadyAlertedInStreak = Boolean(params.previousMap.noWork?.firstHitAlertSentAt);
  if (hasExistingNoWorkStreak && alreadyAlertedInStreak) {
    return { outcome: 'repeat_suppressed', reasonCode: tick.reasonCode };
  }

  if (params.dryRun) {
    return { outcome: 'first_hit_skipped', reasonCode: tick.reasonCode, detail: 'dry_run' };
  }

  const channel = (process.env.KWF_NO_WORK_ALERT_CHANNEL ?? DEFAULT_NO_WORK_ALERT_CHANNEL).trim() || DEFAULT_NO_WORK_ALERT_CHANNEL;
  const target = (process.env.KWF_NO_WORK_ALERT_TARGET ?? DEFAULT_NO_WORK_ALERT_TARGET).trim();
  if (!target) {
    return { outcome: 'first_hit_skipped', channel, reasonCode: tick.reasonCode, detail: 'missing_target' };
  }

  const message = buildNoWorkFirstHitAlertMessage(tick.reasonCode);

  try {
    await execa('openclaw', [
      'message',
      'send',
      '--channel',
      channel,
      '--target',
      target,
      '--message',
      message,
      '--json',
    ]);

    if (params.map.noWork) {
      params.map.noWork.firstHitAlertSentAt = new Date().toISOString();
      params.map.noWork.firstHitAlertChannel = channel;
      params.map.noWork.firstHitAlertTarget = target;
    }

    return {
      outcome: 'first_hit_sent',
      channel,
      target,
      message,
      reasonCode: tick.reasonCode,
    };
  } catch (err: any) {
    return {
      outcome: 'send_error',
      channel,
      target,
      message,
      reasonCode: tick.reasonCode,
      detail: err?.message ?? String(err),
    };
  }
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
      if (!adapterKind) throw new Error('setup requires --adapter <github|plane|linear|planka>');

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

      if (adapterKind === 'github') {
        const repo = String(flags['github-repo'] ?? '').trim();
        if (!repo) throw new Error('setup --adapter github requires --github-repo <owner/repo>');

        const number = flags['github-project-number'] ? Number(flags['github-project-number']) : undefined;
        const owner = repo.includes('/') ? repo.split('/')[0] : undefined;

        adapterCfg = {
          kind: 'github',
          repo,
          project: owner && number ? { owner, number } : undefined,
          stageMap,
        };
      } else if (adapterKind === 'linear') {
        const teamId = flags['linear-team-id'] ? String(flags['linear-team-id']) : undefined;
        const projectId = flags['linear-project-id'] ? String(flags['linear-project-id']) : undefined;

        if ((teamId ? 1 : 0) + (projectId ? 1 : 0) !== 1) {
          throw new Error('setup --adapter linear requires exactly one scope: --linear-team-id <id> OR --linear-project-id <id>');
        }

        adapterCfg = {
          kind: 'linear',
          viewId: flags['linear-view-id'] ? String(flags['linear-view-id']) : undefined,
          teamId,
          projectId,
          stageMap,
        };
      } else if (adapterKind === 'plane') {
        const workspaceSlug = String(flags['plane-workspace-slug'] ?? '').trim();
        const scope = String(flags['plane-scope'] ?? 'project').trim();
        const projectId = String(flags['plane-project-id'] ?? '').trim();
        if (!workspaceSlug) throw new Error('setup --adapter plane requires --plane-workspace-slug <slug>');

        if (scope !== 'project' && scope !== 'all-projects') {
          throw new Error('setup --adapter plane: --plane-scope must be project|all-projects');
        }

        if (scope === 'project' && !projectId) {
          throw new Error('setup --adapter plane --plane-scope project requires --plane-project-id <uuid>');
        }

        const adapterTmp = new PlaneAdapter({
          workspaceSlug,
          projectId: scope === 'project' ? projectId : undefined,
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
          projectId: scope === 'project' ? projectId : undefined,
          projectIds: scope === 'all-projects' ? projectIds : undefined,
          orderField: flags['plane-order-field'] ? String(flags['plane-order-field']) : undefined,
          stageMap,
        };
      } else if (adapterKind === 'planka') {
        const boardId = String(flags['planka-board-id'] ?? '').trim();
        const backlogListId = String(flags['planka-backlog-list-id'] ?? '').trim();
        if (!boardId) throw new Error('setup --adapter planka requires --planka-board-id <id>');
        if (!backlogListId) throw new Error('setup --adapter planka requires --planka-backlog-list-id <id>');

        adapterCfg = { kind: 'planka', boardId, backlogListId, stageMap };
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

          // next prerequisites
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
        `Autopilot suggestion: for token-free dispatching, schedule this system cron command every ${autopilotCronExpr}: /root/.openclaw/workspace/skills/kanban-workflow/scripts/dispatcher-cron.sh (runs kanban-workflow cron-dispatch).\n`,
      );
      io.stdout.write(
        `Alternative (legacy): OpenClaw-agent mode can be installed with \`npm run -s kanban-workflow -- cron-dispatch --agent ${WORKER_AGENT_ID}\` in /root/.openclaw/workspace/skills/kanban-workflow.\n`,
      );

      if (autopilotInstallCron) {
        const tz = autopilotTz ?? '';
        const message = `Run npm run -s kanban-workflow -- cron-dispatch --agent ${WORKER_AGENT_ID} from /root/.openclaw/workspace/skills/kanban-workflow.`;

        const args = [
          'cron',
          'add',
          '--name',
          'kanban-workflow dispatcher',
          '--agent',
          DISPATCHER_AGENT_ID,
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

    if (cmd === 'enforce-runtime') {
      const openclawJsonPath = '/root/.openclaw/openclaw.json';
      const baseAgentDir = '/root/.openclaw/agents';
      const specs = [
        { id: DISPATCHER_AGENT_ID, name: 'kanban-workflow dispatcher', dir: `${baseAgentDir}/${DISPATCHER_AGENT_ID}/agent` },
        { id: WORKER_AGENT_ID, name: 'kanban-workflow worker', dir: `${baseAgentDir}/${WORKER_AGENT_ID}/agent` },
      ];

      // Ensure agent dirs exist with auth profiles copied from autotriage-subagent if available.
      await fs.mkdir(baseAgentDir, { recursive: true });
      for (const s of specs) {
        await fs.mkdir(s.dir, { recursive: true });
      }

      // Best-effort update openclaw.json agent list entries.
      try {
        const raw = await fs.readFile(openclawJsonPath, 'utf8');
        const cfg = JSON.parse(raw);
        cfg.agents = cfg.agents || {};
        cfg.agents.list = Array.isArray(cfg.agents.list) ? cfg.agents.list : [];
        const ids = new Set(cfg.agents.list.map((x: any) => String(x?.id ?? '')));
        for (const s of specs) {
          if (!ids.has(s.id)) {
            cfg.agents.list.push({ id: s.id, name: s.name, workspace: '/root/.openclaw/workspace', agentDir: s.dir });
          }
        }
        await fs.writeFile(openclawJsonPath, `${JSON.stringify(cfg, null, 2)}
`, 'utf8');
      } catch {
        // no-op: keep command resilient
      }

      // Ensure cron job routes through dispatcher->worker model.
      const cronList = await execa('openclaw', ['cron', 'list', '--json']);
      const parsed = JSON.parse(cronList.stdout || '{}');
      const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
      const target = jobs.find((j: any) => j?.name === 'kanban-workflow dispatcher');
      const message = `Run npm run -s kanban-workflow -- cron-dispatch --agent ${WORKER_AGENT_ID} from /root/.openclaw/workspace/skills/kanban-workflow.`;

      if (target?.id) {
        const args = ['cron', 'edit', String(target.id), '--agent', DISPATCHER_AGENT_ID, '--message', message, '--session', 'isolated'];
        await execa('openclaw', args);
      } else {
        const args = [
          'cron', 'add',
          '--name', 'kanban-workflow dispatcher',
          '--agent', DISPATCHER_AGENT_ID,
          '--every', '5m',
          '--session', 'isolated',
          '--message', message,
          '--no-deliver',
          '--json',
        ];
        await execa('openclaw', args);
      }

      io.stdout.write('Runtime enforced: agents + dispatcher cron configured.\n');
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

    if (cmd === 'needs-my-attention') {
      const support = adapter as NeedsMyAttentionPort;
      if (typeof support.listNeedsMyAttention !== 'function') {
        throw new Error('needs-my-attention is currently supported only by the plane adapter');
      }

      io.stdout.write(`${JSON.stringify(await support.listNeedsMyAttention(), null, 2)}\n`);
      writeWhatNext(io, cmd);
      return 0;
    }

    if (cmd === 'autopilot-tick') {
      const dryRun = Boolean(flags['dry-run']);
      const output = await runAutopilotCommand(adapter, dryRun, requeueTargetStage);
      io.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      writeWhatNext(io, cmd);
      return 0;
    }

    if (cmd === 'cron-dispatch') {
      const dryRun = Boolean(flags['dry-run']);
      const output = await runAutopilotCommand(adapter, dryRun, requeueTargetStage);
      const previousMap = await loadSessionMap();
      const plan = buildDispatcherPlan({ autopilotOutput: output, previousMap, now: new Date() });

      const execution: Array<{
        sessionId: string;
        ticketId: string;
        parsed: WorkerTerminalCommand | null;
        workerOutput: string;
        outcome: 'applied' | 'parse_error' | 'mutation_error' | 'delegated_started' | 'delegated_running';
        detail?: string;
      }> = [];
      let noWorkAlert: NoWorkAlertResult | null = null;

      const applyWorkerOutput = async (action: { sessionId: string; ticketId: string }, workerOutput: string, detailPrefix?: string): Promise<void> => {
        const contract = validateWorkerResponseContract(workerOutput);
        const parsed = contract.command;

        if (!contract.ok || !parsed) {
          execution.push({
            sessionId: action.sessionId,
            ticketId: action.ticketId,
            parsed,
            workerOutput,
            outcome: 'parse_error',
            detail: contract.violations.join(' '),
          });
          return;
        }

        try {
          if (parsed.kind === 'continue') {
            await update(adapter, action.ticketId, parsed.text);
          } else if (parsed.kind === 'blocked') {
            await ask(adapter, action.ticketId, parsed.text);
          } else {
            await complete(adapter, action.ticketId, parsed.result);
          }

          applyWorkerCommandToSessionMap(plan.map, action.ticketId, parsed, new Date());
          const evidence = `evidence.present=${String(contract.evidence.present)} evidence.concrete=${String(contract.evidence.hasConcreteExecution)}`;
          execution.push({
            sessionId: action.sessionId,
            ticketId: action.ticketId,
            parsed,
            workerOutput,
            outcome: 'applied',
            detail: detailPrefix ? `${detailPrefix}; ${evidence}` : evidence,
          });
        } catch (err: any) {
          execution.push({
            sessionId: action.sessionId,
            ticketId: action.ticketId,
            parsed,
            workerOutput,
            outcome: 'mutation_error',
            detail: err?.message ?? String(err),
          });
          throw err;
        }
      };

      if (!dryRun) {
        for (const action of plan.actions) {
          const effectiveAgent = String(flags.agent ?? WORKER_AGENT_ID);
          const effectiveThinking = String(flags.thinking ?? 'high');

          if (action.kind === 'work') {
            const delegationState = await loadWorkerDelegationState(action.sessionId, action.ticketId);
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
              await applyWorkerOutput(action, delegationState.workerOutput, 'source=background-delegation');
              continue;
            }
          }

          const dispatched = await dispatchWorkerTurn({
            ticketId: action.ticketId,
            agentId: effectiveAgent,
            sessionId: action.sessionId,
            text: action.text,
            thinking: effectiveThinking,
          });

          if (action.kind !== 'work') {
            continue;
          }

          if (dispatched.kind === 'delegated') {
            // IMPORTANT: Do not write delegation timeout notices back to the ticket.
            // They are human-facing runtime artifacts and become spam when posted as comments.
            // The dispatcher will pick up the background result on a later cron turn.
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

          await applyWorkerOutput(action, dispatched.workerOutput);
        }

        noWorkAlert = await maybeSendNoWorkFirstHitAlert({
          output,
          previousMap,
          map: plan.map,
          dryRun,
        });

        await saveSessionMap(plan.map);
      } else {
        noWorkAlert = await maybeSendNoWorkFirstHitAlert({
          output,
          previousMap,
          map: plan.map,
          dryRun,
        });
      }

      io.stdout.write(
        `${JSON.stringify({
          dispatch: {
            dryRun,
            actions: plan.actions,
            execution,
            noWorkAlert,
            activeTicketId: plan.activeTicketId,
            mapPath: '.tmp/kwf-session-map.json',
          },
          autopilot: output,
        }, null, 2)}\n`,
      );
      writeWhatNext(io, cmd);
      return 0;
    }

    if (cmd === 'next') {
      io.stdout.write(`${JSON.stringify(await next(adapter), null, 2)}\n`);
      writeWhatNext(io, cmd);
      return 0;
    }


    if (cmd === 'continue') {
      const id = String(flags.id ?? '').trim() || (await loadCurrentAutopilotId()) || '';
      const text = String(flags.text ?? '').trim();
      if (!id) throw new Error('continue requires active ticket context (run autopilot-tick first)');
      if (!text) throw new Error('continue requires --text');
      await update(adapter, id, text);
      writeWhatNext(io, cmd);
      return 0;
    }

    if (cmd === 'blocked') {
      const id = String(flags.id ?? '').trim() || (await loadCurrentAutopilotId()) || '';
      const text = String(flags.text ?? '').trim();
      if (!id) throw new Error('blocked requires active ticket context (run autopilot-tick first)');
      if (!text) throw new Error('blocked requires --text');
      await ask(adapter, id, text);
      writeWhatNext(io, cmd);
      return 0;
    }

    if (cmd === 'completed') {
      const id = String(flags.id ?? '').trim() || (await loadCurrentAutopilotId()) || '';
      const result = String(flags.result ?? '').trim();
      if (!id) throw new Error('completed requires active ticket context (run autopilot-tick first)');
      if (!result) throw new Error('completed requires --result');
      await complete(adapter, id, result);
      writeWhatNext(io, cmd);
      return 0;
    }

    if (cmd === 'create') {
      const title = String(flags.title ?? '');
      const body = String(flags.body ?? '');
      if (!title) throw new Error('create requires --title');
      io.stdout.write(`${JSON.stringify(await create(adapter, { title, body }), null, 2)}\n`);
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
      return new PlaneAdapter({
        workspaceSlug: cfg.workspaceSlug,
        projectId: cfg.projectId,
        projectIds: cfg.projectIds,
        orderField: cfg.orderField,
        stageMap: cfg.stageMap,
      });
    case 'planka':
      return new PlankaAdapter({ stageMap: cfg.stageMap, boardId: cfg.boardId, backlogListId: cfg.backlogListId, bin: cfg.bin });
    default:
      throw new Error(`Unknown adapter kind: ${cfg.kind}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

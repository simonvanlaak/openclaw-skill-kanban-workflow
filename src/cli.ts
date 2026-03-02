import * as fs from 'node:fs/promises';
import * as path from 'node:path';
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
  type SessionMap,
} from './automation/session_dispatcher.js';
import { extractWorkerTerminalCommand, type WorkerTerminalCommand } from './automation/worker_contract.js';
import { StageKeySchema } from './stage.js';
import { ask, complete, create, show, start, update } from './verbs/verbs.js';

export { extractWorkerTerminalCommand } from './automation/worker_contract.js';

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
const DEFAULT_NO_WORK_ALERT_CHANNEL = 'rocketchat';
const DEFAULT_NO_WORK_ALERT_TARGET = '@simon.vanlaak';
const WORKER_DELEGATION_DIR = '.tmp/kwf-worker-delegations';
const DEFAULT_WORKER_SYNC_TIMEOUT_MS = 30_000;
const DEFAULT_WORKER_BACKGROUND_TIMEOUT_MS = 15 * 60_000;

function isBackgroundWorkerDelegationAllowed(agentId: string): boolean {
  // Background delegation produces a visible “No final worker response after …” notice.
  // That behavior is acceptable for the human-facing workflow-loop, but it is too noisy for
  // per-ticket worker turns (it ends up as spammy comments on the work item).
  if (agentId === WORKFLOW_LOOP_AGENT_ID) return true;
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
    return {
      tick: { kind: 'in_progress', id: keep.id, inProgressIds: [keep.id] },
      nextTicket: await show(adapter, keep.id),
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
    return {
      tick: { kind: 'started', id, reasonCode: 'start_next_assigned_backlog' },
      nextTicket: await show(adapter, id),
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

type WorkerReportFacts = {
  hasVerification: boolean;
  hasBlockers: boolean;
  hasUncertainties: boolean;
  hasConfidence: boolean;
  missing: string[];
};

type DecisionChoice = 'continue' | 'blocked' | 'completed';

function extractWorkerReportFacts(report: string): WorkerReportFacts {
  const text = String(report ?? '');
  const lower = text.toLowerCase();

  const hasVerification = /\bverification\b/.test(lower) || /\bverified\b/.test(lower) || /\btests?\b/.test(lower) || /\bvalidation\b/.test(lower);
  const hasBlockers = (/\bblocker(s)?\b/.test(lower) || /\bblocked\b/.test(lower) || /\bdependency\b/.test(lower)) && (/\bopen\b/.test(lower) || /\bresolved\b/.test(lower));
  const hasUncertainties = /\buncertaint(y|ies)\b/.test(lower) || /\buncertain\b/.test(lower) || /\brisk(s)?\b/.test(lower) || /\bquestion(s)?\b/.test(lower);
  const hasConfidence = /\bconfidence\b/.test(lower) && /\b(0(\.\d+)?|1(\.0+)?)\b/.test(lower);

  const missing: string[] = [];
  if (!hasVerification) missing.push('verification evidence');
  if (!hasBlockers) missing.push('blockers with open/resolved status');
  if (!hasUncertainties) missing.push('uncertainties');
  if (!hasConfidence) missing.push('confidence (0.0..1.0)');

  return { hasVerification, hasBlockers, hasUncertainties, hasConfidence, missing };
}

function parseDecisionChoice(raw: string): DecisionChoice | null {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return null;
  if (/\bcompleted\b/.test(text)) return 'completed';
  if (/\bblocked\b/.test(text)) return 'blocked';
  if (/\bcontinue\b/.test(text)) return 'continue';
  return null;
}

function continueCountForTicket(map: SessionMap, ticketId: string): number {
  const entry = (map.sessionsByTicket ?? {})[ticketId] as any;
  const n = Number(entry?.continueCount ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function buildRetryPrompt(missing: string[]): string {
  return [
    'Your previous report is missing required elements.',
    `Missing items: ${missing.join(', ')}`,
    'Reply with markdown report only and include the missing items.',
  ].join('\n');
}

function summarizeReportForComment(report: string, maxChars = 1200): string {
  const compact = String(report ?? '').trim().replace(/\s+/g, ' ');
  if (!compact) return 'No report details provided.';
  return compact.length > maxChars ? `${compact.slice(0, maxChars).trimEnd()}...` : compact;
}

async function decideWithAgent(params: {
  map: SessionMap;
  ticketId: string;
  report: string;
  facts: WorkerReportFacts;
}): Promise<DecisionChoice | null> {
  const mapAny = params.map as any;
  const decisionAgentId = (process.env.KWF_DECISION_AGENT_ID ?? 'kanban-workflow-decision').trim() || 'kanban-workflow-decision';
  const maxTicketsPerSession = 5;
  const maxChars = 20_000;
  const rotateAt = 0.5;

  const state = (mapAny.decisionSession ??= {
    sessionId: randomUUID(),
    ticketsUsedCount: 0,
    contextChars: 0,
  });

  const usageRatio = (state.contextChars ?? 0) / maxChars;
  if ((state.ticketsUsedCount ?? 0) >= maxTicketsPerSession || usageRatio >= rotateAt) {
    state.sessionId = randomUUID();
    state.ticketsUsedCount = 0;
    state.contextChars = 0;
  }

  const prompt = [
    'Decide exactly one workflow outcome for this ticket.',
    'Allowed labels: continue, blocked, completed.',
    'Respond with one word only.',
    `Ticket: ${params.ticketId}`,
    `Missing required report fields: ${params.facts.missing.length > 0 ? params.facts.missing.join(', ') : 'none'}`,
    '',
    'WORKER_REPORT',
    params.report,
  ].join('\n');

  const payload = {
    idempotencyKey: randomUUID(),
    message: prompt,
    agentId: decisionAgentId,
    sessionKey: makeWorkerSessionKey(decisionAgentId, state.sessionId),
    thinking: 'low',
  };

  try {
    const run = await execa('openclaw', [
      'gateway',
      'call',
      'agent',
      '--expect-final',
      '--json',
      '--timeout',
      '30000',
      '--params',
      JSON.stringify(payload),
    ]);

    const parsed = parseWorkerOutputFromGatewayCall(run.stdout, run.stderr);
    state.ticketsUsedCount = Number(state.ticketsUsedCount ?? 0) + 1;
    state.contextChars = Number(state.contextChars ?? 0) + prompt.length + parsed.workerOutput.length;

    return parseDecisionChoice(parsed.workerOutput);
  } catch {
    return null;
  }
}

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
  return `Kanban workflow-loop first no-work hit: there is no actionable ticket right now${reasonSuffix}. I will stay idle until a new ticket becomes actionable.`;
}

function archiveStaleBlockedWorkerSessions(map: SessionMap, now: Date, inactivityDays = 7): void {
  const cutoffMs = now.getTime() - inactivityDays * 24 * 60 * 60 * 1000;
  for (const [ticketId, entry] of Object.entries(map.sessionsByTicket ?? {})) {
    if (entry?.lastState !== 'blocked') continue;
    const lastSeenMs = Date.parse(String(entry.lastSeenAt ?? ''));
    if (!Number.isFinite(lastSeenMs)) continue;
    if (lastSeenMs > cutoffMs) continue;
    delete map.sessionsByTicket[ticketId];
    if (map.active?.ticketId === ticketId) {
      map.active = undefined;
    }
  }
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
      const dryRun = Boolean(flags['dry-run']);
      const output = await runWorkflowLoopSelection(adapter, dryRun, requeueTargetStage);
      const previousMap = await loadSessionMap();
      archiveStaleBlockedWorkerSessions(previousMap, new Date(), 7);
      const plan = buildWorkflowLoopPlan({ autopilotOutput: output, previousMap, now: new Date() });

      const activeCarryForward =
        !dryRun &&
        output?.tick?.kind === 'in_progress' &&
        previousMap.active?.ticketId &&
        previousMap.active.ticketId === plan.activeTicketId;

      if (activeCarryForward) {
        await saveSessionMap(plan.map);
        // Poll-only mode while a worker ticket is already active.
        return 0;
      }

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
        let report = workerOutput;
        let facts = extractWorkerReportFacts(report);

        if (facts.missing.length > 0) {
          const retry = await dispatchWorkerTurn({
            ticketId: action.ticketId,
            agentId: WORKER_AGENT_ID,
            sessionId: action.sessionId,
            text: buildRetryPrompt(facts.missing),
            thinking: 'low',
          });

          if (retry.kind === 'delegated') {
            execution.push({
              sessionId: action.sessionId,
              ticketId: action.ticketId,
              parsed: null,
              workerOutput: retry.notice,
              outcome: 'delegated_started',
              detail: 'source=retry-request; ticket_notified=false',
            });
            return;
          }

          report = retry.workerOutput;
          facts = extractWorkerReportFacts(report);
        }

        let decision = await decideWithAgent({ map: plan.map, ticketId: action.ticketId, report, facts });
        if (!decision) decision = 'blocked';
        if (decision === 'continue' && continueCountForTicket(plan.map, action.ticketId) >= 2) {
          decision = 'blocked';
        }

        const parsed: WorkerTerminalCommand =
          decision === 'continue'
            ? { kind: 'continue', text: summarizeReportForComment(report) }
            : decision === 'blocked'
              ? { kind: 'blocked', text: summarizeReportForComment(report) }
              : { kind: 'completed', result: summarizeReportForComment(report) };

        try {
          if (parsed.kind === 'continue') {
            await update(adapter, action.ticketId, parsed.text);
          } else if (parsed.kind === 'blocked') {
            await ask(adapter, action.ticketId, parsed.text);
          } else {
            await complete(adapter, action.ticketId, parsed.result);
          }

          applyWorkerCommandToSessionMap(plan.map, action.ticketId, parsed, new Date());
          const evidence = `report.missing=${facts.missing.length}`;
          execution.push({
            sessionId: action.sessionId,
            ticketId: action.ticketId,
            parsed,
            workerOutput: report,
            outcome: 'applied',
            detail: detailPrefix ? `${detailPrefix}; ${evidence}` : evidence,
          });
        } catch (err: any) {
          execution.push({
            sessionId: action.sessionId,
            ticketId: action.ticketId,
            parsed,
            workerOutput: report,
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
          workflowLoop: {
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

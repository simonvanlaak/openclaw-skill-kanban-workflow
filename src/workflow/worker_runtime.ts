import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { execa } from 'execa';

type WorkerRouting = { sessionKey?: string; sessionId?: string; agentSessionId?: string };

const WORKER_HISTORY_LIMIT = 100;
const DEFAULT_WORKER_SEND_MAX_ATTEMPTS = 4;
const DEFAULT_WORKER_SEND_RETRY_DELAY_MS = 5_000;

export type DispatchWorkerTurnResult =
  | {
      kind: 'immediate';
      workerOutput: string;
      raw: string;
      routing?: WorkerRouting;
    }
  | {
      kind: 'delegated';
      notice: string;
      runId: string;
      startedAt: string;
      waitTimeoutSeconds: number;
      sessionKey: string;
    };

export type WorkerDelegationMeta = {
  ticketId: string;
  dispatchRunId: string;
  sessionId: string;
  agentId: string;
  thinking: string;
  startedAt: string;
  runId: string;
  sessionKey: string;
  runTimeoutSeconds: number;
};

export type WorkerDelegationState =
  | { kind: 'none' }
  | { kind: 'running'; meta: WorkerDelegationMeta }
  | {
      kind: 'completed';
      meta: WorkerDelegationMeta;
      workerOutput: string;
      raw: string;
      routing?: WorkerRouting;
    };

export type WorkerRuntimeOptions = {
  delegationDir: string;
  defaultSyncTimeoutMs: number;
  defaultBackgroundTimeoutMs: number;
  isBackgroundDelegationAllowed(agentId: string): boolean;
  shouldStartInBackground?(agentId: string): boolean;
};

type AgentWaitSnapshot = {
  runId: string;
  status: 'ok' | 'error' | 'timeout';
  startedAt?: number;
  endedAt?: number;
  error?: string;
};

function resolvePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? '');
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function timeoutMsToSeconds(timeoutMs: number): number {
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function workerSessionKey(agentId: string, sessionId: string): string {
  return `agent:${agentId}:${sessionId}`;
}

export function buildDelegationCompletionHook(params: {
  ticketId: string;
  sessionId: string;
  stderrPath: string;
}): string {
  return [
    '(',
    '  cd /root/.openclaw/workspace/skills/kanban-workflow || exit 0',
    `  npm run -s kanban-workflow -- reconcile-delegation --ticket-id ${shellQuote(params.ticketId)} --session-id ${shellQuote(params.sessionId)} >/dev/null 2>> ${shellQuote(params.stderrPath)} || true`,
    ') >/dev/null 2>&1 &',
  ].join('\n');
}

function withDispatchMetadataEnvelope(params: {
  ticketId: string;
  projectId?: string;
  dispatchRunId: string;
  text: string;
}): string {
  return [
    'DISPATCH_METADATA',
    `ticketId: ${params.ticketId}`,
    ...(params.projectId ? [`projectId: ${params.projectId}`] : []),
    `dispatchRunId: ${params.dispatchRunId}`,
    '',
    params.text,
  ].join('\n');
}

function workerDelegationPaths(delegationDir: string, sessionId: string): {
  dir: string;
  resultPath: string;
  waitResultPath: string;
  stderrPath: string;
  donePath: string;
  metaPath: string;
} {
  const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 120) || 'session';
  const dir = path.join(delegationDir, safeSession);
  return {
    dir,
    resultPath: path.join(dir, 'result.json'),
    waitResultPath: path.join(dir, 'wait-result.json'),
    stderrPath: path.join(dir, 'stderr.log'),
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveWorkerSendMaxAttempts(): number {
  return resolvePositiveInt(process.env.KWF_WORKER_SEND_MAX_ATTEMPTS, DEFAULT_WORKER_SEND_MAX_ATTEMPTS);
}

function resolveWorkerSendRetryDelayMs(): number {
  return resolvePositiveInt(process.env.KWF_WORKER_SEND_RETRY_DELAY_MS, DEFAULT_WORKER_SEND_RETRY_DELAY_MS);
}

function isTransientGatewayDispatchErr(err: unknown): boolean {
  const text = collectErrText(err).toLowerCase();
  return [
    'gateway closed',
    'gateway connect failed',
    'closed before connect',
    'handshake timeout',
    'handshake-timeout',
    'econnrefused',
    'socket hang up',
    'normal closure',
  ].some((needle) => text.includes(needle));
}

function extractTextContent(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .map((entry) => (entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null))
    .filter((entry): entry is Record<string, unknown> => !!entry)
    .filter((entry) => String(entry.type ?? '').toLowerCase() === 'text')
    .map((entry) => String(entry.text ?? '').trim())
    .filter((text) => text.length > 0);
}

function parseAgentIdFromSessionKey(sessionKey: string): string | null {
  const match = /^agent:([^:]+):/.exec(sessionKey.trim());
  return match?.[1] ?? null;
}

function resolveOpenClawRoot(): string {
  const configured = (process.env.OPENCLAW_HOME ?? '').trim();
  if (configured) return configured;
  return path.join(process.env.HOME || '/root', '.openclaw');
}

async function readLocalSessionHistory(sessionKey: string): Promise<unknown | null> {
  const agentId = parseAgentIdFromSessionKey(sessionKey);
  if (!agentId) return null;

  const sessionsDir = path.join(resolveOpenClawRoot(), 'agents', agentId, 'sessions');
  const sessionsIndexPath = path.join(sessionsDir, 'sessions.json');

  let sessionFile: string | null = null;
  try {
    const raw = await fs.readFile(sessionsIndexPath, 'utf8');
    const index = JSON.parse(raw) as Record<string, { sessionId?: string; sessionFile?: string }>;
    const entry = index[sessionKey];
    if (!entry || typeof entry !== 'object') return null;
    if (typeof entry.sessionFile === 'string' && entry.sessionFile.trim().length > 0) {
      sessionFile = entry.sessionFile;
    } else if (typeof entry.sessionId === 'string' && entry.sessionId.trim().length > 0) {
      sessionFile = path.join(sessionsDir, `${entry.sessionId}.jsonl`);
    }
  } catch {
    return null;
  }

  if (!sessionFile) return null;

  let rawLines = '';
  try {
    rawLines = await fs.readFile(sessionFile, 'utf8');
  } catch {
    return null;
  }

  const messages: Array<Record<string, unknown>> = [];
  for (const line of rawLines.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (String(row.type ?? '').toLowerCase() !== 'message') continue;
    const message = row.message;
    if (!message || typeof message !== 'object') continue;
    const timestamp = Date.parse(String(row.timestamp ?? ''));
    messages.push({
      ...(message as Record<string, unknown>),
      timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
    });
  }

  if (!messages.length) return null;

  return {
    sessionKey,
    sessionId: path.basename(sessionFile, '.jsonl'),
    messages,
  };
}

export async function extractCompletedAssistantReplyFromLocalSessionSince(
  sessionKey: string,
  sinceTimestamp: number,
): Promise<{ text: string; timestamp: number; sessionId?: string } | null> {
  const history = await readLocalSessionHistory(sessionKey);
  return extractCompletedAssistantReplySince(history, sinceTimestamp);
}

export function extractCompletedAssistantReplySince(history: unknown, sinceTimestamp: number): { text: string; timestamp: number; sessionId?: string } | null {
  if (!history || typeof history !== 'object') return null;
  const payload = history as Record<string, unknown>;
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
  const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];

  const messages = rawMessages
    .map((message) => (message && typeof message === 'object' ? (message as Record<string, unknown>) : null))
    .filter((message): message is Record<string, unknown> => !!message)
    .map((row) => ({ row, timestamp: Number(row.timestamp) }))
    .filter((entry) => Number.isFinite(entry.timestamp) && entry.timestamp > sinceTimestamp)
    .sort((a, b) => a.timestamp - b.timestamp);

  const last = messages.at(-1)?.row;
  if (!last) return null;
  if (String(last.role ?? '').toLowerCase() !== 'assistant') return null;
  if (String(last.stopReason ?? '').toLowerCase() === 'tooluse') return null;

  const text = extractTextContent(last.content).join('\n').trim();
  if (!text) return null;

  return {
    text,
    timestamp: Number(last.timestamp),
    sessionId,
  };
}

async function gatewayCall(method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> {
  const args = [
    'gateway',
    'call',
    method,
    '--params',
    JSON.stringify(params),
    '--timeout',
    String(timeoutMs),
    '--json',
  ];
  const run = await execa('openclaw', args);
  const raw = String(run.stdout ?? '').trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

async function gatewayCallWithRetry(params: {
  method: string;
  rpcParams: Record<string, unknown>;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  shouldRetry?: (err: unknown) => boolean;
}): Promise<unknown> {
  const maxAttempts = Math.max(1, params.maxAttempts ?? 1);
  const retryDelayMs = Math.max(0, params.retryDelayMs ?? 0);
  const shouldRetry = params.shouldRetry ?? (() => false);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await gatewayCall(params.method, params.rpcParams, params.timeoutMs);
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !shouldRetry(err)) {
        throw err;
      }
      await sleep(retryDelayMs * attempt);
    }
  }

  throw lastErr ?? new Error(`gatewayCallWithRetry exhausted without error for ${params.method}`);
}

export async function extractCompletedAssistantReplyWithLocalFallback(params: {
  history: unknown;
  sessionKey: string;
  sinceTimestamp: number;
}): Promise<{ text: string; timestamp: number; sessionId?: string } | null> {
  const latest = extractCompletedAssistantReplySince(params.history, params.sinceTimestamp);
  if (latest) return latest;
  return extractCompletedAssistantReplyFromLocalSessionSince(params.sessionKey, params.sinceTimestamp);
}

function buildDelegationNotice(params: {
  ticketId: string;
  sessionId: string;
  runId: string;
  runTimeoutSeconds: number;
}): string {
  return [
    `Worker started for ticket ${params.ticketId}. Awaiting asynchronous completion.`,
    `sessionId: ${params.sessionId}`,
    `runId: ${params.runId}`,
    `runTimeoutSeconds: ${params.runTimeoutSeconds}`,
  ].join('\n');
}

function parseChatSendStart(payload: unknown): { runId: string } {
  if (!payload || typeof payload !== 'object') {
    throw new Error('chat.send did not return a JSON object');
  }
  const row = payload as Record<string, unknown>;
  const runId = String(row.runId ?? '').trim();
  const status = String(row.status ?? '').trim().toLowerCase();
  if (!runId) {
    throw new Error('chat.send response did not include runId');
  }
  if (status && status !== 'started') {
    throw new Error(`chat.send returned unexpected status=${status}`);
  }
  return { runId };
}

function parseAgentWaitSnapshot(payload: unknown): AgentWaitSnapshot {
  if (!payload || typeof payload !== 'object') {
    throw new Error('agent.wait did not return a JSON object');
  }
  const row = payload as Record<string, unknown>;
  const runId = String(row.runId ?? '').trim();
  const status = String(row.status ?? '').trim().toLowerCase();
  if (!runId || (status !== 'ok' && status !== 'error' && status !== 'timeout')) {
    throw new Error('agent.wait returned an invalid lifecycle snapshot');
  }
  return {
    runId,
    status,
    startedAt: Number.isFinite(Number(row.startedAt)) ? Number(row.startedAt) : undefined,
    endedAt: Number.isFinite(Number(row.endedAt)) ? Number(row.endedAt) : undefined,
    error: typeof row.error === 'string' ? row.error : undefined,
  };
}

async function startWorkerDelegation(
  params: {
    ticketId: string;
    dispatchRunId: string;
    agentId: string;
    sessionId: string;
    thinking: string;
    runId: string;
    sessionKey: string;
    runTimeoutSeconds: number;
  },
  opts: WorkerRuntimeOptions,
): Promise<void> {
  const paths = workerDelegationPaths(opts.delegationDir, params.sessionId);
  const meta: WorkerDelegationMeta = {
    ticketId: params.ticketId,
    dispatchRunId: params.dispatchRunId,
    sessionId: params.sessionId,
    agentId: params.agentId,
    thinking: params.thinking,
    startedAt: new Date().toISOString(),
    runId: params.runId,
    sessionKey: params.sessionKey,
    runTimeoutSeconds: params.runTimeoutSeconds,
  };

  await fs.mkdir(paths.dir, { recursive: true });
  await fs.writeFile(paths.metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  const waitTimeoutMs = params.runTimeoutSeconds * 1000;
  const gatewayTimeoutMs = waitTimeoutMs + 30_000;
  const script = [
    'set +e',
    `run_id=${shellQuote(params.runId)}`,
    `wait_timeout_ms=${waitTimeoutMs}`,
    `wait_result_path=${shellQuote(paths.waitResultPath)}`,
    `stderr_path=${shellQuote(paths.stderrPath)}`,
    `done_path=${shellQuote(paths.donePath)}`,
    `wait_params=$(jq -cn --arg runId "$run_id" --argjson timeoutMs "$wait_timeout_ms" '{runId:$runId,timeoutMs:$timeoutMs}')`,
    `openclaw gateway call agent.wait --timeout ${gatewayTimeoutMs} --json --params "$wait_params" > "$wait_result_path" 2>> "$stderr_path"`,
    'wait_rc=$?',
    'if [ "$wait_rc" -ne 0 ]; then',
    '  printf "{\\"runId\\":%s,\\"status\\":\\"error\\",\\"error\\":\\"agent.wait failed\\"}\\n" "$(printf \'%s\' "$run_id" | jq -Rsa .)" > "$wait_result_path"',
    'fi',
    'touch "$done_path"',
    buildDelegationCompletionHook({ ticketId: params.ticketId, sessionId: params.sessionId, stderrPath: paths.stderrPath }),
  ].join('\n');

  const detached: any = execa('bash', ['-lc', script], { detached: true, stdio: 'ignore' } as any);
  if (typeof detached?.unref === 'function') detached.unref();
  if (typeof detached?.catch === 'function') detached.catch(() => undefined);
}

async function clearWorkerDelegation(delegationDir: string, sessionId: string): Promise<void> {
  const paths = workerDelegationPaths(delegationDir, sessionId);
  await fs.rm(paths.dir, { recursive: true, force: true });
}

export async function loadWorkerDelegationState(
  sessionId: string,
  ticketId: string,
  opts: WorkerRuntimeOptions,
): Promise<WorkerDelegationState> {
  const paths = workerDelegationPaths(opts.delegationDir, sessionId);
  if (!(await fileExists(paths.metaPath))) return { kind: 'none' };

  let meta: WorkerDelegationMeta;
  try {
    meta = JSON.parse(await fs.readFile(paths.metaPath, 'utf8')) as WorkerDelegationMeta;
  } catch {
    await clearWorkerDelegation(opts.delegationDir, sessionId);
    return { kind: 'none' };
  }

  if (meta.ticketId !== ticketId) {
    await clearWorkerDelegation(opts.delegationDir, sessionId);
    return { kind: 'none' };
  }

  if (!(await fileExists(paths.donePath))) {
    const startedAtMs = Date.parse(meta.startedAt);
    const graceMs = 60_000;
    if (!Number.isFinite(startedAtMs)) {
      await clearWorkerDelegation(opts.delegationDir, sessionId);
      return { kind: 'none' };
    }

    const deadlineMs = startedAtMs + (meta.runTimeoutSeconds * 1000) + graceMs;
    if (Date.now() > deadlineMs) {
      await clearWorkerDelegation(opts.delegationDir, sessionId);
      return { kind: 'none' };
    }

    return { kind: 'running', meta };
  }

  const waitRaw = await fs.readFile(paths.waitResultPath, 'utf8').catch(() => '');
  let waitSnapshot: AgentWaitSnapshot;
  try {
    waitSnapshot = parseAgentWaitSnapshot(JSON.parse(waitRaw));
  } catch {
    await clearWorkerDelegation(opts.delegationDir, sessionId);
    return { kind: 'none' };
  }
  if (waitSnapshot.runId !== meta.runId || waitSnapshot.status !== 'ok') {
    await clearWorkerDelegation(opts.delegationDir, sessionId);
    return { kind: 'none' };
  }

  const startedAtMs = Date.parse(meta.startedAt);
  const reply = await extractCompletedAssistantReplyFromLocalSessionSince(meta.sessionKey, startedAtMs - 1);
  if (!reply?.text?.trim()) {
    const stderrRaw = await fs.readFile(paths.stderrPath, 'utf8').catch(() => '');
    throw new Error(
      `Background worker turn completed for ticket ${ticketId}, but no terminal assistant reply was found in session history.${stderrRaw ? ` stderr=${stderrRaw.trim()}` : ''}`,
    );
  }

  await Promise.all([
    fs.writeFile(paths.resultPath, reply.text, 'utf8'),
    clearWorkerDelegation(opts.delegationDir, sessionId),
  ]);

  return {
    kind: 'completed',
    meta,
    workerOutput: reply.text,
    raw: reply.text,
    routing: {
      sessionKey: meta.sessionKey,
      sessionId: reply.sessionId ?? meta.sessionId,
    },
  };
}

export async function dispatchWorkerTurn(
  params: {
    ticketId: string;
    projectId?: string;
    dispatchRunId: string;
    agentId: string;
    sessionId: string;
    text: string;
    thinking: string;
  },
  opts: WorkerRuntimeOptions,
): Promise<DispatchWorkerTurnResult> {
  const message = withDispatchMetadataEnvelope({
    ticketId: params.ticketId,
    projectId: params.projectId,
    dispatchRunId: params.dispatchRunId,
    text: params.text,
  });

  const runTimeoutSeconds = timeoutMsToSeconds(
    resolvePositiveInt(process.env.KWF_WORKER_RUN_TIMEOUT_MS, opts.defaultBackgroundTimeoutMs),
  );
  const sessionKey = workerSessionKey(params.agentId, params.sessionId);
  const sendResponse = await gatewayCallWithRetry({
    method: 'chat.send',
    rpcParams: {
      sessionKey,
      message,
      idempotencyKey: randomUUID(),
    },
    timeoutMs: Math.max(opts.defaultSyncTimeoutMs, 15_000),
    maxAttempts: resolveWorkerSendMaxAttempts(),
    retryDelayMs: resolveWorkerSendRetryDelayMs(),
    shouldRetry: isTransientGatewayDispatchErr,
  });
  const started = parseChatSendStart(sendResponse);

  await startWorkerDelegation(
    {
      ticketId: params.ticketId,
      dispatchRunId: params.dispatchRunId,
      agentId: params.agentId,
      sessionId: params.sessionId,
      thinking: params.thinking,
      runId: started.runId,
      sessionKey,
      runTimeoutSeconds,
    },
    opts,
  );

  return {
    kind: 'delegated',
    notice: buildDelegationNotice({
      ticketId: params.ticketId,
      sessionId: params.sessionId,
      runId: started.runId,
      runTimeoutSeconds,
    }),
    runId: started.runId,
    startedAt: new Date().toISOString(),
    waitTimeoutSeconds: runTimeoutSeconds,
    sessionKey,
  };
}

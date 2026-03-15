import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { execa } from 'execa';

import { parseWorkerOutputFromAgentCall } from './agent_io.js';

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
  | { kind: 'delegated'; notice: string };

export type WorkerDelegationMeta = {
  ticketId: string;
  dispatchRunId: string;
  sessionId: string;
  agentId: string;
  thinking: string;
  startedAt: string;
  syncTimeoutMs: number;
  backgroundTimeoutMs: number;
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
  messagePath: string;
  resultPath: string;
  stderrPath: string;
  exitCodePath: string;
  donePath: string;
  metaPath: string;
} {
  const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 120) || 'session';
  const dir = path.join(delegationDir, safeSession);
  return {
    dir,
    messagePath: path.join(dir, 'message.txt'),
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

async function pollWorkerReply(params: {
  sessionKey: string;
  sinceTimestamp: number;
  timeoutMs: number;
}): Promise<{ workerOutput: string; raw: string; routing: WorkerRouting } | null> {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    let history: unknown = null;
    let historyErr: unknown = null;
    try {
      history = await gatewayCall('chat.history', {
        sessionKey: params.sessionKey,
        limit: WORKER_HISTORY_LIMIT,
      });
    } catch (err) {
      historyErr = err;
    }

    const latest = await extractCompletedAssistantReplyWithLocalFallback({
      history,
      sessionKey: params.sessionKey,
      sinceTimestamp: params.sinceTimestamp,
    });
    if (latest) {
      return {
        workerOutput: latest.text,
        raw: latest.text,
        routing: {
          sessionKey: params.sessionKey,
          sessionId: latest.sessionId,
        },
      };
    }

    await sleep(1200);
  }
  return null;
}

function buildDelegationNotice(params: {
  ticketId: string;
  text: string;
  syncTimeoutMs: number;
  sessionId: string;
}): string {
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

async function startWorkerDelegation(
  params: {
    ticketId: string;
    projectId?: string;
    dispatchRunId: string;
    agentId: string;
    sessionId: string;
    text: string;
    thinking: string;
    syncTimeoutMs: number;
  },
  opts: WorkerRuntimeOptions,
): Promise<void> {
  const message = withDispatchMetadataEnvelope({
    ticketId: params.ticketId,
    projectId: params.projectId,
    dispatchRunId: params.dispatchRunId,
    text: params.text,
  });

  const backgroundTimeoutMs = resolvePositiveInt(
    process.env.KWF_WORKER_BACKGROUND_TIMEOUT_MS,
    opts.defaultBackgroundTimeoutMs,
  );

  const paths = workerDelegationPaths(opts.delegationDir, params.sessionId);
  const meta: WorkerDelegationMeta = {
    ticketId: params.ticketId,
    dispatchRunId: params.dispatchRunId,
    sessionId: params.sessionId,
    agentId: params.agentId,
    thinking: params.thinking,
    startedAt: new Date().toISOString(),
    syncTimeoutMs: params.syncTimeoutMs,
    backgroundTimeoutMs,
  };

  await fs.mkdir(paths.dir, { recursive: true });
  await Promise.all([
    fs.writeFile(paths.messagePath, message, 'utf8'),
    fs.writeFile(paths.metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8'),
  ]);

  // IMPORTANT: Do not use `openclaw agent --session-id ...` here.
  // That CLI path routes agent sessions under `agent:<agentId>:main` and only mutates the
  // internal sessionId field, which collapses all tickets into the same "main" session.
  //
  // Instead, background delegation must target an explicit sessionKey, same as the
  // synchronous gatewayCall path.
  const sessionKey = workerSessionKey(params.agentId, params.sessionId);

  const script = [
    'set +e',
    `session_key=${shellQuote(sessionKey)}`,
    // Gateway RPC requires auth token; do not print it into logs.
    'gateway_token=$(jq -r \'.gateway.auth.token\' /root/.openclaw/openclaw.json)',
    // millisecond epoch, consistent with chat.history timestamps
    'since_ts=$(date +%s%3N)',
    // stable idempotency key for this background dispatch
    'idem=$(python3 - <<"PY"\nimport uuid\nprint(uuid.uuid4())\nPY\n)',
    `msg=$(cat ${shellQuote(paths.messagePath)})`,
    `send_params=$(jq -cn --arg sessionKey "$session_key" --arg message "$msg" --arg idempotencyKey "$idem" '{sessionKey:$sessionKey,message:$message,idempotencyKey:$idempotencyKey}')`,
    `max_send_attempts=${resolveWorkerSendMaxAttempts()}`,
    `send_retry_delay_ms=${resolveWorkerSendRetryDelayMs()}`,
    // Fire-and-forget dispatch. Only start polling if the worker turn was actually queued.
    'send_rc=1',
    'send_attempt=1',
    'while [ "$send_attempt" -le "$max_send_attempts" ]; do',
    `  openclaw gateway call chat.send --token "$gateway_token" --timeout 15000 --json --params "$send_params" >/dev/null 2>> ${shellQuote(paths.stderrPath)}`,
    '  send_rc=$?',
    '  if [ "$send_rc" -eq 0 ]; then',
    '    break',
    '  fi',
    '  if [ "$send_attempt" -ge "$max_send_attempts" ]; then',
    '    break',
    '  fi',
    `  sleep_secs=$(python3 - <<PY
attempt = int("$send_attempt")
delay_ms = int("$send_retry_delay_ms")
print(f"{(attempt * delay_ms) / 1000:.3f}")
PY
)`,
    '  sleep "$sleep_secs"',
    '  send_attempt=$((send_attempt + 1))',
    'done',
    'if [ "$send_rc" -ne 0 ]; then',
    `  printf "%s\n" "$send_rc" > ${shellQuote(paths.exitCodePath)}`,
    `  touch ${shellQuote(paths.donePath)}`,
    '  exit 0',
    'fi',
    // Poll for the latest assistant text after since_ts.
    `deadline=$(( since_ts + ${Math.floor(backgroundTimeoutMs)} ))`,
    'while true; do',
    '  now=$(date +%s%3N)',
    '  if [ "$now" -ge "$deadline" ]; then',
    '    break',
    '  fi',
    `  hist_params=$(jq -cn --arg sessionKey "$session_key" --argjson limit ${WORKER_HISTORY_LIMIT} '{sessionKey:$sessionKey,limit:$limit}')`,
    `  hist=$(openclaw gateway call chat.history --token "$gateway_token" --timeout 15000 --json --params "$hist_params" 2>> ${shellQuote(paths.stderrPath)} || true)`,
    // Mirror extractCompletedAssistantReplySince(): only accept a terminal assistant text reply,
    // not an earlier progress note that is followed by toolUse/toolResult events.
    `  text=$(printf "%s" "$hist" | jq -r --argjson since "$since_ts" '([.messages[]? | select((.timestamp|tonumber) > $since)] | sort_by(.timestamp|tonumber) | last) as $last | if ($last | type) != "object" then empty elif ($last.role // "" | ascii_downcase) != "assistant" then empty elif ($last.stopReason // "" | ascii_downcase) == "tooluse" then empty else ([ $last.content[]? | select((.type // "" | ascii_downcase)=="text") | (.text // "") | select(length>0)] | join("\\n")) end')`,
    `  if [ -z "$text" ]; then\n    text=$(SESSION_KEY="$session_key" SINCE_TS="$since_ts" python3 - <<'PY'\nimport json\nimport os\nfrom pathlib import Path\n\nsession_key = os.environ.get('SESSION_KEY', '').strip()\nsince_raw = os.environ.get('SINCE_TS', '').strip()\ntry:\n    since_ts = int(since_raw)\nexcept Exception:\n    raise SystemExit(0)\n\nparts = session_key.split(':', 2)\nif len(parts) < 3 or parts[0] != 'agent' or not parts[1]:\n    raise SystemExit(0)\nagent_id = parts[1]\nroot = os.environ.get('OPENCLAW_HOME', '').strip() or str(Path.home() / '.openclaw')\nsessions_dir = Path(root) / 'agents' / agent_id / 'sessions'\nsessions_index_path = sessions_dir / 'sessions.json'\ntry:\n    index = json.loads(sessions_index_path.read_text())\n    entry = index.get(session_key) or {}\nexcept Exception:\n    raise SystemExit(0)\nsession_file = entry.get('sessionFile')\nif not session_file and entry.get('sessionId'):\n    session_file = str(sessions_dir / f"{entry['sessionId']}.jsonl")\nif not session_file:\n    raise SystemExit(0)\npath = Path(session_file)\ntry:\n    lines = path.read_text().splitlines()\nexcept Exception:\n    raise SystemExit(0)\nmessages = []\nfor line in lines:\n    line = line.strip()\n    if not line:\n        continue\n    try:\n        row = json.loads(line)\n    except Exception:\n        continue\n    if str(row.get('type', '')).lower() != 'message':\n        continue\n    message = row.get('message')\n    if not isinstance(message, dict):\n        continue\n    try:\n        ts = int(__import__('datetime').datetime.fromisoformat(str(row.get('timestamp', '')).replace('Z', '+00:00')).timestamp() * 1000)\n    except Exception:\n        continue\n    if ts <= since_ts:\n        continue\n    messages.append((ts, message))\nif not messages:\n    raise SystemExit(0)\nmessages.sort(key=lambda item: item[0])\n_, last = messages[-1]\nif str(last.get('role', '')).lower() != 'assistant':\n    raise SystemExit(0)\nif str(last.get('stopReason', '')).lower() == 'tooluse':\n    raise SystemExit(0)\ntexts = []\nfor entry in last.get('content') or []:\n    if isinstance(entry, dict) and str(entry.get('type', '')).lower() == 'text':\n        text = str(entry.get('text', '')).strip()\n        if text:\n            texts.append(text)\nif texts:\n    print('\\n'.join(texts), end='')\nPY\n)\n  fi`,
    '  if [ -n "$text" ]; then',
    `    printf "%s" "$text" > ${shellQuote(paths.resultPath)}`,
    `    printf "0\\n" > ${shellQuote(paths.exitCodePath)}`,
    `    touch ${shellQuote(paths.donePath)}`,
    `    ${buildDelegationCompletionHook({ ticketId: params.ticketId, sessionId: params.sessionId, stderrPath: paths.stderrPath })}`,
    '    break',
    '  fi',
    '  sleep 1.2',
    'done',
  ].join('\n');

  const detached: any = execa('bash', ['-lc', script], { detached: true, stdio: 'ignore' } as any);
  if (typeof detached?.unref === 'function') detached.unref();
  if (typeof detached?.catch === 'function') {
    detached.catch(() => undefined);
  }
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

    const deadlineMs = startedAtMs + meta.backgroundTimeoutMs + graceMs;
    if (Date.now() > deadlineMs) {
      await clearWorkerDelegation(opts.delegationDir, sessionId);
      return { kind: 'none' };
    }

    return { kind: 'running', meta };
  }

  const exitCodeRaw = await fs.readFile(paths.exitCodePath, 'utf8').catch(() => '');
  const exitCode = Number.parseInt(exitCodeRaw.trim(), 10);
  const stdoutRaw = await fs.readFile(paths.resultPath, 'utf8').catch(() => '');
  const stderrRaw = await fs.readFile(paths.stderrPath, 'utf8').catch(() => '');
  await clearWorkerDelegation(opts.delegationDir, sessionId);

  if (Number.isFinite(exitCode) && exitCode !== 0 && !stdoutRaw.trim()) {
    return { kind: 'none' };
  }

  const parsed = parseWorkerOutputFromAgentCall(stdoutRaw, stderrRaw);

  if (!parsed.ok) {
    throw new Error(`Background worker turn failed for ticket ${ticketId}: ${parsed.error ?? 'unknown error'}`);
  }

  const fallbackRouting = {
    sessionKey: workerSessionKey(meta.agentId, meta.sessionId),
    sessionId: meta.sessionId,
  };

  return {
    kind: 'completed',
    meta,
    workerOutput: parsed.workerOutput,
    raw: parsed.raw,
    routing: parsed.routing?.sessionKey || parsed.routing?.sessionId ? parsed.routing : fallbackRouting,
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
  const startInBackground = Boolean(opts.shouldStartInBackground?.(params.agentId));
  if (startInBackground) {
    const syncTimeoutMs = resolvePositiveInt(process.env.KWF_WORKER_SYNC_TIMEOUT_MS, opts.defaultSyncTimeoutMs);
    await startWorkerDelegation(
      {
        ticketId: params.ticketId,
        projectId: params.projectId,
        dispatchRunId: params.dispatchRunId,
        agentId: params.agentId,
        sessionId: params.sessionId,
        text: params.text,
        thinking: params.thinking,
        syncTimeoutMs,
      },
      opts,
    );

    return {
      kind: 'delegated',
      notice: `Worker dispatched in background for ticket ${params.ticketId}. Session: ${params.sessionId}.`,
    };
  }

  const message = withDispatchMetadataEnvelope({
    ticketId: params.ticketId,
    projectId: params.projectId,
    dispatchRunId: params.dispatchRunId,
    text: params.text,
  });

  const syncTimeoutMs = resolvePositiveInt(process.env.KWF_WORKER_SYNC_TIMEOUT_MS, opts.defaultSyncTimeoutMs);
  const allowBackgroundDelegation = opts.isBackgroundDelegationAllowed(params.agentId);
  const sessionKey = workerSessionKey(params.agentId, params.sessionId);
  const dispatchStartTs = Date.now();

  try {
    await gatewayCallWithRetry({
      method: 'chat.send',
      rpcParams: {
        sessionKey,
        message,
        idempotencyKey: randomUUID(),
      },
      timeoutMs: Math.max(syncTimeoutMs, 15_000),
      maxAttempts: resolveWorkerSendMaxAttempts(),
      retryDelayMs: resolveWorkerSendRetryDelayMs(),
      shouldRetry: isTransientGatewayDispatchErr,
    });

    const reply = await pollWorkerReply({
      sessionKey,
      sinceTimestamp: dispatchStartTs,
      timeoutMs: syncTimeoutMs,
    });

    if (!reply) {
      if (!allowBackgroundDelegation) {
        throw new Error(`Worker turn timed out for ticket ${params.ticketId}`);
      }

      await startWorkerDelegation(
        {
          ticketId: params.ticketId,
          projectId: params.projectId,
          dispatchRunId: params.dispatchRunId,
          agentId: params.agentId,
          sessionId: params.sessionId,
          text: params.text,
          thinking: params.thinking,
          syncTimeoutMs,
        },
        opts,
      );
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

    if (hasTimedOutFallbackMessage(reply.workerOutput) || hasTimedOutFallbackMessage(reply.raw)) {
      if (!allowBackgroundDelegation) {
        throw new Error(`Worker turn timed out for ticket ${params.ticketId}`);
      }
      await startWorkerDelegation(
        {
          ticketId: params.ticketId,
          projectId: params.projectId,
          dispatchRunId: params.dispatchRunId,
          agentId: params.agentId,
          sessionId: params.sessionId,
          text: params.text,
          thinking: params.thinking,
          syncTimeoutMs,
        },
        opts,
      );
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

    return { kind: 'immediate', workerOutput: reply.workerOutput, raw: reply.raw, routing: reply.routing };
  } catch (err) {
    if (!isRequestTimeoutErr(err)) throw err;

    if (!allowBackgroundDelegation) {
      throw new Error(`Worker turn timed out for ticket ${params.ticketId}`);
    }

    await startWorkerDelegation(
      {
        ticketId: params.ticketId,
        projectId: params.projectId,
        dispatchRunId: params.dispatchRunId,
        agentId: params.agentId,
        sessionId: params.sessionId,
        text: params.text,
        thinking: params.thinking,
        syncTimeoutMs,
      },
      opts,
    );

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

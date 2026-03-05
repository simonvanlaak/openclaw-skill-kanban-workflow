import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { execa } from 'execa';

import { parseWorkerOutputFromAgentCall } from './agent_io.js';

type WorkerRouting = { sessionKey?: string; sessionId?: string; agentSessionId?: string };

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

function extractTextContent(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .map((entry) => (entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null))
    .filter((entry): entry is Record<string, unknown> => !!entry)
    .filter((entry) => String(entry.type ?? '').toLowerCase() === 'text')
    .map((entry) => String(entry.text ?? '').trim())
    .filter((text) => text.length > 0);
}

function extractLatestAssistantTextSince(history: unknown, sinceTimestamp: number): { text: string; timestamp: number; sessionId?: string } | null {
  if (!history || typeof history !== 'object') return null;
  const payload = history as Record<string, unknown>;
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
  const messages = Array.isArray(payload.messages) ? payload.messages : [];

  let latest: { text: string; timestamp: number; sessionId?: string } | null = null;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const row = message as Record<string, unknown>;
    if (String(row.role ?? '').toLowerCase() !== 'assistant') continue;
    const timestamp = Number(row.timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= sinceTimestamp) continue;
    const text = extractTextContent(row.content).join('\n').trim();
    if (!text) continue;
    if (!latest || timestamp > latest.timestamp) {
      latest = { text, timestamp, sessionId };
    }
  }
  return latest;
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

async function pollWorkerReply(params: {
  sessionKey: string;
  sinceTimestamp: number;
  timeoutMs: number;
}): Promise<{ workerOutput: string; raw: string; routing: WorkerRouting } | null> {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    const history = await gatewayCall('chat.history', {
      sessionKey: params.sessionKey,
      limit: 20,
    });
    const latest = extractLatestAssistantTextSince(history, params.sinceTimestamp);
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

  const timeoutSeconds = timeoutMsToSeconds(backgroundTimeoutMs);
  const script = [
    'set +e',
    `openclaw agent --agent ${shellQuote(params.agentId)} --session-id ${shellQuote(params.sessionId)} --thinking ${shellQuote(params.thinking)} --timeout ${timeoutSeconds} --message "$(cat ${shellQuote(paths.messagePath)})" --json > ${shellQuote(paths.resultPath)} 2> ${shellQuote(paths.stderrPath)}`,
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

  const stdoutRaw = await fs.readFile(paths.resultPath, 'utf8').catch(() => '');
  const stderrRaw = await fs.readFile(paths.stderrPath, 'utf8').catch(() => '');
  const parsed = parseWorkerOutputFromAgentCall(stdoutRaw, stderrRaw);
  await clearWorkerDelegation(opts.delegationDir, sessionId);

  if (!parsed.ok) {
    throw new Error(`Background worker turn failed for ticket ${ticketId}: ${parsed.error ?? 'unknown error'}`);
  }

  return {
    kind: 'completed',
    meta,
    workerOutput: parsed.workerOutput,
    raw: parsed.raw,
    routing: parsed.routing,
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
    await gatewayCall('chat.send', {
      sessionKey,
      message,
      idempotencyKey: randomUUID(),
    }, Math.max(syncTimeoutMs, 15_000));

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

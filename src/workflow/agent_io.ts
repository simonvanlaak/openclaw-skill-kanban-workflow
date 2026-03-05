export type AgentCallParsed = {
  workerOutput: string;
  raw: string;
  stderr: string;
  ok: boolean;
  error?: string;
  routing?: {
    sessionKey?: string;
    sessionId?: string;
    agentSessionId?: string;
  };
};

function readText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function extractTextFromContentNode(node: unknown): string[] {
  if (!node || typeof node !== 'object') return [];
  const item = node as Record<string, unknown>;
  const direct = [readText(item.text), readText(item.output_text)].filter((v) => v.trim().length > 0);
  if (direct.length > 0) return direct;

  const nested = item.content;
  if (!Array.isArray(nested)) return [];
  return nested.flatMap((entry) => extractTextFromContentNode(entry));
}

function extractTextFromPayloads(payloads: unknown[]): string {
  return payloads
    .flatMap((payload) => extractTextFromContentNode(payload))
    .filter((text) => text.trim().length > 0)
    .join('\n')
    .trim();
}

export function parseWorkerOutputFromAgentCall(stdoutRaw: unknown, stderrRaw: unknown): AgentCallParsed {
  const raw = String(stdoutRaw ?? '').trim();
  const stderr = String(stderrRaw ?? '').trim();
  let workerOutput = raw;
  let ok = true;
  let error: string | undefined;
  let routing: AgentCallParsed['routing'];

  try {
    const parsed = JSON.parse(raw);
    const meta = parsed?.result?.meta ?? parsed?.meta;
    const systemPromptReport = meta?.systemPromptReport;
    const agentMeta = meta?.agentMeta;
    routing = {
      sessionKey: readText(systemPromptReport?.sessionKey) || undefined,
      sessionId: readText(systemPromptReport?.sessionId) || undefined,
      agentSessionId: readText(agentMeta?.sessionId) || undefined,
    };

    const status = typeof parsed?.status === 'string' ? String(parsed.status).toLowerCase() : undefined;
    if (status && status !== 'ok') {
      ok = false;
      const msg =
        parsed?.error?.message ??
        parsed?.error ??
        parsed?.message ??
        parsed?.summary ??
        `agent status=${status}`;
      error = String(msg);
    }
    const payloads: unknown[] = Array.isArray(parsed?.result?.payloads)
      ? parsed.result.payloads
      : Array.isArray(parsed?.payloads)
        ? parsed.payloads
        : [];
    const asText = extractTextFromPayloads(payloads);
    if (asText.trim()) workerOutput = asText;
  } catch {
    // fallback to raw stdout
  }

  return { workerOutput: workerOutput.trim(), raw, stderr, ok, error, routing };
}

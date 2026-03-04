export type DecisionChoice = 'continue' | 'blocked' | 'completed';
export type DecisionProbabilities = Partial<Record<DecisionChoice, number>>;

export type WorkerReportFacts = {
  hasVerification: boolean;
  hasBlockers: boolean;
  hasResolvedBlockers: boolean;
  hasUncertainties: boolean;
  hasConfidence: boolean;
  missing: string[];
};

export function extractWorkerReportFacts(report: string): WorkerReportFacts {
  const text = String(report ?? '');
  const lower = text.toLowerCase();

  const hasVerification =
    /\bverification\b/.test(lower) ||
    /\bverified\b/.test(lower) ||
    /\btests?\b/.test(lower) ||
    /\bvalidation\b/.test(lower);

  const hasBlockerSignal = /\bblocker(s)?\b/.test(lower) || /\bblocked\b/.test(lower) || /\bdependency\b/.test(lower);
  const hasOpenBlockers = hasBlockerSignal && /\bopen\b/.test(lower);
  const hasResolvedBlockers = hasBlockerSignal && /\bresolved\b/.test(lower);
  const hasBlockers = hasOpenBlockers || hasResolvedBlockers;

  const hasUncertainties =
    /\buncertaint(y|ies)\b/.test(lower) ||
    /\buncertain\b/.test(lower) ||
    /\brisk(s)?\b/.test(lower) ||
    /\bquestion(s)?\b/.test(lower);

  const hasConfidence = /\bconfidence\b/.test(lower) && /\b(0(\.\d+)?|1(\.0+)?)\b/.test(lower);

  const missing: string[] = [];
  if (!hasVerification) missing.push('verification evidence');
  if (!hasBlockers) missing.push('blockers with open/resolved status');
  if (!hasUncertainties) missing.push('uncertainties');
  if (!hasConfidence) missing.push('confidence (0.0..1.0)');

  return { hasVerification, hasBlockers, hasResolvedBlockers, hasUncertainties, hasConfidence, missing };
}

export function parseDecisionChoice(raw: string): DecisionChoice | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  const normalized = text.toLowerCase().replace(/^["'`]+|["'`]+$/g, '').trim();
  if (normalized === 'continue' || normalized === 'blocked' || normalized === 'completed') {
    return normalized;
  }

  // Accept structured fallback if agent returns JSON-formatted decision.
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const candidate = String((parsed as any).decision ?? (parsed as any).label ?? (parsed as any).outcome ?? '').toLowerCase().trim();
      if (candidate === 'continue' || candidate === 'blocked' || candidate === 'completed') {
        return candidate;
      }
    }
  } catch {
    // no-op
  }

  return null;
}

export function coerceDecisionChoice(input: {
  decision: DecisionChoice | null;
  facts: WorkerReportFacts;
  continueCount: number;
}): DecisionChoice {
  let decision: DecisionChoice = input.decision ?? 'blocked';
  if (input.facts.missing.length > 0 && decision !== 'blocked') {
    decision = 'blocked';
  }
  if (decision === 'completed' && !(input.facts.hasVerification && input.facts.hasResolvedBlockers)) {
    decision = 'blocked';
  }
  if (decision === 'continue' && input.continueCount >= 2) {
    decision = 'blocked';
  }
  return decision;
}

export function summarizeReportForComment(report: string, maxChars = 1200): string {
  const normalized = String(report ?? '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return 'No report details provided.';

  const facts = extractWorkerReportFacts(normalized);
  if (facts.missing.length > 0) {
    const msg = `Blockers (OPEN): worker report missing ${facts.missing.join(', ')}. Ask: please include blockers (open/resolved) and questions for humans to resolve.`;
    return msg.length <= maxChars ? msg : `${msg.slice(0, maxChars).trimEnd()}...`;
  }

  const plain = normalized
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!plain) return 'No report details provided.';

  const sentences = plain
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const indexWithSignal = sentences.findIndex((s) => /\bblocker(s)?\b|\bblocked\b|\bquestion(s)?\b|\bask\b/i.test(s));
  const start = indexWithSignal >= 0 ? indexWithSignal : 0;

  const picked = sentences.slice(start, start + 3).join(' ');
  if (picked.length <= maxChars) return picked;
  return `${picked.slice(0, maxChars).trimEnd()}...`;
}

export function extractDecisionProbabilities(report: string): DecisionProbabilities {
  const text = String(report ?? '');
  const read = (label: DecisionChoice): number | undefined => {
    const match = text.match(new RegExp(`\\b${label}\\b\\s*[:=]\\s*([0-9]+(?:\\.[0-9]+)?%?)`, 'i'));
    if (!match?.[1]) return undefined;
    const raw = match[1].trim();
    const isPct = raw.endsWith('%');
    const n = Number(isPct ? raw.slice(0, -1) : raw);
    if (!Number.isFinite(n) || n < 0) return undefined;
    const value = isPct || n > 1 ? n / 100 : n;
    return value <= 1 ? value : undefined;
  };

  const out: DecisionProbabilities = {};
  const c = read('continue');
  const b = read('blocked');
  const d = read('completed');
  if (c != null) out.continue = c;
  if (b != null) out.blocked = b;
  if (d != null) out.completed = d;
  return out;
}

function firstSentenceWithSignal(text: string, signal: RegExp): string | undefined {
  const normalized = text
    .replace(/\r\n?/g, '\n')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[_~]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  const sentences = normalized
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  return sentences.find((s) => signal.test(s)) ?? sentences[0];
}

function clampLine(label: string, text: string, maxChars: number): string {
  const line = `${label}${text.trim()}`;
  if (line.length <= maxChars) return line;
  return `${line.slice(0, maxChars).trimEnd()}...`;
}

export function formatBlockedComment(report: string, facts: WorkerReportFacts, maxChars = 900): string {
  if (facts.missing.length > 0) {
    const lines = [
      'BLOCKED',
      'Blocked because: worker report is still missing required evidence after one follow-up.',
      `Human action required: confirm whether to (A) let runtime retry next cycle or (B) hand this ticket to a human now.`,
      `Evidence: missing fields -> ${facts.missing.join(', ')}.`,
      'Next action after unblock: I will continue execution with the selected path immediately.',
    ];
    const body = lines.join('\n');
    return body.length <= maxChars ? body : `${body.slice(0, maxChars).trimEnd()}...`;
  }

  const reason =
    firstSentenceWithSignal(report, /\bblocker(s)?\b|\bblocked\b|\bdependency\b|\bcannot\b|\bcan\'t\b/i) ??
    'External dependency is preventing safe forward progress.';
  const humanAsk =
    firstSentenceWithSignal(report, /\bask\b|\bplease\b|\bquestion(s)?\b|\bneed\b|\bconfirm\b/i) ??
    'Please confirm how to resolve the blocker so I can proceed.';
  const evidence =
    firstSentenceWithSignal(report, /\bverification\b|\bverified\b|\btest(s)?\b|\berror\b|\bhttp\b|\bid\b|\bstate\b/i) ??
    summarizeReportForComment(report, 240);

  const lines = [
    'BLOCKED',
    clampLine('Blocked because: ', reason, maxChars),
    clampLine('Human action required: ', humanAsk, maxChars),
    clampLine('Evidence: ', evidence, maxChars),
    'Next action after unblock: I will immediately execute the next concrete step and report results.',
  ];
  const body = lines.join('\n');
  return body.length <= maxChars ? body : `${body.slice(0, maxChars).trimEnd()}...`;
}

export function shouldQuietPollAfterCarryForward(params: {
  activeCarryForward: boolean;
  executionOutcomes: Array<'applied' | 'mutation_error' | 'delegated_started' | 'delegated_running'>;
}): boolean {
  if (!params.activeCarryForward) return false;
  if (params.executionOutcomes.length === 0) return false;
  return params.executionOutcomes.every((x) => x === 'delegated_running');
}

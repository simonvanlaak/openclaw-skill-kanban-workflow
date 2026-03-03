export type DecisionChoice = 'continue' | 'blocked' | 'completed';

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
  if (normalized.length <= maxChars) return normalized;

  const sliced = normalized.slice(0, maxChars);
  const newlineCut = sliced.lastIndexOf('\n');
  const cutAt = newlineCut >= Math.floor(maxChars * 0.6) ? newlineCut : maxChars;
  return `${sliced.slice(0, cutAt).trimEnd()}...`;
}

export function shouldQuietPollAfterCarryForward(params: {
  activeCarryForward: boolean;
  executionOutcomes: Array<'applied' | 'mutation_error' | 'delegated_started' | 'delegated_running'>;
}): boolean {
  if (!params.activeCarryForward) return false;
  if (params.executionOutcomes.length === 0) return false;
  return params.executionOutcomes.every((x) => x === 'delegated_running');
}

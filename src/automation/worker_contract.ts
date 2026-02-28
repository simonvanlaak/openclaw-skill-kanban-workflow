export type WorkerTerminalCommand =
  | { kind: 'continue'; text: string }
  | { kind: 'blocked'; text: string }
  | { kind: 'completed'; result: string };

export type WorkerContractValidation = {
  ok: boolean;
  command: WorkerTerminalCommand | null;
  violations: string[];
  evidence: {
    present: boolean;
    hasConcreteExecution: boolean;
    excerpt?: string;
  };
};

function decodeEscapedChar(ch: string): string {
  if (ch === 'n') return '\n';
  if (ch === 't') return '\t';
  if (ch === 'r') return '\r';
  return ch;
}

function parseShellWords(command: string): string[] {
  const out: string[] = [];
  let token = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const next = command[i + 1];

    if (quote) {
      if (ch === '\\' && i + 1 < command.length) {
        token += decodeEscapedChar(command[i + 1]!);
        i++;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      token += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (token.length > 0) {
        out.push(token);
        token = '';
      }
      continue;
    }

    if (ch === '\\' && i + 1 < command.length) {
      token += decodeEscapedChar(command[i + 1]!);
      i++;
      continue;
    }

    if ((ch === '&' && next === '&') || (ch === '|' && next === '|') || ch === ';') {
      if (token.length > 0) out.push(token);
      break;
    }

    token += ch;
  }

  if (token.length > 0) out.push(token);
  return out;
}

function extractEvidenceSection(raw: string): string | null {
  const m = raw.match(/(?:^|\n)\s*EVIDENCE\s*:?(?:\n|$)([\s\S]*?)$/i);
  if (!m) return null;
  return (m[1] ?? '').trim();
}

function hasConcreteExecutionEvidence(evidenceText: string): boolean {
  const lower = evidenceText.toLowerCase();

  if (/changed files\s*:\s*(none|n\/a|no changes?)/i.test(evidenceText)) return false;
  if (/\b(no execution|did not execute|no concrete step|no changes?)\b/i.test(evidenceText)) return false;

  const strongSignals = [
    'executed',
    'ran',
    'tool call',
    'command:',
    'key result',
    'changed files:',
    'updated ',
    'created ',
    'patched ',
    'edited ',
    'test',
  ];
  return strongSignals.some((s) => lower.includes(s));
}

function parseTerminalCommand(line: string): WorkerTerminalCommand | null {
  const words = parseShellWords(line);
  if (words.length < 4) return null;
  if (words[0]?.toLowerCase() !== 'kanban-workflow') return null;

  const cmd = words[1]?.toLowerCase();
  if (cmd === 'continue' || cmd === 'blocked') {
    const flagIndex = words.findIndex((w, i) => i >= 2 && w === '--text');
    const text = flagIndex >= 0 ? words[flagIndex + 1] : undefined;
    if (text && text.trim().length > 0) return { kind: cmd, text };
    return null;
  }

  if (cmd === 'completed') {
    const flagIndex = words.findIndex((w, i) => i >= 2 && w === '--result');
    const result = flagIndex >= 0 ? words[flagIndex + 1] : undefined;
    if (result && result.trim().length > 0) return { kind: 'completed', result };
  }

  return null;
}

export function validateWorkerResponseContract(raw: string): WorkerContractValidation {
  const lines = (raw || '').split(/\r?\n/);
  const commandCandidates = lines
    .map((line, idx) => ({ line: line.trim(), idx }))
    .filter((x) => x.line.toLowerCase().startsWith('kanban-workflow '));

  const violations: string[] = [];

  if (commandCandidates.length !== 1) {
    violations.push('Worker output must contain exactly one terminal kanban-workflow command.');
  }

  const lastNonEmptyIndex = (() => {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i]!.trim().length > 0) return i;
    }
    return -1;
  })();

  let parsed: WorkerTerminalCommand | null = null;
  if (commandCandidates.length === 1) {
    const candidate = commandCandidates[0]!;
    parsed = parseTerminalCommand(candidate.line);
    if (!parsed) {
      violations.push('Terminal command must be one of: continue --text, blocked --text, completed --result.');
    }
    if (candidate.idx !== lastNonEmptyIndex) {
      violations.push('Terminal command must be the final non-empty line in worker output.');
    }
  }

  const evidenceSection = extractEvidenceSection(raw || '');
  const evidencePresent = Boolean(evidenceSection && evidenceSection.trim().length > 0);
  if (!evidencePresent) {
    violations.push('Worker output must include a non-empty EVIDENCE section before the final command.');
  }

  const hasConcreteExecution = evidenceSection ? hasConcreteExecutionEvidence(evidenceSection) : false;
  if (parsed?.kind === 'continue' && !hasConcreteExecution) {
    violations.push('continue requires concrete execution evidence (proof-gate). Use blocked if no concrete step was executed.');
  }

  return {
    ok: violations.length === 0,
    command: violations.length === 0 ? parsed : null,
    violations,
    evidence: {
      present: evidencePresent,
      hasConcreteExecution,
      excerpt: evidenceSection ? evidenceSection.slice(0, 280) : undefined,
    },
  };
}

export function extractWorkerTerminalCommand(raw: string): WorkerTerminalCommand | null {
  const result = validateWorkerResponseContract(raw);
  return result.ok ? result.command : null;
}

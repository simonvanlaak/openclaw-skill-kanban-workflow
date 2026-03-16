import * as fs from 'node:fs/promises';
import * as path from 'node:path';

type SelfCheckSeverity = 'warning' | 'error';

export type ReliabilitySelfCheckIssue = {
  severity: SelfCheckSeverity;
  code: string;
  detail: string;
};

export type ReliabilitySelfCheckResult = {
  ok: boolean;
  issues: ReliabilitySelfCheckIssue[];
};

type ReliabilitySelfCheckFs = {
  access(filePath: string): Promise<void>;
  realpath(filePath: string): Promise<string>;
  readFile(filePath: string, encoding: BufferEncoding): Promise<string>;
};

const defaultFs: ReliabilitySelfCheckFs = {
  access: (filePath) => fs.access(filePath),
  realpath: (filePath) => fs.realpath(filePath),
  readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
};

async function exists(filePath: string, io: ReliabilitySelfCheckFs): Promise<boolean> {
  try {
    await io.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readOpenClawConfig(io: ReliabilitySelfCheckFs): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await io.readFile('/root/.openclaw/openclaw.json', 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function runReliabilitySelfCheck(params: {
  workerAgentId: string;
  workflowLoopAgentId: string;
  io?: ReliabilitySelfCheckFs;
}): Promise<ReliabilitySelfCheckResult> {
  const io = params.io ?? defaultFs;
  const issues: ReliabilitySelfCheckIssue[] = [];
  const expectedHookDir = '/root/.openclaw/workspace/skills/kanban-workflow/hooks/kwf-subagent-ended';
  const liveHookDir = '/root/.openclaw/workspace/hooks/kwf-subagent-ended';
  const backupDir = '/root/.openclaw/workspace/hooks/kwf-subagent-ended.backup-20260315T2106';

  if (!(await exists(expectedHookDir, io))) {
    issues.push({
      severity: 'error',
      code: 'hook_repo_missing',
      detail: `Missing repo hook directory: ${expectedHookDir}`,
    });
  }

  if (!(await exists(liveHookDir, io))) {
    issues.push({
      severity: 'error',
      code: 'hook_live_missing',
      detail: `Missing live hook path: ${liveHookDir}`,
    });
  } else {
    try {
      const resolved = await io.realpath(liveHookDir);
      if (path.resolve(resolved) !== path.resolve(expectedHookDir)) {
        issues.push({
          severity: 'warning',
          code: 'hook_live_drift',
          detail: `Live hook resolves to ${resolved}, expected ${expectedHookDir}`,
        });
      }
    } catch (err) {
      issues.push({
        severity: 'warning',
        code: 'hook_live_unreadable',
        detail: `Could not resolve live hook path: ${String(err)}`,
      });
    }
  }

  if (await exists(backupDir, io)) {
    issues.push({
      severity: 'warning',
      code: 'hook_backup_present',
      detail: `Stale backup hook directory exists: ${backupDir}`,
    });
  }

  const config = await readOpenClawConfig(io);
  if (!config) {
    issues.push({
      severity: 'warning',
      code: 'openclaw_config_unreadable',
      detail: 'Could not read /root/.openclaw/openclaw.json for runtime validation',
    });
  } else {
    const hooks = (config.hooks && typeof config.hooks === 'object')
      ? (config.hooks as Record<string, unknown>)
      : {};
    const internal = (hooks.internal && typeof hooks.internal === 'object')
      ? (hooks.internal as Record<string, unknown>)
      : {};
    const entries = (internal.entries && typeof internal.entries === 'object')
      ? (internal.entries as Record<string, unknown>)
      : {};
    const hookEntry = (entries['kwf-subagent-ended'] && typeof entries['kwf-subagent-ended'] === 'object')
      ? (entries['kwf-subagent-ended'] as Record<string, unknown>)
      : null;
    if (!hookEntry || hookEntry.enabled !== true) {
      issues.push({
        severity: 'warning',
        code: 'hook_disabled',
        detail: 'kwf-subagent-ended is not enabled in /root/.openclaw/openclaw.json',
      });
    }

    const agents = (config.agents && typeof config.agents === 'object')
      ? (config.agents as Record<string, unknown>)
      : {};
    const list = Array.isArray(agents.list) ? agents.list : [];
    const loopAgent = list.find((entry) => (
      entry && typeof entry === 'object' && String((entry as Record<string, unknown>).id ?? '') === params.workflowLoopAgentId
    )) as Record<string, unknown> | undefined;
    const allowed = Array.isArray((loopAgent?.subagents as Record<string, unknown> | undefined)?.allowAgents)
      ? ((loopAgent?.subagents as Record<string, unknown>).allowAgents as unknown[]).map((v) => String(v))
      : [];
    if (loopAgent && !allowed.includes(params.workerAgentId)) {
      issues.push({
        severity: 'warning',
        code: 'worker_not_allowed',
        detail: `${params.workflowLoopAgentId} subagents.allowAgents does not include ${params.workerAgentId}`,
      });
    }
  }

  return {
    ok: issues.every((issue) => issue.severity !== 'error'),
    issues,
  };
}

import { describe, expect, it } from 'vitest';

import { runReliabilitySelfCheck } from '../src/workflow/reliability_self_check.js';

describe('reliability_self_check', () => {
  it('warns when stale backup hook directories are present', async () => {
    const existingPaths = new Set<string>();

    const result = await runReliabilitySelfCheck({
      workerAgentId: 'main',
      workflowLoopAgentId: 'kanban-workflow-workflow-loop',
      io: {
        access: async (filePath: string) => {
          if (
            filePath === '/root/.openclaw/workspace/skills/kanban-workflow/hooks/kwf-subagent-ended'
            || filePath === '/root/.openclaw/workspace/hooks/kwf-subagent-ended'
            || filePath === '/root/.openclaw/workspace/hooks/kwf-subagent-ended.backup-20260315T2106'
          ) {
            existingPaths.add(filePath);
            return;
          }
          throw new Error('missing');
        },
        realpath: async (filePath: string) => filePath,
        readFile: async (filePath: string) => {
          if (filePath === '/root/.openclaw/openclaw.json') {
            return JSON.stringify({
              hooks: { internal: { enabled: true, entries: { 'kwf-subagent-ended': { enabled: true } } } },
              agents: { list: [{ id: 'kanban-workflow-workflow-loop', subagents: { allowAgents: ['main'] } }] },
            });
          }
          throw new Error('unexpected');
        },
      },
    });

    expect(existingPaths.size).toBeGreaterThan(0);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'hook_backup_present', severity: 'warning' }),
      ]),
    );
  });
});

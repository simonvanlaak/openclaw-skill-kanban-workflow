import { describe, expect, it } from 'vitest';

import { validateWorkerResponseContract } from '../src/automation/worker_contract.js';

describe('worker contract validation', () => {
  it('rejects continue when concrete execution evidence is missing', () => {
    const res = validateWorkerResponseContract([
      'Status update only.',
      'EVIDENCE',
      '- executed: none',
      '- key result/output: still investigating',
      '- changed files: none',
      'kanban-workflow continue --text "Still looking, no concrete step done."',
    ].join('\n'));

    expect(res.ok).toBe(false);
    expect(res.violations.join(' ')).toContain('proof-gate');
  });

  it('accepts continue when command is final line and evidence is concrete', () => {
    const res = validateWorkerResponseContract([
      'Implemented fix.',
      'EVIDENCE',
      '- executed: npm test',
      '- key result/output: 68 tests passed',
      '- changed files: src/cli.ts',
      'kanban-workflow continue --text "Patched parser and verified tests, next step is live cron run."',
    ].join('\n'));

    expect(res.ok).toBe(true);
    expect(res.command).toEqual({
      kind: 'continue',
      text: 'Patched parser and verified tests, next step is live cron run.',
    });
  });
});

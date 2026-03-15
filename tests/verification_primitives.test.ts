import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

const script = path.resolve('scripts/verification_primitives.sh');

describe('verification_primitives.sh', () => {
  it('passes file-contains checks for deterministic artifacts', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'kwf-verify-'));
    const file = path.join(dir, 'report.md');
    await writeFile(file, 'Acceptance criteria met\nEvidence attached\n', 'utf8');

    const run = await execa(script, ['file-contains', file, 'Acceptance criteria met'], {
      cwd: path.resolve('.'),
    });

    expect(run.stdout).toContain('PASS: file-contains');
  });

  it('passes numeric threshold checks for metric evidence', async () => {
    const run = await execa(script, ['metric-threshold', 'p95_ms', '183', 'le', '200'], {
      cwd: path.resolve('.'),
    });

    expect(run.stdout).toContain('PASS: metric-threshold');
    expect(run.stdout).toContain('label=p95_ms');
  });
});

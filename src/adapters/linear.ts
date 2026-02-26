import type { Adapter } from '../adapter.js';
import type { WorkItem } from '../models.js';

import { CliRunner } from './cli.js';

/**
 * Linear adapter (CLI-auth only).
 *
 * Notes:
 * - This adapter intentionally does NOT handle HTTP auth; it relies on a local Linear CLI session.
 * - Linear CLI commands vary by installation/version; pass listArgs explicitly.
 */
export class LinearAdapter implements Adapter {
  private readonly cli: CliRunner;
  private readonly listArgs: readonly string[];

  constructor(opts?: { bin?: string; listArgs?: readonly string[] }) {
    this.cli = new CliRunner(opts?.bin ?? 'linear');
    this.listArgs = opts?.listArgs ?? ['issue', 'list', '--json'];
  }

  name(): string {
    return 'linear';
  }

  async fetchSnapshot(): Promise<ReadonlyMap<string, WorkItem>> {
    // TODO: Define a stable JSON schema for the Linear CLI output we expect.
    // For now, we intentionally fail fast with a clear message so the caller can configure listArgs.
    const hint =
      'LinearAdapter is scaffolded. Configure the correct Linear CLI listArgs (and mapping) for your environment.';
    // Run once to surface CLI errors early.
    await this.cli.run(this.listArgs);
    throw new Error(hint);
  }
}

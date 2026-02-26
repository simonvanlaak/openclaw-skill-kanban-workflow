import type { Adapter } from '../adapter.js';
import type { WorkItem } from '../models.js';

import { CliRunner } from './cli.js';

/**
 * Planka adapter (CLI-auth only).
 *
 * Planka doesn't have a universally standard CLI. This adapter is a scaffold that assumes
 * you have a `planka` (or custom) CLI that can output JSON.
 */
export class PlankaAdapter implements Adapter {
  private readonly cli: CliRunner;
  private readonly listArgs: readonly string[];

  constructor(opts?: { bin?: string; listArgs?: readonly string[] }) {
    this.cli = new CliRunner(opts?.bin ?? 'planka');
    this.listArgs = opts?.listArgs ?? ['cards', 'list', '--json'];
  }

  name(): string {
    return 'planka';
  }

  async fetchSnapshot(): Promise<ReadonlyMap<string, WorkItem>> {
    const hint =
      'PlankaAdapter is scaffolded. Provide a planka CLI + listArgs that returns JSON, then implement mapping to WorkItem.';
    await this.cli.run(this.listArgs);
    throw new Error(hint);
  }
}

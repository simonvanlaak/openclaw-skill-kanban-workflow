import type { Adapter } from '../adapter.js';
import type { WorkItem } from '../models.js';

import { CliRunner } from './cli.js';

/**
 * Plane adapter (CLI-auth only).
 *
 * Plane is often self-hosted; CLI tooling may vary. This adapter is a scaffold expecting a
 * `plane` CLI (or wrapper) that can output JSON.
 */
export class PlaneAdapter implements Adapter {
  private readonly cli: CliRunner;
  private readonly listArgs: readonly string[];

  constructor(opts?: { bin?: string; listArgs?: readonly string[] }) {
    this.cli = new CliRunner(opts?.bin ?? 'plane');
    this.listArgs = opts?.listArgs ?? ['issues', 'list', '--json'];
  }

  name(): string {
    return 'plane';
  }

  async fetchSnapshot(): Promise<ReadonlyMap<string, WorkItem>> {
    const hint =
      'PlaneAdapter is scaffolded. Provide a plane CLI + listArgs that returns JSON, then implement mapping to WorkItem.';
    await this.cli.run(this.listArgs);
    throw new Error(hint);
  }
}

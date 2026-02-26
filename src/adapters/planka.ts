import type { Adapter } from '../adapter.js';
import type { WorkItem } from '../models.js';

import { CliRunner } from './cli.js';

/**
 * Planka adapter (CLI-auth only).
 *
 * Planka doesn't have a universally standard CLI. This adapter is a scaffold that assumes
 * you have a `planka` (or custom) CLI that can output JSON.
 */
import { z } from 'zod';

import { Stage } from '../stage.js';

export class PlankaAdapter implements Adapter {
  private readonly cli: CliRunner;
  private readonly listArgs: readonly string[];

  constructor(opts?: { bin?: string; listArgs?: readonly string[] }) {
    // Uses https://github.com/voydz/planka-cli
    this.cli = new CliRunner(opts?.bin ?? 'planka-cli');
    // NOTE: planka-cli output flags may differ by version. Override listArgs if needed.
    this.listArgs = opts?.listArgs ?? ['cards', 'list', '--json'];
  }

  name(): string {
    return 'planka';
  }

  async fetchSnapshot(): Promise<ReadonlyMap<string, WorkItem>> {
    const out = await this.cli.run(this.listArgs);

    // Best-effort schema for planka-cli JSON output. Adjust once we lock down the exact fields.
    const CardSchema = z.object({
      id: z.union([z.string(), z.number()]).transform((v) => String(v)),
      name: z.string().default(''),
      url: z.string().optional(),
      updatedAt: z.string().optional(),
      labels: z
        .array(z.object({ name: z.string() }).passthrough())
        .optional()
        .default([])
        .transform((arr) => arr.map((x) => x.name)),
      list: z
        .object({ name: z.string() })
        .optional(),
    });

    const ParsedSchema = z.array(CardSchema);
    const cards = ParsedSchema.parse(JSON.parse(out || '[]'));

    const items = new Map<string, WorkItem>();

    for (const card of cards) {
      const stageLabel = card.labels.find((l) => l.toLowerCase().startsWith('stage:'));
      const stageSource = stageLabel ?? card.list?.name;
      if (!stageSource) continue;

      let stage: Stage;
      try {
        stage = Stage.fromAny(stageSource);
      } catch {
        // If list/labels don't match canonical stages, skip rather than mis-classify.
        continue;
      }

      items.set(card.id, {
        id: card.id,
        title: card.name,
        stage,
        url: card.url,
        labels: card.labels,
        updatedAt: card.updatedAt ? new Date(card.updatedAt) : undefined,
        raw: card,
      });
    }

    return items;
  }
}

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { StageKey } from '../stage.js';

export const DEFAULT_AUTO_REOPEN_CURSOR_PATH = '.tmp/kwf-auto-reopen-cursor.json';

export type AutoReopenCursor = {
  version: 1;
  seenByTicket: Record<string, string>;
};

export type AutoReopenPort = {
  whoami(): Promise<{ id?: string; username?: string; name?: string }>;
  listIdsByStage(stage: StageKey): Promise<string[]>;
  listComments(
    id: string,
    opts: { limit: number; newestFirst: boolean; includeInternal: boolean },
  ): Promise<
    Array<{
      id: string;
      body?: string;
      createdAt?: Date;
      author?: { id?: string; username?: string; name?: string };
    }>
  >;
  setStage(id: string, stage: StageKey): Promise<void>;
};

export type AutoReopenAction = {
  ticketId: string;
  fromStage: 'stage:blocked' | 'stage:in-review';
  toStage: StageKey;
  triggerCommentId: string;
};

function normalizeActorKeys(actor?: { id?: string; username?: string; name?: string }): Set<string> {
  const keys = [actor?.id, actor?.username, actor?.name]
    .filter((v): v is string => Boolean(v && String(v).trim().length > 0))
    .map((v) => String(v).trim().toLowerCase());
  return new Set(keys);
}

function parseRelayedAuthorNameFromBody(body?: string): string | undefined {
  if (!body) return undefined;
  // Bridge/import shape seen in production (Planka -> Plane):
  // [planka-comment:<id>]\nAuthor: Simon van Laak\nCreated ...
  const match = body.match(/(?:^|\n|\\n)\s*Author\s*:\s*([^\n\r\\]+)/i);
  const name = match?.[1]?.trim();
  return name ? name : undefined;
}

function isHumanRelativeToWorker(
  comment: { body?: string; author?: { id?: string; username?: string; name?: string } } | undefined,
  meKeys: Set<string>,
): boolean {
  if (!comment) return false;

  const authorKeys = normalizeActorKeys(comment.author);
  const relayedAuthor = parseRelayedAuthorNameFromBody(comment.body);
  const relayedIsHuman = relayedAuthor ? !meKeys.has(relayedAuthor.toLowerCase()) : false;

  if (authorKeys.size > 0) {
    let authoredByWorker = false;
    for (const key of authorKeys) {
      if (meKeys.has(key)) {
        authoredByWorker = true;
        break;
      }
    }

    // Normal path: platform exposes distinct human actor ids/usernames.
    if (!authoredByWorker) return true;

    // Bridge/import path: worker account relays a human message in comment body.
    return relayedIsHuman;
  }

  return relayedIsHuman;
}

async function loadCursor(path: string): Promise<AutoReopenCursor> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { version: 1, seenByTicket: {} };
    const seenByTicket = parsed.seenByTicket && typeof parsed.seenByTicket === 'object' ? parsed.seenByTicket : {};
    return { version: 1, seenByTicket };
  } catch {
    return { version: 1, seenByTicket: {} };
  }
}

async function saveCursor(cursorPath: string, cursor: AutoReopenCursor): Promise<void> {
  await fs.mkdir(path.dirname(cursorPath), { recursive: true });
  await fs.writeFile(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`, 'utf8');
}

export async function runAutoReopenOnHumanComment(opts: {
  adapter: AutoReopenPort;
  dryRun?: boolean;
  cursorPath?: string;
  includeInternal?: boolean;
  commentLimit?: number;
  requeueTargetStage?: StageKey;
}): Promise<{ actions: AutoReopenAction[] }> {
  const cursorPath = opts.cursorPath ?? DEFAULT_AUTO_REOPEN_CURSOR_PATH;
  const includeInternal = opts.includeInternal ?? true;
  const commentLimit = Math.max(1, opts.commentLimit ?? 100);
  const dryRun = Boolean(opts.dryRun);
  const requeueTargetStage: StageKey = opts.requeueTargetStage ?? 'stage:todo';

  const cursor = await loadCursor(cursorPath);
  const me = await opts.adapter.whoami();
  const meKeys = normalizeActorKeys(me);

  const watchedStages: Array<'stage:blocked' | 'stage:in-review'> = ['stage:blocked', 'stage:in-review'];
  const actions: AutoReopenAction[] = [];

  for (const stage of watchedStages) {
    const ids = await opts.adapter.listIdsByStage(stage);
    for (const id of ids) {
      const comments = await opts.adapter.listComments(id, {
        limit: commentLimit,
        newestFirst: true,
        includeInternal,
      });

      const seenCommentId = cursor.seenByTicket[id];
      let trigger: { id: string } | null = null;

      for (const c of comments) {
        if (!c?.id) continue;
        if (seenCommentId && c.id === seenCommentId) break;
        if (isHumanRelativeToWorker(c, meKeys)) {
          trigger = { id: c.id };
          break;
        }
      }

      if (trigger) {
        actions.push({ ticketId: id, fromStage: stage, toStage: requeueTargetStage, triggerCommentId: trigger.id });
        if (!dryRun) {
          await opts.adapter.setStage(id, requeueTargetStage);
        }
      }

      const newestId = comments[0]?.id;
      if (newestId) cursor.seenByTicket[id] = newestId;
    }
  }

  if (!dryRun) {
    await saveCursor(cursorPath, cursor);
  }

  return { actions };
}

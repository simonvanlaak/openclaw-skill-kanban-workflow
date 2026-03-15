import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { SessionMap } from './session_dispatcher.js';
import type { StageKey } from '../stage.js';
import { markTicketQueued } from '../workflow/workflow_state.js';

export const DEFAULT_AUTO_REOPEN_CURSOR_PATH = '.tmp/kwf-auto-reopen-cursor.json';
const AUTO_REOPEN_FULL_SCAN_LIMIT = 100;
const AUTO_REOPEN_NEWEST_ONLY_LIMIT = 1;

export type AutoReopenCursor = {
  version: 1;
  seenByTicket: Record<string, string>;
};

export type AutoReopenPort = {
  whoami(): Promise<{ id?: string; username?: string; name?: string }>;
  listIdsByStage(stage: StageKey): Promise<string[]>;
  listIdsInDoneState?(): Promise<string[]>;
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

type SingleTicketAutoReopenPort = Pick<AutoReopenPort, 'whoami' | 'listComments' | 'setStage'>;

export type AutoReopenAction = {
  ticketId: string;
  fromStage: 'stage:blocked' | 'stage:in-review';
  toStage: StageKey;
  triggerCommentId: string;
};

type AutoReopenComment = {
  id: string;
  body?: string;
  createdAt?: Date;
  author?: { id?: string; username?: string; name?: string };
};

type PersistMapFn = (map: SessionMap) => Promise<void>;

function normalizeActorKeys(actor?: { id?: string; username?: string; name?: string }): Set<string> {
  const keys = [actor?.id, actor?.username, actor?.name]
    .filter((v): v is string => Boolean(v && String(v).trim().length > 0))
    .map((v) => String(v).trim().toLowerCase());
  return new Set(keys);
}

function parseRelayedAuthorNameFromBody(body?: string): string | undefined {
  if (!body) return undefined;
  // Imported/relayed comment shape seen in production:
  // [imported-comment:<id>]\nAuthor: Simon van Laak\nCreated ...
  const match = body.match(/(?:^|\n|\\n)\s*Author\s*:\s*([^\n\r\\]+)/i);
  const name = match?.[1]?.trim();
  return name ? name : undefined;
}

function isAuthoredByWorker(
  comment: { author?: { id?: string; username?: string; name?: string } } | undefined,
  meKeys: Set<string>,
): boolean {
  if (!comment) return false;
  const authorKeys = normalizeActorKeys(comment.author);
  if (authorKeys.size === 0) return false;
  for (const key of authorKeys) {
    if (meKeys.has(key)) return true;
  }
  return false;
}

function isWorkerDecisionBoundary(
  comment: { body?: string; author?: { id?: string; username?: string; name?: string } } | undefined,
  meKeys: Set<string>,
): boolean {
  if (!comment) return false;
  if (!isAuthoredByWorker(comment, meKeys)) return false;
  const body = String(comment.body ?? '').toLowerCase();
  if (!body) return false;
  return (
    body.includes('worker decision:') ||
    body.includes('moving this ticket to blocked') ||
    body.includes('human action requested: provide clarification and rerun workflow-loop')
  );
}

function isHumanRelativeToWorker(
  comment: { body?: string; author?: { id?: string; username?: string; name?: string } } | undefined,
  meKeys: Set<string>,
): boolean {
  if (!comment) return false;

  const relayedAuthor = parseRelayedAuthorNameFromBody(comment.body);
  const relayedIsHuman = relayedAuthor ? !meKeys.has(relayedAuthor.toLowerCase()) : false;

  if (isAuthoredByWorker(comment, meKeys)) {
    // Bridge/import path: worker account relays a human message in comment body.
    return relayedIsHuman;
  }

  const authorKeys = normalizeActorKeys(comment.author);
  if (authorKeys.size > 0) {
    // Normal path: platform exposes distinct human actor ids/usernames.
    return true;
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

function findAutoReopenTrigger(params: {
  comments: AutoReopenComment[];
  seenCommentId?: string;
  expectedTriggerCommentId?: string;
  meKeys: Set<string>;
}): { triggerCommentId?: string; newestCommentId?: string } {
  const { comments, seenCommentId, expectedTriggerCommentId, meKeys } = params;
  let triggerCommentId: string | undefined;

  for (const c of comments) {
    if (!c?.id) continue;
    if (seenCommentId && c.id === seenCommentId) break;
    if (expectedTriggerCommentId && c.id === expectedTriggerCommentId) {
      if (isHumanRelativeToWorker(c, meKeys)) {
        triggerCommentId = c.id;
      }
      break;
    }
    if (!expectedTriggerCommentId && isHumanRelativeToWorker(c, meKeys)) {
      triggerCommentId = c.id;
      break;
    }
    if (isWorkerDecisionBoundary(c, meKeys)) {
      break;
    }
  }

  return { triggerCommentId, newestCommentId: comments[0]?.id };
}

export async function runAutoReopenForTicket(opts: {
  adapter: SingleTicketAutoReopenPort;
  ticketId: string;
  fromStage: 'stage:blocked' | 'stage:in-review';
  map?: SessionMap;
  dryRun?: boolean;
  cursorPath?: string;
  includeInternal?: boolean;
  commentLimit?: number;
  requeueTargetStage?: StageKey;
  expectedTriggerCommentId?: string;
  persistMap?: PersistMapFn;
}): Promise<{ actions: AutoReopenAction[] }> {
  const cursorPath = opts.cursorPath ?? DEFAULT_AUTO_REOPEN_CURSOR_PATH;
  const includeInternal = opts.includeInternal ?? true;
  const commentLimit = Math.max(1, opts.commentLimit ?? AUTO_REOPEN_FULL_SCAN_LIMIT);
  const dryRun = Boolean(opts.dryRun);
  const requeueTargetStage: StageKey = opts.requeueTargetStage ?? 'stage:todo';

  const cursor = await loadCursor(cursorPath);
  const me = await opts.adapter.whoami();
  const meKeys = normalizeActorKeys(me);
  const newestComments = await opts.adapter.listComments(opts.ticketId, {
    limit: AUTO_REOPEN_NEWEST_ONLY_LIMIT,
    newestFirst: true,
    includeInternal,
  });
  const newestCommentId = newestComments[0]?.id;
  if (
    !opts.expectedTriggerCommentId &&
    newestCommentId &&
    cursor.seenByTicket[opts.ticketId] === newestCommentId
  ) {
    return { actions: [] };
  }

  const comments = commentLimit === AUTO_REOPEN_NEWEST_ONLY_LIMIT
    ? newestComments
    : await opts.adapter.listComments(opts.ticketId, {
        limit: commentLimit,
        newestFirst: true,
        includeInternal,
      });

  const { triggerCommentId, newestCommentId: resolvedNewestCommentId } = findAutoReopenTrigger({
    comments,
    seenCommentId: cursor.seenByTicket[opts.ticketId],
    expectedTriggerCommentId: opts.expectedTriggerCommentId,
    meKeys,
  });

  const actions: AutoReopenAction[] = [];
  if (triggerCommentId) {
    actions.push({
      ticketId: opts.ticketId,
      fromStage: opts.fromStage,
      toStage: requeueTargetStage,
      triggerCommentId,
    });
    if (!dryRun) {
      if (opts.map) {
        const entry = opts.map.sessionsByTicket?.[opts.ticketId];
        const existing = entry?.pendingMutation;
        const reuseExisting = existing
          && existing.kind === 'human_reopen'
          && existing.fromStage === opts.fromStage
          && existing.toStage === requeueTargetStage
          && existing.triggerCommentId === triggerCommentId;

        if (entry && !reuseExisting) {
          entry.pendingMutation = {
            kind: 'human_reopen',
            fromStage: opts.fromStage,
            toStage: requeueTargetStage,
            triggerCommentId,
            createdAt: new Date().toISOString(),
          };
          await opts.persistMap?.(opts.map);
        }

        const pending = entry?.pendingMutation;
        if (pending?.kind === 'human_reopen' && !pending.stageAppliedAt) {
          await opts.adapter.setStage(opts.ticketId, requeueTargetStage);
          pending.stageAppliedAt = new Date().toISOString();
          await opts.persistMap?.(opts.map);
        } else if (!pending || pending.kind !== 'human_reopen') {
          await opts.adapter.setStage(opts.ticketId, requeueTargetStage);
        }

        markTicketQueued(opts.map, opts.ticketId, new Date());
        await opts.persistMap?.(opts.map);
      } else {
        await opts.adapter.setStage(opts.ticketId, requeueTargetStage);
      }
    }
  }

  if (resolvedNewestCommentId && !dryRun) {
    cursor.seenByTicket[opts.ticketId] = resolvedNewestCommentId;
    await saveCursor(cursorPath, cursor);
  }

  return { actions };
}

export async function runAutoReopenOnHumanComment(opts: {
  adapter: AutoReopenPort;
  map?: SessionMap;
  dryRun?: boolean;
  cursorPath?: string;
  includeInternal?: boolean;
  commentLimit?: number;
  requeueTargetStage?: StageKey;
  persistMap?: PersistMapFn;
}): Promise<{ actions: AutoReopenAction[] }> {
  const cursorPath = opts.cursorPath ?? DEFAULT_AUTO_REOPEN_CURSOR_PATH;
  const includeInternal = opts.includeInternal ?? true;
  const commentLimit = Math.max(1, opts.commentLimit ?? AUTO_REOPEN_FULL_SCAN_LIMIT);
  const dryRun = Boolean(opts.dryRun);
  const requeueTargetStage: StageKey = opts.requeueTargetStage ?? 'stage:todo';

  const cursor = await loadCursor(cursorPath);
  const me = await opts.adapter.whoami();
  const meKeys = normalizeActorKeys(me);

  const watchedStages: Array<'stage:blocked' | 'stage:in-review'> = ['stage:blocked', 'stage:in-review'];
  const actions: AutoReopenAction[] = [];

  const watchedBuckets: Array<{ fromStage: 'stage:blocked' | 'stage:in-review'; ids: string[] }> = [];
  for (const stage of watchedStages) {
    watchedBuckets.push({ fromStage: stage, ids: await opts.adapter.listIdsByStage(stage) });
  }

  for (const { fromStage: stage, ids } of watchedBuckets) {
    for (const id of ids) {
      const newestComments = await opts.adapter.listComments(id, {
        limit: AUTO_REOPEN_NEWEST_ONLY_LIMIT,
        newestFirst: true,
        includeInternal,
      });
      const newestCommentId = newestComments[0]?.id;
      if (newestCommentId && cursor.seenByTicket[id] === newestCommentId) {
        continue;
      }

      const comments = commentLimit === AUTO_REOPEN_NEWEST_ONLY_LIMIT
        ? newestComments
        : await opts.adapter.listComments(id, {
            limit: commentLimit,
            newestFirst: true,
            includeInternal,
          });

      const { triggerCommentId, newestCommentId: resolvedNewestCommentId } = findAutoReopenTrigger({
        comments,
        seenCommentId: cursor.seenByTicket[id],
        meKeys,
      });

      if (triggerCommentId) {
        actions.push({ ticketId: id, fromStage: stage, toStage: requeueTargetStage, triggerCommentId });
        if (!dryRun) {
          if (opts.map) {
            const entry = opts.map.sessionsByTicket?.[id];
            const existing = entry?.pendingMutation;
            const reuseExisting = existing
              && existing.kind === 'human_reopen'
              && existing.fromStage === stage
              && existing.toStage === requeueTargetStage
              && existing.triggerCommentId === triggerCommentId;

            if (entry && !reuseExisting) {
              entry.pendingMutation = {
                kind: 'human_reopen',
                fromStage: stage,
                toStage: requeueTargetStage,
                triggerCommentId,
                createdAt: new Date().toISOString(),
              };
              await opts.persistMap?.(opts.map);
            }

            const pending = entry?.pendingMutation;
            if (pending?.kind === 'human_reopen' && !pending.stageAppliedAt) {
              await opts.adapter.setStage(id, requeueTargetStage);
              pending.stageAppliedAt = new Date().toISOString();
              await opts.persistMap?.(opts.map);
            } else if (!pending || pending.kind !== 'human_reopen') {
              await opts.adapter.setStage(id, requeueTargetStage);
            }

            markTicketQueued(opts.map, id, new Date());
            await opts.persistMap?.(opts.map);
          } else {
            await opts.adapter.setStage(id, requeueTargetStage);
          }
        }
      }

      if (resolvedNewestCommentId) cursor.seenByTicket[id] = resolvedNewestCommentId;
    }
  }

  if (!dryRun) {
    await saveCursor(cursorPath, cursor);
  }

  return { actions };
}

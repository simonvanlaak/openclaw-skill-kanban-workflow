import type { SessionMap } from '../automation/session_dispatcher.js';

const LEGACY_QUEUE_MARKER = '[kwf:queue-position]';
const QUEUE_COMMENT_TEMPLATE_VERSION = 2;
const DEFAULT_AVERAGE_DURATION_MS = 20 * 60 * 1000;
const QUEUE_TEXT_PREFIX = 'There are ';
const QUEUE_TEXT_MIDDLE = ' tickets with higher priority that I need to complete (';
const QUEUE_TEXT_SUFFIX = ') before this ticket can be started. If this is urgent, change the priority.';

function etaDisplayFromMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '<1h';
  if (ms < 60 * 60 * 1000) return '<1h';
  const hours = Math.ceil(ms / (60 * 60 * 1000));
  return `<${hours}h`;
}

function averageDurationMsFromRecentSamples(samples: number[] | undefined): number {
  if (!Array.isArray(samples) || samples.length < 3) return DEFAULT_AVERAGE_DURATION_MS;
  const recent = samples.slice(-3);
  const total = recent.reduce((sum, value) => sum + value, 0);
  return total / recent.length;
}

function messageForHigherPriorityCount(higherPriorityCount: number, averageDurationMs: number): string {
  const estimateMs = (higherPriorityCount + 1) * averageDurationMs;
  const eta = etaDisplayFromMs(estimateMs);
  return `${QUEUE_TEXT_PREFIX}${higherPriorityCount}${QUEUE_TEXT_MIDDLE}${eta}${QUEUE_TEXT_SUFFIX}`;
}

function renderQueueComment(higherPriorityCount: number, averageDurationMs: number): string {
  return messageForHigherPriorityCount(higherPriorityCount, averageDurationMs);
}

function normalizeText(text: string | undefined): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function actorKeys(actor: { id?: string; username?: string; name?: string } | undefined): string[] {
  if (!actor) return [];
  return [actor.id, actor.username, actor.name]
    .map((value) => normalizeText(value))
    .filter((value) => value.length > 0);
}

function isDispatcherOwnedComment(
  comment: { body: string; author?: { id?: string; username?: string; name?: string } },
  me: { id?: string; username?: string; name?: string },
): boolean {
  const body = String(comment.body ?? '');
  const hasLegacyMarker = body.includes(LEGACY_QUEUE_MARKER);
  const hasQueueTemplate = body.startsWith(QUEUE_TEXT_PREFIX) && body.includes(QUEUE_TEXT_MIDDLE) && body.endsWith(QUEUE_TEXT_SUFFIX);
  if (!hasLegacyMarker && !hasQueueTemplate) return false;
  const meKeys = new Set(actorKeys(me));
  if (meKeys.size === 0) return false;
  const author = actorKeys(comment.author);
  if (author.length === 0) return false;
  return author.some((key) => meKeys.has(key));
}

export type QueuePositionReconcileResult = {
  outcome: 'applied' | 'skipped_dry_run' | 'error';
  queuedTickets: number;
  activeOffset: number;
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  errors: string[];
};

type QueueCommentAdapter = {
  whoami(): Promise<{ id?: string; username?: string; name?: string }>;
  listBacklogIdsInOrder(): Promise<string[]>;
  listComments(
    id: string,
    opts: { limit: number; newestFirst: boolean; includeInternal: boolean },
  ): Promise<Array<{ id: string; body: string; author?: { id?: string; username?: string; name?: string } }>>;
  addComment(id: string, body: string): Promise<void>;
  updateComment(id: string, commentId: string, body: string): Promise<void>;
  deleteComment(id: string, commentId: string): Promise<void>;
};

export async function reconcileQueuePositionComments(params: {
  adapter: QueueCommentAdapter;
  map: SessionMap;
  dryRun: boolean;
}): Promise<QueuePositionReconcileResult> {
  const state =
    params.map.queuePosition ??
    (params.map.queuePosition = {
      commentsByTicket: {},
    });
  const commentsByTicket = state.commentsByTicket ?? (state.commentsByTicket = {});

  const errors: string[] = [];
  let created = 0;
  let updated = 0;
  let deleted = 0;
  let unchanged = 0;

  const queueTicketIds = await params.adapter.listBacklogIdsInOrder();
  const queueSet = new Set(queueTicketIds);
  const trackedIds = Object.keys(commentsByTicket);
  const activeOffset = params.map.active?.ticketId ? 1 : 0;
  const averageDurationMs = averageDurationMsFromRecentSamples(state.recentCompletionDurationsMs);
  const me = await params.adapter.whoami();

  for (const ticketId of trackedIds) {
    if (queueSet.has(ticketId)) continue;
    const commentId = commentsByTicket[ticketId]?.commentId;
    if (!commentId) {
      delete commentsByTicket[ticketId];
      continue;
    }
    if (params.dryRun) continue;
    try {
      await params.adapter.deleteComment(ticketId, commentId);
      delete commentsByTicket[ticketId];
      deleted += 1;
    } catch (error: any) {
      errors.push(`delete ${ticketId}/${commentId}: ${error?.message ?? String(error)}`);
    }
  }

  for (let index = 0; index < queueTicketIds.length; index++) {
    const ticketId = queueTicketIds[index]!;
    const higherPriorityCount = index + activeOffset;
    const desiredBody = renderQueueComment(higherPriorityCount, averageDurationMs);
    const entry = commentsByTicket[ticketId];

    if (entry?.commentId) {
      const needsTemplateUpgrade = Number(entry.templateVersion ?? 0) < QUEUE_COMMENT_TEMPLATE_VERSION;
      if (entry.higherPriorityCount === higherPriorityCount && !needsTemplateUpgrade) {
        unchanged += 1;
        continue;
      }

      if (params.dryRun) continue;
      try {
        await params.adapter.updateComment(ticketId, entry.commentId, desiredBody);
        commentsByTicket[ticketId] = {
          commentId: entry.commentId,
          higherPriorityCount,
          templateVersion: QUEUE_COMMENT_TEMPLATE_VERSION,
          lastSeenAt: new Date().toISOString(),
        };
        updated += 1;
      } catch (error: any) {
        errors.push(`update ${ticketId}/${entry.commentId}: ${error?.message ?? String(error)}`);
      }
      continue;
    }

    let existingComment:
      | {
          id: string;
          body: string;
          author?: { id?: string; username?: string; name?: string };
        }
      | undefined;
    try {
      const comments = await params.adapter.listComments(ticketId, {
        limit: 100,
        newestFirst: true,
        includeInternal: true,
      });
      existingComment = comments.find((comment) => isDispatcherOwnedComment(comment, me));
    } catch (error: any) {
      errors.push(`listComments ${ticketId}: ${error?.message ?? String(error)}`);
      continue;
    }

    if (existingComment) {
      if (normalizeText(existingComment.body) === normalizeText(desiredBody)) {
        commentsByTicket[ticketId] = {
          commentId: existingComment.id,
          higherPriorityCount,
          templateVersion: QUEUE_COMMENT_TEMPLATE_VERSION,
          lastSeenAt: new Date().toISOString(),
        };
        unchanged += 1;
        continue;
      }

      if (params.dryRun) continue;
      try {
        await params.adapter.updateComment(ticketId, existingComment.id, desiredBody);
        commentsByTicket[ticketId] = {
          commentId: existingComment.id,
          higherPriorityCount,
          templateVersion: QUEUE_COMMENT_TEMPLATE_VERSION,
          lastSeenAt: new Date().toISOString(),
        };
        updated += 1;
      } catch (error: any) {
        errors.push(`update-existing ${ticketId}/${existingComment.id}: ${error?.message ?? String(error)}`);
      }
      continue;
    }

    if (params.dryRun) continue;

    try {
      await params.adapter.addComment(ticketId, desiredBody);
      const comments = await params.adapter.listComments(ticketId, {
        limit: 25,
        newestFirst: true,
        includeInternal: true,
      });
      const createdComment = comments.find((comment) => isDispatcherOwnedComment(comment, me));
      if (!createdComment) {
        errors.push(`create ${ticketId}: comment created but marker lookup failed`);
        continue;
      }
      commentsByTicket[ticketId] = {
        commentId: createdComment.id,
        higherPriorityCount,
        templateVersion: QUEUE_COMMENT_TEMPLATE_VERSION,
        lastSeenAt: new Date().toISOString(),
      };
      created += 1;
    } catch (error: any) {
      errors.push(`create ${ticketId}: ${error?.message ?? String(error)}`);
    }
  }

  state.lastReconciledAt = new Date().toISOString();
  return {
    outcome: errors.length > 0 ? 'error' : params.dryRun ? 'skipped_dry_run' : 'applied',
    queuedTickets: queueTicketIds.length,
    activeOffset,
    created,
    updated,
    deleted,
    unchanged,
    errors,
  };
}

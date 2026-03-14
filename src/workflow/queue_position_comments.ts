import type { SessionMap } from '../automation/session_dispatcher.js';

const LEGACY_QUEUE_MARKER = '[kwf:queue-position]';
const QUEUE_COMMENT_TEMPLATE_VERSION = 3;
const DEFAULT_AVERAGE_DURATION_MS = 20 * 60 * 1000;

// Keep v2 constants for detection/cleanup.
const QUEUE_TEXT_PREFIX_V2 = 'There are ';
const QUEUE_TEXT_MIDDLE_V2 = ' tickets with higher priority that I need to complete (';
const QUEUE_TEXT_SUFFIX_V2 = ') before this ticket can be started. If this is urgent, change the priority.';

// v3 template: explicitly clarifies that no explicit handoff is needed.
const QUEUE_TEXT_PREFIX_V3 = 'There are ';
const QUEUE_TEXT_MIDDLE_V3 = ' tickets with higher priority that I need to complete (';
const QUEUE_TEXT_SUFFIX_V3 =
  ') before I start this ticket. No explicit handoff is needed, I will pick it up automatically when it reaches the top. If this is urgent, change the priority.';

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
  return `${QUEUE_TEXT_PREFIX_V3}${higherPriorityCount}${QUEUE_TEXT_MIDDLE_V3}${eta}${QUEUE_TEXT_SUFFIX_V3}`;
}

function renderQueueComment(higherPriorityCount: number, averageDurationMs: number): string {
  return messageForHigherPriorityCount(higherPriorityCount, averageDurationMs);
}

function normalizeText(text: string | undefined): string {
  return String(text ?? '')
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isQueueManagedComment(comment: { body: string; author?: { id?: string; username?: string; name?: string } }): boolean {
  const body = String(comment.body ?? '');
  const hasLegacyMarker = body.includes(LEGACY_QUEUE_MARKER);
  const normalized = normalizeText(body);
  const hasQueueTemplateV2 =
    normalized.startsWith(normalizeText(QUEUE_TEXT_PREFIX_V2)) &&
    normalized.includes(normalizeText(QUEUE_TEXT_MIDDLE_V2)) &&
    normalized.includes(normalizeText(QUEUE_TEXT_SUFFIX_V2));

  const hasQueueTemplateV3 =
    normalized.startsWith(normalizeText(QUEUE_TEXT_PREFIX_V3)) &&
    normalized.includes(normalizeText(QUEUE_TEXT_MIDDLE_V3)) &&
    normalized.includes(normalizeText(QUEUE_TEXT_SUFFIX_V3));

  return hasLegacyMarker || hasQueueTemplateV2 || hasQueueTemplateV3;
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
  for (const ticketId of trackedIds) {
    if (queueSet.has(ticketId)) continue;
    const trackedCommentId = commentsByTicket[ticketId]?.commentId;
    if (!trackedCommentId) {
      delete commentsByTicket[ticketId];
      continue;
    }
    if (params.dryRun) continue;
    try {
      const comments = await params.adapter.listComments(ticketId, {
        limit: 100,
        newestFirst: true,
        includeInternal: true,
      });
      const queueManaged = comments.filter((comment) => isQueueManagedComment(comment));
      const ids = queueManaged.length > 0 ? queueManaged.map((comment) => comment.id) : [trackedCommentId];
      for (const id of ids) {
        await params.adapter.deleteComment(ticketId, id);
        deleted += 1;
      }
      delete commentsByTicket[ticketId];
    } catch (error: any) {
      errors.push(`delete ${ticketId}/${trackedCommentId}: ${error?.message ?? String(error)}`);
    }
  }

  for (let index = 0; index < queueTicketIds.length; index++) {
    const ticketId = queueTicketIds[index]!;
    const higherPriorityCount = index + activeOffset;
    if (higherPriorityCount === 0) {
      const trackedCommentId = commentsByTicket[ticketId]?.commentId;
      if (trackedCommentId && !params.dryRun) {
        try {
          await params.adapter.deleteComment(ticketId, trackedCommentId);
          deleted += 1;
        } catch (error: any) {
          errors.push(`delete ${ticketId}/${trackedCommentId}: ${error?.message ?? String(error)}`);
        }
      }

      // Also clean up any queue-managed leftovers for this ticket (legacy or duplicates).
      if (!params.dryRun) {
        try {
          const comments = await params.adapter.listComments(ticketId, {
            limit: 100,
            newestFirst: true,
            includeInternal: true,
          });
          for (const comment of comments) {
            if (!isQueueManagedComment(comment)) continue;
            if (trackedCommentId && comment.id === trackedCommentId) continue;
            try {
              await params.adapter.deleteComment(ticketId, comment.id);
              deleted += 1;
            } catch (error: any) {
              errors.push(`delete-zero ${ticketId}/${comment.id}: ${error?.message ?? String(error)}`);
            }
          }
        } catch (error: any) {
          errors.push(`listComments-zero ${ticketId}: ${error?.message ?? String(error)}`);
        }
      }

      delete commentsByTicket[ticketId];
      continue;
    }

    const desiredBody = renderQueueComment(higherPriorityCount, averageDurationMs);
    const entry = commentsByTicket[ticketId];

    if (entry?.commentId) {
      let commentIdToUse = entry.commentId;
      let existingBody: string | undefined;
      try {
        const comments = await params.adapter.listComments(ticketId, {
          limit: 100,
          newestFirst: true,
          includeInternal: true,
        });
        const queueManaged = comments.filter((comment) => isQueueManagedComment(comment));
        if (queueManaged.length > 0) {
          const tracked = queueManaged.find((comment) => comment.id === entry.commentId);
          const chosen = tracked ?? queueManaged[0];
          if (chosen) {
            commentIdToUse = chosen.id;
            existingBody = chosen.body;
          }
          if (!params.dryRun) {
            for (const duplicate of queueManaged) {
              if (duplicate.id === commentIdToUse) continue;
              try {
                await params.adapter.deleteComment(ticketId, duplicate.id);
                deleted += 1;
              } catch (error: any) {
                errors.push(`delete-duplicate ${ticketId}/${duplicate.id}: ${error?.message ?? String(error)}`);
              }
            }
          }
        }
      } catch (error: any) {
        errors.push(`listComments ${ticketId}: ${error?.message ?? String(error)}`);
      }

      const needsTemplateUpgrade = Number(entry.templateVersion ?? 0) < QUEUE_COMMENT_TEMPLATE_VERSION;
      const bodyMatches = normalizeText(existingBody) === normalizeText(desiredBody);
      if (entry.higherPriorityCount === higherPriorityCount && !needsTemplateUpgrade && bodyMatches) {
        commentsByTicket[ticketId] = {
          commentId: commentIdToUse,
          higherPriorityCount,
          templateVersion: QUEUE_COMMENT_TEMPLATE_VERSION,
          lastSeenAt: new Date().toISOString(),
        };
        unchanged += 1;
        continue;
      }

      if (params.dryRun) continue;
      try {
        await params.adapter.updateComment(ticketId, commentIdToUse, desiredBody);
        commentsByTicket[ticketId] = {
          commentId: commentIdToUse,
          higherPriorityCount,
          templateVersion: QUEUE_COMMENT_TEMPLATE_VERSION,
          lastSeenAt: new Date().toISOString(),
        };
        updated += 1;
      } catch (error: any) {
        errors.push(`update ${ticketId}/${commentIdToUse}: ${error?.message ?? String(error)}`);
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
    let duplicateComments: Array<{ id: string }> = [];
    try {
      const comments = await params.adapter.listComments(ticketId, {
        limit: 100,
        newestFirst: true,
        includeInternal: true,
      });
      const queueManagedComments = comments.filter((comment) => isQueueManagedComment(comment));
      if (queueManagedComments.length > 0) {
        existingComment = queueManagedComments[0];
        duplicateComments = queueManagedComments.slice(1).map((comment) => ({ id: comment.id }));
      }
    } catch (error: any) {
      errors.push(`listComments ${ticketId}: ${error?.message ?? String(error)}`);
      continue;
    }

    if (!params.dryRun && duplicateComments.length > 0) {
      for (const duplicate of duplicateComments) {
        try {
          await params.adapter.deleteComment(ticketId, duplicate.id);
          deleted += 1;
        } catch (error: any) {
          errors.push(`delete-duplicate ${ticketId}/${duplicate.id}: ${error?.message ?? String(error)}`);
        }
      }
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
      const createdComment = comments.find((comment) => isQueueManagedComment(comment));
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

import {
  loadSessionMap,
  saveSessionMap,
  type SessionMap,
} from '../automation/session_dispatcher.js';
import { runAutoReopenForTicket } from '../automation/auto_reopen.js';
import type { StageKey } from '../stage.js';

export type HumanCommentReconcileResult =
  | {
      quiet: true;
      exitCode: number;
      reason: 'not_reopenable_stage' | 'no_action';
    }
  | {
      quiet: false;
      exitCode: number;
      payload: {
        humanCommentReconcile: {
          ticketId: string;
          commentId?: string;
          fromStage: 'stage:blocked' | 'stage:in-review';
          actions: Array<{
            ticketId: string;
            fromStage: 'stage:blocked' | 'stage:in-review';
            toStage: StageKey;
            triggerCommentId: string;
          }>;
          mapPath: string;
        };
      };
    };

type ReconcileAdapter = {
  getWorkItem(id: string): Promise<{ stage: StageKey }>;
  whoami(): Promise<{ id?: string; username?: string; name?: string }>;
  listComments(
    id: string,
    opts: { limit: number; newestFirst: boolean; includeInternal: boolean },
  ): Promise<Array<{ id: string; body?: string; createdAt?: Date; author?: { id?: string; username?: string; name?: string } }>>;
  setStage(id: string, stage: StageKey): Promise<void>;
};

async function resolveFromStage(
  adapter: ReconcileAdapter,
  ticketId: string,
): Promise<'stage:blocked' | 'stage:in-review' | null> {
  const item = await adapter.getWorkItem(ticketId);
  if (item.stage === 'stage:blocked' || item.stage === 'stage:in-review') {
    return item.stage;
  }
  return null;
}

function cloneMap(map: SessionMap): SessionMap {
  return JSON.parse(JSON.stringify(map)) as SessionMap;
}

export async function runHumanCommentReconciler(params: {
  adapter: ReconcileAdapter;
  ticketId: string;
  commentId?: string;
  requeueTargetStage?: StageKey;
  mapPath?: string;
  cursorPath?: string;
}): Promise<HumanCommentReconcileResult> {
  const fromStage = await resolveFromStage(params.adapter, params.ticketId);
  if (!fromStage) {
    return { quiet: true, exitCode: 0, reason: 'not_reopenable_stage' };
  }

  const previousMap = await loadSessionMap(params.mapPath);
  const map = cloneMap(previousMap);
  const reopened = await runAutoReopenForTicket({
    adapter: params.adapter,
    ticketId: params.ticketId,
    fromStage,
    map,
    expectedTriggerCommentId: params.commentId,
    requeueTargetStage: params.requeueTargetStage,
    cursorPath: params.cursorPath,
    persistMap: async (nextMap) => saveSessionMap(nextMap, params.mapPath),
  });

  if (reopened.actions.length === 0) {
    return { quiet: true, exitCode: 0, reason: 'no_action' };
  }
  return {
    quiet: false,
    exitCode: 0,
    payload: {
      humanCommentReconcile: {
        ticketId: params.ticketId,
        commentId: params.commentId,
        fromStage,
        actions: reopened.actions,
        mapPath: params.mapPath ?? '.tmp/kwf-session-map.json',
      },
    },
  };
}

import type { DispatchAction, SessionMap } from '../automation/session_dispatcher.js';
import type { StageKey } from '../stage.js';
import type { ExternalLinkInput, WorkItemDetails, WorkItemComment } from '../verbs/types.js';

export type WorkflowLoopTick =
  | { kind: 'started'; id: string; reasonCode?: string }
  | { kind: 'in_progress'; id: string; inProgressIds: string[] }
  | { kind: 'no_work'; reasonCode?: string }
  | { kind: 'blocked'; id: string }
  | { kind: 'completed'; id: string };

export type WorkflowLoopSelectionOutput = {
  tick: WorkflowLoopTick;
  nextTicket?: {
    adapter?: string;
    item?: Partial<WorkItemDetails> & { id: string };
    comments?: WorkItemComment[];
    potentialDuplicates?: Array<{
      id?: string;
      identifier?: string;
      title?: string;
      url?: string;
      stage?: string;
      score?: number;
    }>;
  };
  autoReopen?: { actions: Array<{ ticketId: string; toStage: string; triggerCommentId: string }> };
  dryRun: boolean;
};

export type WorkflowLifecycleAdapter = {
  addComment(id: string, body: string): Promise<void>;
  setStage(id: string, stage: string): Promise<void>;
  addLinks?(id: string, links: ExternalLinkInput[]): Promise<void>;
  getStakeholderMentions?(ticketId: string): Promise<string[]>;
  listComments?(
    id: string,
    opts: { limit?: number; newestFirst: boolean; includeInternal: boolean },
  ): Promise<WorkItemComment[]>;
};

export type WorkflowHousekeepingAdapter = {
  listBacklogIdsInOrder(): Promise<string[]>;
  listComments(
    id: string,
    opts: { limit: number; newestFirst: boolean; includeInternal: boolean },
  ): Promise<Array<{ id: string; body: string; author?: { id?: string; username?: string; name?: string } }>>;
  addComment(id: string, body: string): Promise<void>;
  updateComment(id: string, commentId: string, body: string): Promise<void>;
  deleteComment(id: string, commentId: string): Promise<void>;
};

export type WorkflowLoopSelectionAdapter = {
  name(): string;
  whoami(): Promise<{ id?: string; username?: string; name?: string }>;
  listOwnInProgressItems?(): Promise<Array<{ id: string; updatedAt?: Date }>>;
  listIdsByStage(stage: StageKey): Promise<string[]>;
  listBacklogIdsInOrder(): Promise<string[]>;
  listStageItems?(stage: StageKey): Promise<WorkItemDetails[]>;
  listBacklogItemsInOrder?(): Promise<WorkItemDetails[]>;
  getWorkItem(id: string): Promise<WorkItemDetails>;
  listComments(
    id: string,
    opts: { limit?: number; newestFirst: boolean; includeInternal: boolean },
  ): Promise<Array<{
    id: string;
    body: string;
    createdAt?: Date;
    author?: { id?: string; username?: string; name?: string };
  }>>;
  listAttachments(id: string): Promise<Array<unknown>>;
  listLinkedWorkItems(id: string): Promise<Array<unknown>>;
  setStage(id: string, stage: StageKey): Promise<void>;
};

export type WorkflowLoopControllerAdapter = WorkflowLifecycleAdapter & WorkflowHousekeepingAdapter;
export type WorkflowLoopAdapter = WorkflowLoopControllerAdapter & WorkflowLoopSelectionAdapter;

export type WorkflowLoopPlanView = {
  map: SessionMap;
  actions: DispatchAction[];
  activeTicketId: string | null;
};

export type WorkflowLoopPayload = {
  workflowLoop: {
    dryRun: boolean;
    dispatchRunId: string;
    actions: DispatchAction[];
    execution: Array<unknown>;
    noWorkAlert: unknown;
    queuePositionUpdate: unknown;
    rocketChatStatusUpdate: unknown;
    activeTicketId: string | null;
    mapPath: string;
  };
  autopilot: WorkflowLoopSelectionOutput;
};

export type WorkflowLoopTicketContext = {
  item?: WorkItemDetails;
  comments?: WorkItemComment[];
};

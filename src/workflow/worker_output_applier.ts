import {
  applyWorkerCommandToSessionMap,
  markSessionInProgress,
  type SessionEntry,
  type SessionMap,
  type WorkerCommandResult,
} from '../automation/session_dispatcher.js';
import { randomUUID } from 'node:crypto';
import type { ExternalLinkInput } from '../verbs/types.js';
import { buildRetryPrompt } from './ticket_runtime.js';
import {
  formatForcedBlockedComment,
  formatWorkerResultComment,
  validateWorkerResult,
} from './worker_result.js';
import {
  dispatchWorkerTurn,
  type WorkerRuntimeOptions,
} from './worker_runtime.js';
import type { WorkflowLifecycleAdapter } from './workflow_loop_ports.js';

export type WorkerExecutionOutcome = {
  sessionId: string;
  ticketId: string;
  parsed: WorkerCommandResult | null;
  workerOutput: string;
  outcome: 'applied' | 'mutation_error' | 'delegated_started';
  detail?: string;
};

type PersistMapFn = (map: SessionMap) => Promise<void>;

type WorkerMutationPlan = {
  parsed: WorkerCommandResult;
  decision: 'completed' | 'blocked';
  commentBody: string;
  targetStage: 'stage:in-review' | 'stage:blocked';
  links: ExternalLinkInput[];
  detail: string;
};

function buildSessionRoutingWarning(
  action: { sessionId: string; ticketId: string },
  routing?: { sessionKey?: string; sessionId?: string; agentSessionId?: string },
): string | null {
  const sessionKey = String(routing?.sessionKey ?? '').trim();
  if (!sessionKey) return null;

  const expectedSuffix = `:${action.sessionId}`;
  if (sessionKey.endsWith(expectedSuffix)) return null;

  return [
    'session_routing_mismatch',
    `ticketId=${action.ticketId}`,
    `requested_session_id=${action.sessionId}`,
    `effective_session_key=${sessionKey}`,
    routing?.sessionId ? `effective_session_id=${routing.sessionId}` : undefined,
    routing?.agentSessionId ? `agent_session_id=${routing.agentSessionId}` : undefined,
  ]
    .filter(Boolean)
    .join('; ');
}

function ensureSessionEntry(map: SessionMap, ticketId: string, sessionId: string): SessionEntry {
  if (!map.sessionsByTicket) {
    map.sessionsByTicket = {};
  }
  const nowIso = new Date().toISOString();
  const existing = map.sessionsByTicket[ticketId];
  if (existing) return existing;

  const created: SessionEntry = {
    sessionId,
    lastState: 'in_progress',
    lastSeenAt: nowIso,
    workStartedAt: nowIso,
  };
  map.sessionsByTicket[ticketId] = created;
  return created;
}

function updateTicketMemory(entry: SessionEntry, result: {
  decision: 'completed' | 'blocked' | 'uncertain';
  completed_steps?: string[];
  evidence?: string[];
  blocker_resolve_requests?: string[];
  clarification_questions?: string[];
  solution_summary?: string;
}): void {
  const openQuestions = result.decision === 'completed'
    ? []
    : result.decision === 'blocked'
      ? [...(result.blocker_resolve_requests ?? [])]
      : [...(result.clarification_questions ?? [])];
  const nextStepHint = openQuestions[0];
  const summary = result.decision === 'completed'
    ? String(result.solution_summary ?? '').trim()
    : (result.completed_steps ?? [])[0]?.trim()
      || nextStepHint
      || `Worker returned ${result.decision}.`;

  entry.ticketMemory = {
    updatedAt: new Date().toISOString(),
    lastDecision: result.decision,
    summary,
    completedSteps: [...(result.completed_steps ?? [])].slice(0, 5),
    evidence: [...(result.evidence ?? [])].slice(0, 5),
    openQuestions: openQuestions.slice(0, 5),
    nextStepHint: nextStepHint ? String(nextStepHint).trim() : undefined,
  };
}

function buildWorkerMutationPlan(params: {
  parsed: WorkerCommandResult;
  detail: string;
  workerLinks?: ExternalLinkInput[];
}): WorkerMutationPlan {
  if (params.parsed.kind === 'completed') {
    return {
      parsed: params.parsed,
      decision: 'completed',
      commentBody: params.parsed.result,
      targetStage: 'stage:in-review',
      links: params.workerLinks ?? [],
      detail: params.detail,
    };
  }

  return {
    parsed: params.parsed.kind === 'uncertain'
      ? { kind: 'blocked', text: params.parsed.text }
      : params.parsed,
    decision: 'blocked',
    commentBody: params.parsed.text,
    targetStage: 'stage:blocked',
    links: [],
    detail: params.detail,
  };
}

async function persistMapStep(persistMap: PersistMapFn | undefined, map: SessionMap): Promise<void> {
  if (!persistMap) return;
  await persistMap(map);
}

async function hasExistingCommentMatch(params: {
  adapter: WorkflowLifecycleAdapter;
  ticketId: string;
  commentBody: string;
}): Promise<boolean> {
  if (typeof params.adapter.listComments !== 'function') return false;
  try {
    const comments = await params.adapter.listComments(params.ticketId, {
      limit: 10,
      newestFirst: true,
      includeInternal: true,
    });
    return comments.some((comment) => String(comment.body ?? '').trim() === params.commentBody.trim());
  } catch {
    return false;
  }
}

export async function applyWorkerOutputToTicket(params: {
  adapter: WorkflowLifecycleAdapter;
  map: SessionMap;
  action: { sessionId: string; ticketId: string; projectId?: string };
  workerOutput: string;
  dispatchRunId: string;
  workerAgentId: string;
  workerRuntimeOptions: WorkerRuntimeOptions;
  detailPrefix?: string;
  routing?: { sessionKey?: string; sessionId?: string; agentSessionId?: string };
  onCompleted?(ticketId: string, completedAt: Date): void;
  persistMap?: PersistMapFn;
}): Promise<WorkerExecutionOutcome> {
  const {
    adapter,
    map,
    action,
    workerOutput,
    dispatchRunId,
    workerAgentId,
    workerRuntimeOptions,
    detailPrefix,
    routing,
    onCompleted,
    persistMap,
  } = params;

  let payload = workerOutput;
  let validation = validateWorkerResult(payload);
  let retryCount = 0;
  const routingWarning = buildSessionRoutingWarning(action, routing);
  if (routingWarning) {
    console.warn(`[kwf][warn] ${routingWarning}`);
  }

  while (!validation.ok && retryCount < 2) {
    retryCount += 1;
    const retry = await dispatchWorkerTurn({
      ticketId: action.ticketId,
      projectId: action.projectId,
      dispatchRunId,
      agentId: workerAgentId,
      sessionId: action.sessionId,
      text: buildRetryPrompt(validation.errors),
      thinking: 'low',
    }, workerRuntimeOptions);

    if (retry.kind === 'delegated') {
      const entry = ensureSessionEntry(map, action.ticketId, action.sessionId);
      entry.activeRun = {
        requestId: retry.requestId,
        runId: retry.runId,
        status: 'started',
        sentAt: retry.startedAt,
        waitTimeoutSeconds: retry.waitTimeoutSeconds,
        sessionKey: retry.sessionKey,
      };
      markSessionInProgress(map, action.ticketId, new Date());
      await persistMapStep(persistMap, map);
      return {
        sessionId: action.sessionId,
        ticketId: action.ticketId,
        parsed: null,
        workerOutput: retry.notice,
        outcome: 'delegated_started',
        detail: routingWarning
          ? `source=retry-request; ticket_notified=false; ${routingWarning}`
          : 'source=retry-request; ticket_notified=false',
      };
    }

    payload = retry.workerOutput;
    validation = validateWorkerResult(payload);
  }

  let parsed: WorkerCommandResult;
  let detail: string;

  if (!validation.ok) {
    const fallbackText = formatForcedBlockedComment(validation.errors);
    parsed = { kind: 'blocked', text: fallbackText };
    detail = `decision=blocked; reason=validation_failed_after_retries; retryCount=${retryCount}; errors=${validation.errors.length}`;
  } else if (validation.value.decision === 'completed') {
    parsed = { kind: 'completed', result: formatWorkerResultComment(validation.value) };
    detail = `decision=completed; retryCount=${retryCount}`;
  } else if (validation.value.decision === 'uncertain') {
    parsed = { kind: 'uncertain', text: formatWorkerResultComment(validation.value) };
    detail = `decision=uncertain; retryCount=${retryCount}`;
  } else {
    parsed = { kind: 'blocked', text: formatWorkerResultComment(validation.value) };
    detail = `decision=blocked; retryCount=${retryCount}`;
  }

  const workerLinks = validation.ok ? validation.value.links : [];

  try {
    let effectiveParsed = parsed;
    let effectiveCommentBody: string;
    let mentionSuffix = '';
    if (typeof adapter.getStakeholderMentions === 'function') {
      const mentions: string[] = await adapter.getStakeholderMentions(action.ticketId);
      if (mentions.length > 0) {
        if (parsed.kind === 'completed') {
          mentionSuffix = `\n\ncc ${mentions.join(' ')} - ready for review.`;
        } else {
          const verb = parsed.kind === 'blocked' ? 'blocked, needs input' : 'needs clarification';
          mentionSuffix = `\n\ncc ${mentions.join(' ')} - ${verb}.`;
        }
      }
    }

    if (mentionSuffix) {
      if (parsed.kind === 'completed') {
        effectiveParsed = { kind: 'completed', result: `${parsed.result}${mentionSuffix}` };
      } else {
        effectiveParsed = { kind: parsed.kind, text: `${parsed.text}${mentionSuffix}` };
      }
    }

    const mutationPlan = buildWorkerMutationPlan({
      parsed: effectiveParsed,
      detail,
      workerLinks,
    });
    effectiveCommentBody = mutationPlan.commentBody;

    const entry = ensureSessionEntry(map, action.ticketId, action.sessionId);
    delete entry.activeRun;
    if (validation.ok) {
      updateTicketMemory(entry, validation.value);
    }
    const pending = entry.pendingMutation;
    const reusePending = pending
      && pending.kind === 'worker_result'
      && pending.decision === mutationPlan.decision
      && pending.commentBody === mutationPlan.commentBody
      && pending.targetStage === mutationPlan.targetStage;

    if (!reusePending) {
      entry.pendingMutation = {
        kind: 'worker_result',
        operationId: randomUUID(),
        decision: mutationPlan.decision,
        commentBody: mutationPlan.commentBody,
        targetStage: mutationPlan.targetStage,
        links: mutationPlan.links,
        createdAt: new Date().toISOString(),
      };
      await persistMapStep(persistMap, map);
    }

    const currentPending = entry.pendingMutation;
    if (!currentPending || currentPending.kind !== 'worker_result') {
      throw new Error('worker result mutation missing after persistence');
    }
    if (!currentPending.commentAppliedAt) {
      const alreadyVisible = await hasExistingCommentMatch({
        adapter,
        ticketId: action.ticketId,
        commentBody: currentPending.commentBody,
      });
      if (!alreadyVisible) {
        await adapter.addComment(action.ticketId, currentPending.commentBody);
      }
      currentPending.commentAppliedAt = new Date().toISOString();
      await persistMapStep(persistMap, map);
    }

    if (!currentPending.stageAppliedAt) {
      await adapter.setStage(action.ticketId, currentPending.targetStage);
      currentPending.stageAppliedAt = new Date().toISOString();
      await persistMapStep(persistMap, map);
    }

    if (
      !currentPending.linksAppliedAt
      && Array.isArray(currentPending.links)
      && currentPending.links.length > 0
      && typeof adapter.addLinks === 'function'
    ) {
      await adapter.addLinks(action.ticketId, currentPending.links);
      currentPending.linksAppliedAt = new Date().toISOString();
      await persistMapStep(persistMap, map);
    }

    const appliedAt = new Date();
    if (mutationPlan.parsed.kind === 'completed') {
      onCompleted?.(action.ticketId, appliedAt);
    }
    applyWorkerCommandToSessionMap(map, action.ticketId, mutationPlan.parsed, appliedAt);
    await persistMapStep(persistMap, map);
    return {
      sessionId: action.sessionId,
      ticketId: action.ticketId,
      parsed: mutationPlan.parsed,
      workerOutput: payload,
      outcome: 'applied',
      detail: [detailPrefix, mutationPlan.detail, routingWarning].filter(Boolean).join('; '),
    };
  } catch (err: any) {
    const execution: WorkerExecutionOutcome = {
      sessionId: action.sessionId,
      ticketId: action.ticketId,
      parsed,
      workerOutput: payload,
      outcome: 'mutation_error',
      detail: err?.message ?? String(err),
    };
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { execution });
  }
}

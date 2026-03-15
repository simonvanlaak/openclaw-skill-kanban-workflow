import {
  applyWorkerCommandToSessionMap,
  markSessionInProgress,
  type SessionMap,
  type WorkerCommandResult,
} from '../automation/session_dispatcher.js';
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
import { ask, setStage, update } from '../verbs/verbs.js';

export type WorkerExecutionOutcome = {
  sessionId: string;
  ticketId: string;
  parsed: WorkerCommandResult | null;
  workerOutput: string;
  outcome: 'applied' | 'mutation_error' | 'delegated_started';
  detail?: string;
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

export async function applyWorkerOutputToTicket(params: {
  adapter: any;
  map: SessionMap;
  action: { sessionId: string; ticketId: string; projectId?: string };
  workerOutput: string;
  dispatchRunId: string;
  workerAgentId: string;
  workerRuntimeOptions: WorkerRuntimeOptions;
  detailPrefix?: string;
  routing?: { sessionKey?: string; sessionId?: string; agentSessionId?: string };
  onCompleted?(ticketId: string, completedAt: Date): void;
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
      markSessionInProgress(map, action.ticketId, new Date());
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

  const workerLinks = validation.ok ? validation.value.links : undefined;

  try {
    if (parsed.kind === 'completed') {
      let commentText = parsed.result;
      if (typeof adapter.getStakeholderMentions === 'function') {
        const mentions: string[] = await adapter.getStakeholderMentions(action.ticketId);
        if (mentions.length > 0) {
          commentText += `\n\ncc ${mentions.join(' ')} - ready for review.`;
        }
      }
      await update(adapter, action.ticketId, commentText);
      await setStage(adapter, action.ticketId, 'stage:in-review');
    } else {
      let askText = parsed.text;
      if (typeof adapter.getStakeholderMentions === 'function') {
        const mentions: string[] = await adapter.getStakeholderMentions(action.ticketId);
        if (mentions.length > 0) {
          const verb = parsed.kind === 'blocked' ? 'blocked, needs input' : 'needs clarification';
          askText += `\n\ncc ${mentions.join(' ')} - ${verb}.`;
        }
      }
      await ask(adapter, action.ticketId, askText);
    }

    if (Array.isArray(workerLinks) && workerLinks.length > 0 && typeof adapter.addLinks === 'function') {
      await adapter.addLinks(action.ticketId, workerLinks);
    }

    const appliedAt = new Date();
    if (parsed.kind === 'completed') {
      onCompleted?.(action.ticketId, appliedAt);
    }
    applyWorkerCommandToSessionMap(map, action.ticketId, parsed, appliedAt);
    return {
      sessionId: action.sessionId,
      ticketId: action.ticketId,
      parsed,
      workerOutput: payload,
      outcome: 'applied',
      detail: [detailPrefix, detail, routingWarning].filter(Boolean).join('; '),
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

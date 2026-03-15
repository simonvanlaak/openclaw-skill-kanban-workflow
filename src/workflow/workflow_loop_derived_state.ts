import type { SessionMap } from '../automation/session_dispatcher.js';
import { currentActiveSession } from './workflow_state.js';
import type { WorkflowLoopSelectionOutput } from './workflow_loop_ports.js';

export type WorkflowLoopDerivedState = {
  tickKind?: string;
  reasonCode?: string;
  activeTicketId: string | null;
  activeTitle?: string;
  activeIdentifier?: string;
  activeSessionId?: string;
  activeSessionLabel?: string;
};

export function deriveWorkflowLoopState(params: {
  output: WorkflowLoopSelectionOutput;
  map: SessionMap;
}): WorkflowLoopDerivedState {
  const tick = params.output?.tick;
  const tickKind = typeof tick?.kind === 'string' ? tick.kind : undefined;
  const reasonCode =
    tick && 'reasonCode' in tick && typeof tick.reasonCode === 'string'
      ? tick.reasonCode
      : undefined;

  const activeTicketId = typeof params.output?.nextTicket?.item?.id === 'string'
    ? params.output.nextTicket.item.id
    : null;

  const activeTitle = typeof params.output?.nextTicket?.item?.title === 'string'
    ? params.output.nextTicket.item.title
    : undefined;

  const activeIdentifier = typeof params.output?.nextTicket?.item?.identifier === 'string'
    ? params.output.nextTicket.item.identifier
    : undefined;

  const active = currentActiveSession(params.map);
  const activeSessionId = activeTicketId && active?.ticketId === activeTicketId
    ? active.sessionId
    : activeTicketId
      ? params.map.sessionsByTicket?.[activeTicketId]?.sessionId
      : undefined;

  const activeSessionLabel = activeTicketId
    ? params.map.sessionsByTicket?.[activeTicketId]?.sessionLabel
    : undefined;

  return {
    tickKind,
    reasonCode,
    activeTicketId,
    activeTitle,
    activeIdentifier,
    activeSessionId,
    activeSessionLabel,
  };
}

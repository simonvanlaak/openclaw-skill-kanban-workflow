import { describe, expect, it } from 'vitest';

import { deriveWorkflowLoopState } from '../src/workflow/workflow_loop_derived_state.js';

describe('workflow_loop_derived_state', () => {
  it('derives active ticket and session metadata from output plus map', () => {
    const derived = deriveWorkflowLoopState({
      output: {
        tick: { kind: 'in_progress', id: 'A1', inProgressIds: ['A1'] },
        nextTicket: {
          adapter: 'plane',
          item: {
            id: 'A1',
            title: 'Current work',
            identifier: 'JULES-1',
          },
          comments: [],
        },
        dryRun: false,
      },
      map: {
        version: 1,
        active: { ticketId: 'A1', sessionId: 'a1' },
        sessionsByTicket: {
          A1: {
            sessionId: 'a1',
            sessionLabel: 'JULES-1 Current work',
            lastState: 'in_progress',
            lastSeenAt: '2026-03-15T16:00:00.000Z',
          },
        },
      },
    });

    expect(derived).toEqual({
      tickKind: 'in_progress',
      reasonCode: undefined,
      activeTicketId: 'A1',
      activeTitle: 'Current work',
      activeIdentifier: 'JULES-1',
      activeSessionId: 'a1',
      activeSessionLabel: 'JULES-1 Current work',
    });
  });
});

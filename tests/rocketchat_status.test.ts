import { describe, expect, it } from 'vitest';

import type { SessionMap } from '../src/automation/session_dispatcher.js';
import { maybeUpdateRocketChatStatusFromWorkflowLoop } from '../src/workflow/rocketchat_status.js';

function baseMap(): SessionMap {
  return {
    version: 1,
    sessionsByTicket: {},
  };
}

describe('rocketchat status formatting', () => {
  it('prefers human-readable issue key from session id over opaque ticket id', async () => {
    const map = baseMap();
    map.active = { ticketId: 'a4a5f975-c2fb-4c6b-b6a6-152e13285e98', sessionId: 'jules-165' };
    map.sessionsByTicket['a4a5f975-c2fb-4c6b-b6a6-152e13285e98'] = {
      sessionId: 'jules-165',
      sessionLabel: 'a4a5f975-c2fb-4c6b-b6a6-152e13285e98 Clean up plane project states',
      lastState: 'in_progress',
      lastSeenAt: '2026-03-04T00:00:00.000Z',
    };

    const out = await maybeUpdateRocketChatStatusFromWorkflowLoop({
      output: {
        tick: { kind: 'in_progress', id: 'a4a5f975-c2fb-4c6b-b6a6-152e13285e98', inProgressIds: ['a4a5f975-c2fb-4c6b-b6a6-152e13285e98'] },
        nextTicket: {
          item: {
            id: 'a4a5f975-c2fb-4c6b-b6a6-152e13285e98',
            title: 'Clean up plane project states and remove this legacy mapping path',
          },
        },
        dryRun: true,
      },
      previousMap: baseMap(),
      map,
      dryRun: true,
    });

    expect(out?.outcome).toBe('skipped_dry_run');
    expect(out?.desiredMessage).toContain('working on JULES-165:');
  });

  it('falls back to title-only when no human-readable issue key is available', async () => {
    const map = baseMap();
    map.active = { ticketId: 'a4a5f975-c2fb-4c6b-b6a6-152e13285e98', sessionId: 'a4a5f975-c2fb-4c6b-b6a6-152e13285e98' };
    map.sessionsByTicket['a4a5f975-c2fb-4c6b-b6a6-152e13285e98'] = {
      sessionId: 'a4a5f975-c2fb-4c6b-b6a6-152e13285e98',
      sessionLabel: 'a4a5f975-c2fb-4c6b-b6a6-152e13285e98 Clean up plane project states',
      lastState: 'in_progress',
      lastSeenAt: '2026-03-04T00:00:00.000Z',
    };

    const out = await maybeUpdateRocketChatStatusFromWorkflowLoop({
      output: {
        tick: { kind: 'in_progress', id: 'a4a5f975-c2fb-4c6b-b6a6-152e13285e98', inProgressIds: ['a4a5f975-c2fb-4c6b-b6a6-152e13285e98'] },
        nextTicket: {
          item: {
            id: 'a4a5f975-c2fb-4c6b-b6a6-152e13285e98',
            title: 'Clean up plane project states and remove this legacy mapping path',
          },
        },
        dryRun: true,
      },
      previousMap: baseMap(),
      map,
      dryRun: true,
    });

    expect(out?.outcome).toBe('skipped_dry_run');
    expect(out?.desiredMessage).toContain('working on Clean up plane project states');
    expect(out?.desiredMessage).not.toContain('a4a5f975-c2fb-4c6b-b6a6-152e13285e98');
  });

  it('prefers nextTicket.item.identifier for display id', async () => {
    const map = baseMap();
    map.active = { ticketId: 'a4a5f975-c2fb-4c6b-b6a6-152e13285e98', sessionId: 'a4a5f975-c2fb-4c6b-b6a6-152e13285e98' };
    map.sessionsByTicket['a4a5f975-c2fb-4c6b-b6a6-152e13285e98'] = {
      sessionId: 'a4a5f975-c2fb-4c6b-b6a6-152e13285e98',
      sessionLabel: 'a4a5f975-c2fb-4c6b-b6a6-152e13285e98 Cleanup title',
      lastState: 'in_progress',
      lastSeenAt: '2026-03-04T00:00:00.000Z',
    };

    const out = await maybeUpdateRocketChatStatusFromWorkflowLoop({
      output: {
        tick: { kind: 'in_progress', id: 'a4a5f975-c2fb-4c6b-b6a6-152e13285e98', inProgressIds: ['a4a5f975-c2fb-4c6b-b6a6-152e13285e98'] },
        nextTicket: {
          item: {
            id: 'a4a5f975-c2fb-4c6b-b6a6-152e13285e98',
            identifier: 'JULES-165',
            title: 'Clean up plane project states and remove this legacy mapping path',
          },
        },
        dryRun: true,
      },
      previousMap: baseMap(),
      map,
      dryRun: true,
    });

    expect(out?.outcome).toBe('skipped_dry_run');
    expect(out?.desiredMessage).toContain('working on JULES-165:');
  });
});

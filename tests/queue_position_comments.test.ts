import { describe, expect, it, vi } from 'vitest';

import type { SessionMap } from '../src/automation/session_dispatcher.js';
import { reconcileQueuePositionComments } from '../src/workflow/queue_position_comments.js';

function mapWithQueueState(): SessionMap {
  return {
    version: 1,
    sessionsByTicket: {},
    queuePosition: {
      commentsByTicket: {},
    },
  };
}

describe('queue_position_comments', () => {
  it('creates queue comment entries for queued tickets', async () => {
    const commentStore = new Map<string, Array<{ id: string; body: string; author?: { id?: string } }>>();
    const addComment = vi.fn(async (ticketId: string, body: string) => {
      const arr = commentStore.get(ticketId) ?? [];
      arr.unshift({ id: `${ticketId}-c1`, body, author: { id: 'me' } });
      commentStore.set(ticketId, arr);
    });

    const map = mapWithQueueState();
    map.active = { ticketId: 'ACTIVE-1', sessionId: 'active-1' };
    const result = await reconcileQueuePositionComments({
      adapter: {
        listBacklogIdsInOrder: async () => ['T-1', 'T-2'],
        listComments: async (id: string) => commentStore.get(id) ?? [],
        addComment,
        updateComment: vi.fn(async () => undefined),
        deleteComment: vi.fn(async () => undefined),
      },
      map,
      dryRun: false,
    });

    expect(result.outcome).toBe('applied');
    expect(result.created).toBe(2);
    expect(addComment).toHaveBeenCalledTimes(2);
    expect(addComment.mock.calls[0]?.[1]).not.toContain('[kwf:queue-position]');
    expect(addComment.mock.calls[0]?.[1]).toContain('There are 1 tickets with higher priority that I need to complete (<1h)');
    expect(addComment.mock.calls[0]?.[1]).toContain('No explicit handoff is needed');
    expect(addComment.mock.calls[1]?.[1]).toContain('There are 2 tickets with higher priority that I need to complete (<1h)');
    expect(addComment.mock.calls[1]?.[1]).toContain('No explicit handoff is needed');
    expect(map.queuePosition?.commentsByTicket['T-1']?.commentId).toBe('T-1-c1');
    expect(map.queuePosition?.commentsByTicket['T-2']?.commentId).toBe('T-2-c1');
  });

  it('updates existing comment when queue number changes and deletes when ticket leaves queue', async () => {
    const updateComment = vi.fn(async () => undefined);
    const deleteComment = vi.fn(async () => undefined);

    const map = mapWithQueueState();
    map.active = { ticketId: 'ACTIVE-1', sessionId: 'active-1' };
    map.queuePosition!.commentsByTicket = {
      OLD: { commentId: 'old-c', higherPriorityCount: 5 },
      T2: { commentId: 't2-c', higherPriorityCount: 4 },
    };

    const result = await reconcileQueuePositionComments({
      adapter: {
        listBacklogIdsInOrder: async () => ['T2'],
        listComments: async () => [],
        addComment: vi.fn(async () => undefined),
        updateComment,
        deleteComment,
      },
      map,
      dryRun: false,
    });

    expect(result.deleted).toBe(1);
    expect(result.updated).toBe(1);
    expect(deleteComment).toHaveBeenCalledWith('OLD', 'old-c');
    expect(updateComment).toHaveBeenCalledWith(
      'T2',
      't2-c',
      expect.stringContaining('There are 1 tickets with higher priority that I need to complete (<1h)'),
    );
    expect(map.queuePosition?.commentsByTicket.OLD).toBeUndefined();
  });

  it('does not mutate comments in dry-run mode', async () => {
    const map = mapWithQueueState();

    const addComment = vi.fn(async () => undefined);
    const updateComment = vi.fn(async () => undefined);
    const deleteComment = vi.fn(async () => undefined);

    const result = await reconcileQueuePositionComments({
      adapter: {
        listBacklogIdsInOrder: async () => ['T1'],
        listComments: async () => [],
        addComment,
        updateComment,
        deleteComment,
      },
      map,
      dryRun: true,
    });

    expect(result.outcome).toBe('skipped_dry_run');
    expect(addComment).not.toHaveBeenCalled();
    expect(updateComment).not.toHaveBeenCalled();
    expect(deleteComment).not.toHaveBeenCalled();
  });

  it('upgrades legacy marker comment format even when queue number stays the same', async () => {
    const updateComment = vi.fn(async () => undefined);
    const map = mapWithQueueState();
    map.active = { ticketId: 'ACTIVE-1', sessionId: 'active-1' };
    map.queuePosition!.commentsByTicket = {
      T1: { commentId: 't1-c', higherPriorityCount: 1 },
    };

    const result = await reconcileQueuePositionComments({
      adapter: {
        listBacklogIdsInOrder: async () => ['T1'],
        listComments: async () => [],
        addComment: vi.fn(async () => undefined),
        updateComment,
        deleteComment: vi.fn(async () => undefined),
      },
      map,
      dryRun: false,
    });

    expect(result.updated).toBe(1);
    expect(updateComment).toHaveBeenCalledWith(
      'T1',
      't1-c',
      expect.not.stringContaining('[kwf:queue-position]'),
    );
    expect(map.queuePosition?.commentsByTicket.T1?.templateVersion).toBe(3);
  });

  it('uses rolling average of last 3 completion durations for ETA', async () => {
    const addComment = vi.fn(async () => undefined);
    const map = mapWithQueueState();
    map.active = { ticketId: 'ACTIVE-1', sessionId: 'active-1' };
    map.queuePosition!.recentCompletionDurationsMs = [
      2 * 60 * 60 * 1000,
      2 * 60 * 60 * 1000,
      2 * 60 * 60 * 1000,
    ];

    await reconcileQueuePositionComments({
      adapter: {
        listBacklogIdsInOrder: async () => ['T-1'],
        listComments: async () => [],
        addComment,
        updateComment: vi.fn(async () => undefined),
        deleteComment: vi.fn(async () => undefined),
      },
      map,
      dryRun: false,
    });

    expect(addComment).toHaveBeenCalledWith(
      'T-1',
      expect.stringContaining('There are 1 tickets with higher priority that I need to complete (<4h)'),
    );
  });

  it('updates newest queue comment and deletes duplicate queue comments', async () => {
    const updateComment = vi.fn(async () => undefined);
    const deleteComment = vi.fn(async () => undefined);

    const map = mapWithQueueState();
    map.active = { ticketId: 'ACTIVE-1', sessionId: 'active-1' };
    const ticketId = 'T-1';
    const comments = [
      {
        id: 'newest',
        body: 'There are 1 tickets with higher priority that I need to complete (<1h) before this ticket can be started. If this is urgent, change the priority.',
      },
      {
        id: 'older',
        body: 'There are 2 tickets with higher priority that I need to complete (<1h) before this ticket can be started. If this is urgent, change the priority.',
      },
    ];

    const result = await reconcileQueuePositionComments({
      adapter: {
        listBacklogIdsInOrder: async () => [ticketId],
        listComments: async () => comments,
        addComment: vi.fn(async () => undefined),
        updateComment,
        deleteComment,
      },
      map,
      dryRun: false,
    });

    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.deleted).toBe(1);
    expect(updateComment).toHaveBeenCalledTimes(1);
    expect(deleteComment).toHaveBeenCalledWith(ticketId, 'older');
    expect(map.queuePosition?.commentsByTicket[ticketId]?.commentId).toBe('newest');
  });

  it('does not keep queue comment for next ticket with zero higher-priority items', async () => {
    const addComment = vi.fn(async () => undefined);
    const deleteComment = vi.fn(async () => undefined);
    const ticketId = 'T-1';
    const map = mapWithQueueState();
    map.queuePosition!.commentsByTicket[ticketId] = { commentId: 'tracked-c', higherPriorityCount: 1 };

    const result = await reconcileQueuePositionComments({
      adapter: {
        listBacklogIdsInOrder: async () => [ticketId],
        listComments: async () => [
          {
            id: 'tracked-c',
            body: 'There are 1 tickets with higher priority that I need to complete (<1h) before this ticket can be started. If this is urgent, change the priority.',
          },
        ],
        addComment,
        updateComment: vi.fn(async () => undefined),
        deleteComment,
      },
      map,
      dryRun: false,
    });

    expect(result.created).toBe(0);
    expect(addComment).not.toHaveBeenCalled();
    expect(deleteComment).toHaveBeenCalledWith(ticketId, 'tracked-c');
    expect(map.queuePosition?.commentsByTicket[ticketId]).toBeUndefined();
  });

  it('deletes duplicate queue comments even when tracked comment id exists', async () => {
    const updateComment = vi.fn(async () => undefined);
    const deleteComment = vi.fn(async () => undefined);
    const ticketId = 'T-1';
    const map = mapWithQueueState();
    map.active = { ticketId: 'ACTIVE-1', sessionId: 'active-1' };
    map.queuePosition!.commentsByTicket[ticketId] = {
      commentId: 'tracked',
      higherPriorityCount: 1,
      templateVersion: 2,
    };

    const result = await reconcileQueuePositionComments({
      adapter: {
        listBacklogIdsInOrder: async () => [ticketId],
        listComments: async () => [
          {
            id: 'tracked',
            body: 'There are 1 tickets with higher priority that I need to complete (<1h) before this ticket can be started. If this is urgent, change the priority.',
          },
          {
            id: 'duplicate-old',
            body: 'There are 0 tickets with higher priority that I need to complete (<1h) before this ticket can be started. If this is urgent, change the priority.',
          },
        ],
        addComment: vi.fn(async () => undefined),
        updateComment,
        deleteComment,
      },
      map,
      dryRun: false,
    });

    expect(result.deleted).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.unchanged).toBe(0);
    expect(deleteComment).toHaveBeenCalledWith(ticketId, 'duplicate-old');
    expect(updateComment).toHaveBeenCalledTimes(1);
  });

  it('reuses existing queue comment when body includes escaped newline artifacts', async () => {
    const addComment = vi.fn(async () => undefined);
    const updateComment = vi.fn(async () => undefined);
    const deleteComment = vi.fn(async () => undefined);
    const map = mapWithQueueState();
    map.active = { ticketId: 'ACTIVE-1', sessionId: 'active-1' };

    const result = await reconcileQueuePositionComments({
      adapter: {
        listBacklogIdsInOrder: async () => ['T-1'],
        listComments: async () => [
          {
            id: 'existing-c1',
            body: 'There are 1 tickets with higher priority that I need to complete (<1h) before this ticket can be started. If this is urgent, change the priority.\\n',
          },
        ],
        addComment,
        updateComment,
        deleteComment,
      },
      map,
      dryRun: false,
    });

    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.unchanged).toBe(0);
    expect(addComment).not.toHaveBeenCalled();
    expect(updateComment).toHaveBeenCalledTimes(1);
    expect(deleteComment).not.toHaveBeenCalled();
    expect(map.queuePosition?.commentsByTicket['T-1']?.commentId).toBe('existing-c1');
  });
});

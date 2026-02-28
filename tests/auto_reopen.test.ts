import * as fs from 'node:fs/promises';

import { describe, expect, test, vi } from 'vitest';

import { runAutoReopenOnHumanComment } from '../src/automation/auto_reopen.js';

function cursorPath(name: string): string {
  return `.tmp/${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

describe('auto-reopen on human comment', () => {
  test('moves blocked ticket back to backlog when a non-worker comment appears', async () => {
    const path = cursorPath('kwf-auto-reopen-blocked');
    const adapter = {
      whoami: vi.fn(async () => ({ username: 'kwf-bot' })),
      listIdsByStage: vi.fn(async (stage: string) => (stage === 'stage:blocked' ? ['BL-1'] : [])),
      listComments: vi.fn(async () => [
        {
          id: 'c-human-1',
          body: 'Can take this now.',
          author: { username: 'alice' },
          createdAt: new Date('2026-02-28T14:00:00Z'),
        },
      ]),
      setStage: vi.fn(async () => undefined),
    };

    const res = await runAutoReopenOnHumanComment({ adapter, cursorPath: path });

    expect(res.actions).toEqual([
      { ticketId: 'BL-1', fromStage: 'stage:blocked', toStage: 'stage:todo', triggerCommentId: 'c-human-1' },
    ]);
    expect(adapter.setStage).toHaveBeenCalledWith('BL-1', 'stage:todo');

    await fs.rm(path, { force: true });
  });

  test('moves in-review ticket back to backlog when a non-worker comment appears', async () => {
    const path = cursorPath('kwf-auto-reopen-in-review');
    const adapter = {
      whoami: vi.fn(async () => ({ id: 'kwf-user-1', username: 'kwf-bot' })),
      listIdsByStage: vi.fn(async (stage: string) => (stage === 'stage:in-review' ? ['RV-2'] : [])),
      listComments: vi.fn(async () => [
        {
          id: 'c-human-2',
          body: 'Please take another pass.',
          author: { id: 'human-2', username: 'pm-jane' },
          createdAt: new Date('2026-02-28T14:01:00Z'),
        },
      ]),
      setStage: vi.fn(async () => undefined),
    };

    const res = await runAutoReopenOnHumanComment({ adapter, cursorPath: path });

    expect(res.actions).toEqual([
      { ticketId: 'RV-2', fromStage: 'stage:in-review', toStage: 'stage:todo', triggerCommentId: 'c-human-2' },
    ]);
    expect(adapter.setStage).toHaveBeenCalledWith('RV-2', 'stage:todo');

    await fs.rm(path, { force: true });
  });

  test('does not reopen when newest unseen comment is from worker account', async () => {
    const path = cursorPath('kwf-auto-reopen-self');
    const adapter = {
      whoami: vi.fn(async () => ({ username: 'kwf-bot' })),
      listIdsByStage: vi.fn(async (stage: string) => (stage === 'stage:blocked' ? ['BL-3'] : [])),
      listComments: vi.fn(async () => [
        {
          id: 'c-self-1',
          body: 'Internal update',
          author: { username: 'kwf-bot' },
          createdAt: new Date('2026-02-28T14:03:00Z'),
        },
      ]),
      setStage: vi.fn(async () => undefined),
    };

    const res = await runAutoReopenOnHumanComment({ adapter, cursorPath: path });

    expect(res.actions).toEqual([]);
    expect(adapter.setStage).not.toHaveBeenCalled();

    await fs.rm(path, { force: true });
  });

  test('reopens when worker relays a human comment in body metadata', async () => {
    const path = cursorPath('kwf-auto-reopen-relayed-human');
    const adapter = {
      whoami: vi.fn(async () => ({ id: 'bot-1', username: 'kwf-bot', name: 'Jules Mercer' })),
      listIdsByStage: vi.fn(async (stage: string) => (stage === 'stage:in-review' ? ['RV-9'] : [])),
      listComments: vi.fn(async () => [
        {
          id: 'c-relay-1',
          body: '[planka-comment:123]\nAuthor: Simon van Laak\nCreated: 2026-02-28T14:01:00Z\n\nPlease revise this.',
          author: { id: 'bot-1', username: 'kwf-bot', name: 'Jules Mercer' },
          createdAt: new Date('2026-02-28T14:03:00Z'),
        },
      ]),
      setStage: vi.fn(async () => undefined),
    };

    const res = await runAutoReopenOnHumanComment({ adapter, cursorPath: path });

    expect(res.actions).toEqual([
      { ticketId: 'RV-9', fromStage: 'stage:in-review', toStage: 'stage:todo', triggerCommentId: 'c-relay-1' },
    ]);
    expect(adapter.setStage).toHaveBeenCalledWith('RV-9', 'stage:todo');

    await fs.rm(path, { force: true });
  });
});

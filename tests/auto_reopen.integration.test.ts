import * as fs from 'node:fs/promises';

import { describe, expect, test, vi } from 'vitest';

import { runAutoReopenOnHumanComment } from '../src/automation/auto_reopen.js';

function cursorPath(name: string): string {
  return `.tmp/${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

describe('auto-reopen integration (Plane live-output shapes)', () => {
  test('Blocked -> Backlog for relayed human comment shape', async () => {
    const path = cursorPath('kwf-auto-reopen-live-shape-blocked');
    await fs.writeFile(path, JSON.stringify({ version: 1, seenByTicket: { 'BL-live-1': 'a11e9f6a-3cd1-41ab-9a0d-7be00eb728cd' } }), 'utf8');

    const adapter = {
      whoami: vi.fn(async () => ({ id: 'c0fdab2d-5858-4ff6-b17e-05770f0776b6', username: 'jules@local', name: 'Jules Mercer' })),
      listIdsByStage: vi.fn(async (stage: string) => (stage === 'stage:blocked' ? ['BL-live-1'] : [])),
      listComments: vi.fn(async () => [
        {
          id: 'fd243389-4fd3-4f16-9548-2deda9f9b80a',
          body: '[planka-attachment:id:1719060716461229135 hash:37763af567eaec67] Attachment synced.',
          author: { id: 'c0fdab2d-5858-4ff6-b17e-05770f0776b6' },
        },
        {
          id: 'bed9feba-b154-4746-be8b-b5bf4a8e1ece',
          body:
            '[planka-comment:1719060571086652455]\nAuthor: Simon van Laak\nCreated (source): 2026-02-26T15:26:29.368Z\n\nI\'ve setup the plane implementation ticket.',
          author: { id: 'c0fdab2d-5858-4ff6-b17e-05770f0776b6' },
        },
        {
          id: 'a11e9f6a-3cd1-41ab-9a0d-7be00eb728cd',
          body: '[planka-comment]\nAuthor: Jules Mercer\nOlder bot relay.',
          author: { id: 'c0fdab2d-5858-4ff6-b17e-05770f0776b6' },
        },
      ]),
      setStage: vi.fn(async () => undefined),
    };

    const res = await runAutoReopenOnHumanComment({ adapter, cursorPath: path });
    expect(res.actions).toEqual([{ ticketId: 'BL-live-1', fromStage: 'stage:blocked', toStage: 'stage:todo', triggerCommentId: 'bed9feba-b154-4746-be8b-b5bf4a8e1ece' }]);
    expect(adapter.setStage).toHaveBeenCalledWith('BL-live-1', 'stage:todo');

    await fs.rm(path, { force: true });
  });

  test('InReview -> Backlog for relayed human comment shape', async () => {
    const path = cursorPath('kwf-auto-reopen-live-shape-review');
    await fs.writeFile(path, JSON.stringify({ version: 1, seenByTicket: { 'RV-live-2': '8ae7c9fc-73bd-4477-9230-e2075afe560f' } }), 'utf8');

    const adapter = {
      whoami: vi.fn(async () => ({ id: 'c0fdab2d-5858-4ff6-b17e-05770f0776b6', username: 'jules@local', name: 'Jules Mercer' })),
      listIdsByStage: vi.fn(async (stage: string) => (stage === 'stage:in-review' ? ['RV-live-2'] : [])),
      listComments: vi.fn(async () => [
        {
          id: '1d323a88-fd3f-410b-9636-c0f09bd4215c',
          body: '[planka-comment]\nAuthor: Jules Mercer\nWhat I changed...',
          author: { id: 'c0fdab2d-5858-4ff6-b17e-05770f0776b6' },
        },
        {
          id: '79133a6f-1b0f-4683-8c4c-1186364bceab',
          body: '[planka-comment]\nAuthor: Simon van Laak\nChange the dir path from /Jules Research/Jitsi Transcripts/ to just /Transcripts/',
          author: { id: 'c0fdab2d-5858-4ff6-b17e-05770f0776b6' },
        },
        {
          id: '8ae7c9fc-73bd-4477-9230-e2075afe560f',
          body: '[planka-comment]\nAuthor: Jules Mercer\nOlder update.',
          author: { id: 'c0fdab2d-5858-4ff6-b17e-05770f0776b6' },
        },
      ]),
      setStage: vi.fn(async () => undefined),
    };

    const res = await runAutoReopenOnHumanComment({ adapter, cursorPath: path });
    expect(res.actions).toEqual([{ ticketId: 'RV-live-2', fromStage: 'stage:in-review', toStage: 'stage:todo', triggerCommentId: '79133a6f-1b0f-4683-8c4c-1186364bceab' }]);
    expect(adapter.setStage).toHaveBeenCalledWith('RV-live-2', 'stage:todo');

    await fs.rm(path, { force: true });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => {
  return {
    execa: vi.fn(),
  };
});

import { execa } from 'execa';
import { PlaneAdapter } from '../src/adapters/plane.js';

type ExecaMock = typeof execa & {
  mockResolvedValueOnce: (value: unknown) => ExecaMock;
  mockReset: () => void;
};

describe('PlaneAdapter (multi-project)', () => {
  beforeEach(() => {
    (execa as any as ExecaMock).mockReset();
  });

  it('combines backlog order across projects (config order) and is assignee-only', async () => {
    (execa as any as ExecaMock)
      // whoami
      .mockResolvedValueOnce({ stdout: JSON.stringify({ id: 'me1' }) })
      // project A states
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { id: 'todo-a', name: 'stage:todo' },
        ]),
      })
      // project A issues list
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { id: 'A1', name: 'A1', state: { name: 'stage:todo' }, updated_at: '2026-02-26T00:00:00Z' },
        ]),
      })
      // project B states
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { id: 'todo-b', name: 'stage:todo' },
        ]),
      })
      // project B issues list
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { id: 'B1', name: 'B1', state: { name: 'stage:todo' }, updated_at: '2026-02-26T00:00:01Z' },
        ]),
      });

    const adapter = new PlaneAdapter({
      workspaceSlug: 'ws',
      projectIds: ['projA', 'projB'],
      stageMap: {
        'stage:todo': 'stage:todo',
        'stage:blocked': 'stage:blocked',
        'stage:in-progress': 'stage:in-progress',
        'stage:in-review': 'stage:in-review',
      },
    });

    const ids = await adapter.listBacklogIdsInOrder();

    expect(execa).toHaveBeenNthCalledWith(
      2,
      'plane',
      ['-f', 'json', 'states', '-p', 'projA'],
      expect.objectContaining({
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    );

    expect(execa).toHaveBeenNthCalledWith(
      3,
      'plane',
      ['issues', 'list', '-p', 'projA', '--state', 'todo-a', '--assignee', 'me1', '-f', 'json'],
      expect.objectContaining({
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    );

    expect(execa).toHaveBeenNthCalledWith(
      4,
      'plane',
      ['-f', 'json', 'states', '-p', 'projB'],
      expect.objectContaining({
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    );

    expect(execa).toHaveBeenNthCalledWith(
      5,
      'plane',
      ['issues', 'list', '-p', 'projB', '--state', 'todo-b', '--assignee', 'me1', '-f', 'json'],
      expect.objectContaining({
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    );

    // config order, not updatedAt across projects.
    expect(ids).toEqual(['A1', 'B1']);
  });

  it('listIdsByStage reads from all configured projects (assignee-only gating)', async () => {
    (execa as any as ExecaMock)
      // whoami
      .mockResolvedValueOnce({ stdout: JSON.stringify({ id: 'me1' }) })
      // project A states
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { id: 'blocked-a', name: 'Blocked' },
        ]),
      })
      // project A issues list (assignee-filtered)
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { id: 'A1', name: 'A1', state: { name: 'Blocked' }, updated_at: '2026-02-26T00:00:00Z' },
        ]),
      })
      // project B states
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { id: 'blocked-b', name: 'Blocked' },
        ]),
      })
      // project B issues list (assignee-filtered)
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { id: 'B1', name: 'B1', state: { name: 'Blocked' }, updated_at: '2026-02-26T00:00:01Z' },
        ]),
      });

    const adapter = new PlaneAdapter({
      workspaceSlug: 'ws',
      projectIds: ['projA', 'projB'],
      stageMap: {
        Blocked: 'stage:blocked',
        Todo: 'stage:todo',
        Doing: 'stage:in-progress',
        Review: 'stage:in-review',
      },
    });

    const ids = await adapter.listIdsByStage('stage:blocked');

    expect(execa).toHaveBeenNthCalledWith(
      2,
      'plane',
      ['-f', 'json', 'states', '-p', 'projA'],
      expect.objectContaining({
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    );
    expect(execa).toHaveBeenNthCalledWith(
      3,
      'plane',
      ['issues', 'list', '-p', 'projA', '--state', 'blocked-a', '--assignee', 'me1', '-f', 'json'],
      expect.objectContaining({
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    );
    expect(execa).toHaveBeenNthCalledWith(
      4,
      'plane',
      ['-f', 'json', 'states', '-p', 'projB'],
      expect.objectContaining({
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    );
    expect(execa).toHaveBeenNthCalledWith(
      5,
      'plane',
      ['issues', 'list', '-p', 'projB', '--state', 'blocked-b', '--assignee', 'me1', '-f', 'json'],
      expect.objectContaining({
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    );

    // oldest first
    expect(ids).toEqual(['A1', 'B1']);
  });
});

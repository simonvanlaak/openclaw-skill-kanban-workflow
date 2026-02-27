import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => {
  return {
    execa: vi.fn()
  };
});

import { execa } from 'execa';
import { PlaneAdapter } from '../src/adapters/plane.js';

type ExecaMock = typeof execa & {
  mockResolvedValueOnce: (value: unknown) => unknown;
  mockRejectedValueOnce: (value: unknown) => unknown;
  mockReset: () => unknown;
};

describe('PlaneAdapter', () => {
  beforeEach(() => {
    (execa as any as ExecaMock).mockReset();
  });

  // plane CLI supports -f json; keep this test around as a safety net
  // in case a wrapper uses --format json instead.
  it('supports overriding format args', async () => {
    (execa as any as ExecaMock).mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          id: 'i4',
          name: 'Override',
          state_detail: { name: 'Doing' }
        }
      ])
    });

    const adapter = new PlaneAdapter({
      workspaceSlug: 'ws',
      projectId: 'proj',
      bin: 'plane',
      formatArgs: ['--format', 'json'],
      stageMap: {
        Doing: 'stage:in-progress',
      },
    });

    const snap = await adapter.fetchSnapshot();

    expect((execa as any).mock.calls[0]?.[1]).toEqual(['--format', 'json', 'issues', 'list', '-p', 'proj']);
    expect(snap.get('i4')?.stage.toString()).toBe('stage:in-progress');
  });

  it('lists issues and maps state.name to canonical Stage', async () => {
    (execa as any as ExecaMock).mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          id: 'i1',
          name: 'No stage',
          state_detail: { name: 'Doing' }
        },
        {
          id: 'i2',
          name: 'Queued',
          url: 'https://plane.example/issues/i2',
          updated_at: '2026-02-26T08:31:00Z',
          state: { name: 'stage:backlog' },
          labels: [{ name: 'bug' }, { name: 'stage:backlog' }]
        }
      ])
    });

    const adapter = new PlaneAdapter({
      workspaceSlug: 'ws',
      projectId: 'proj',
      bin: 'plane',
      stageMap: {
        'stage:backlog': 'stage:backlog',
        'stage:blocked': 'stage:blocked',
        'stage:in-progress': 'stage:in-progress',
        'stage:in-review': 'stage:in-review',
      },
    });

    const snap = await adapter.fetchSnapshot();

    expect((execa as any).mock.calls[0]?.[0]).toBe('plane');
    expect((execa as any).mock.calls[0]?.[1]).toEqual(['-f', 'json', 'issues', 'list', '-p', 'proj']);

    expect(Array.from(snap.keys())).toEqual(['i2']);
    expect(snap.get('i2')?.stage.toString()).toBe('stage:backlog');
    expect(snap.get('i2')?.labels).toEqual(['bug', 'stage:backlog']);
  });

  it('supports mapping non-canonical Plane state names via stageMap', async () => {
    (execa as any as ExecaMock).mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          id: 'i3',
          name: 'Mapped',
          state_detail: { name: 'Doing' }
        }
      ])
    });

    const adapter = new PlaneAdapter({
      workspaceSlug: 'ws',
      projectId: 'proj',
      stageMap: {
        Doing: 'stage:in-progress',
      },
    });

    const snap = await adapter.fetchSnapshot();

    expect((execa as any).mock.calls[0]?.[0]).toBe('plane');
    expect((execa as any).mock.calls[0]?.[1]).toEqual(['-f', 'json', 'issues', 'list', '-p', 'proj']);

    expect(snap.get('i3')?.stage.toString()).toBe('stage:in-progress');
  });

  it('implements setStage via plane issues update --state <id>', async () => {
    (execa as any as ExecaMock)
      // fetchStates()
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { id: 's1', name: 'Backlog' },
          { id: 's2', name: 'Doing' }
        ])
      })
      // issues update
      .mockResolvedValueOnce({ stdout: '{}' });

    const adapter = new PlaneAdapter({
      workspaceSlug: 'ws',
      projectId: 'proj',
      stageMap: {
        Doing: 'stage:in-progress',
        Backlog: 'stage:backlog',
      },
    });

    await adapter.setStage('i1', 'stage:in-progress');

    expect((execa as any).mock.calls[0]?.[1]).toEqual(['-f', 'json', 'states', '--project', 'proj']);
    expect((execa as any).mock.calls[1]?.[1]).toEqual([
      '-f',
      'json',
      'issues',
      'update',
      '--project',
      'proj',
      '--state',
      's2',
      'i1',
    ]);
  });

  it('implements addComment via Plane comment API', async () => {
    const oldKey = process.env.PLANE_API_KEY;
    const oldBase = process.env.PLANE_BASE_URL;
    process.env.PLANE_API_KEY = 'test-key';
    process.env.PLANE_BASE_URL = 'https://plane.example';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock as any);

    try {
      const adapter = new PlaneAdapter({
        workspaceSlug: 'ws',
        projectId: 'proj',
        stageMap: {
          Doing: 'stage:in-progress',
        },
      });

      await adapter.addComment('i9', 'hello');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://plane.example/api/v1/workspaces/ws/projects/proj/issues/i9/comments/',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': 'test-key',
          },
          body: JSON.stringify({ comment_html: '<p>hello</p>' }),
        },
      );
      expect((execa as any).mock.calls.length).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      if (oldKey == null) delete process.env.PLANE_API_KEY;
      else process.env.PLANE_API_KEY = oldKey;
      if (oldBase == null) delete process.env.PLANE_BASE_URL;
      else process.env.PLANE_BASE_URL = oldBase;
    }
  });
});

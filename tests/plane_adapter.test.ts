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

  it('reconciles creator assignments for unassigned issues in mapped stages', async () => {
    (execa as any as ExecaMock)
      // issues list
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          results: [
            { id: 'i1', name: 'Needs owner', state: { name: 'Todo' }, assignees: [], created_by: 'u1' },
            { id: 'i2', name: 'Already assigned', state: { name: 'Todo' }, assignees: ['u2'], created_by: 'u2' },
            { id: 'i3', name: 'In progress', state: { name: 'In Progress' }, assignees: [], created_by: 'u3' },
          ],
        }),
      })
      // assign i1 -> u1
      .mockResolvedValueOnce({ stdout: '{}' })
      // assign i3 -> u3
      .mockResolvedValueOnce({ stdout: '{}' });

    const adapter = new PlaneAdapter({
      workspaceSlug: 'ws',
      projectId: 'proj',
      stageMap: {
        Todo: 'stage:backlog',
        'In Progress': 'stage:in-progress',
      },
    });

    await adapter.reconcileAssignments();

    expect((execa as any).mock.calls[0]?.[1]).toEqual(['issues', 'list', '-p', 'proj', '-f', 'json']);
    expect((execa as any).mock.calls[1]?.[1]).toEqual([
      '-f',
      'json',
      'issues',
      'assign',
      '--project',
      'proj',
      'i1',
      'u1',
    ]);
    expect((execa as any).mock.calls[2]?.[1]).toEqual([
      '-f',
      'json',
      'issues',
      'assign',
      '--project',
      'proj',
      'i3',
      'u3',
    ]);
    expect((execa as any).mock.calls.length).toBe(3);
  });

  it('reconciles creator assignment when creator is nested object', async () => {
    (execa as any as ExecaMock)
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          results: [
            {
              id: 'i9',
              name: 'Nested creator',
              state: { name: 'Todo' },
              assignees: [],
              created_by: { id: 'u9' },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({ stdout: '{}' });

    const adapter = new PlaneAdapter({
      workspaceSlug: 'ws',
      projectId: 'proj',
      stageMap: {
        Todo: 'stage:backlog',
      },
    });

    await adapter.reconcileAssignments();

    expect((execa as any).mock.calls[1]?.[1]).toEqual([
      '-f',
      'json',
      'issues',
      'assign',
      '--project',
      'proj',
      'i9',
      'u9',
    ]);
  });

  it('orders backlog by priority when priorities differ', async () => {
    (execa as any as ExecaMock)
      // whoami -> me + projects list
      .mockResolvedValueOnce({ stdout: JSON.stringify({ id: 'me1' }) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      // issues list
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            id: 'i-low',
            name: 'Low priority but newer',
            state: { name: 'stage:backlog' },
            priority: 'low',
            updated_at: '2026-02-27T12:00:00Z',
          },
          {
            id: 'i-high',
            name: 'High priority but older',
            state: { name: 'stage:backlog' },
            priority: 'high',
            updated_at: '2026-02-27T10:00:00Z',
          },
        ]),
      });

    const adapter = new PlaneAdapter({
      workspaceSlug: 'ws',
      projectId: 'proj',
      stageMap: {
        'stage:backlog': 'stage:backlog',
        'stage:blocked': 'stage:blocked',
        'stage:in-progress': 'stage:in-progress',
        'stage:in-review': 'stage:in-review',
      },
    });

    const ids = await adapter.listBacklogIdsInOrder();

    expect(ids).toEqual(['i-high', 'i-low']);
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

  it('getWorkItem hydrates body/description from issue details for show/autopilot output', async () => {
    (execa as any as ExecaMock)
      // fetchSnapshot -> issues list
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            id: 'i42',
            name: 'Ticket with details body',
            state: { name: 'Todo' },
            description: 'Short list payload',
          },
        ]),
      })
      // getIssueRaw -> issues get
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: 'i42',
          description: 'Full Plane description from details endpoint',
        }),
      });

    const adapter = new PlaneAdapter({
      workspaceSlug: 'ws',
      projectId: 'proj',
      stageMap: {
        Todo: 'stage:backlog',
      },
    });

    const item = await adapter.getWorkItem('i42');

    expect(item.body).toBe('Full Plane description from details endpoint');
    expect((execa as any).mock.calls[0]?.[1]).toEqual(['-f', 'json', 'issues', 'list', '-p', 'proj']);
    expect((execa as any).mock.calls[1]?.[1]).toEqual(['-f', 'json', 'issues', 'get', '--project', 'proj', 'i42']);
  });

  it('getWorkItem falls back to stripped HTML description when only HTML is available', async () => {
    (execa as any as ExecaMock)
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            id: 'i43',
            name: 'Ticket html',
            state: { name: 'Todo' },
          },
        ]),
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: 'i43',
          description_html: '<p>Hello<br/>Plane</p>',
        }),
      });

    const adapter = new PlaneAdapter({
      workspaceSlug: 'ws',
      projectId: 'proj',
      stageMap: {
        Todo: 'stage:backlog',
      },
    });

    const item = await adapter.getWorkItem('i43');
    expect(item.body).toBe('Hello\nPlane');
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

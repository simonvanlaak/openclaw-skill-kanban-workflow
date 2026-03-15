import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

vi.mock('execa', () => {
  return {
    execa: vi.fn()
  };
});

import { execa } from 'execa';
import { PlaneAdapter } from '../src/adapters/plane.js';

type ExecaMock = typeof execa & {
  mockResolvedValueOnce: (value: unknown) => ExecaMock;
  mockRejectedValueOnce: (value: unknown) => ExecaMock;
  mockReset: () => void;
};

describe('PlaneAdapter', () => {
  beforeEach(() => {
    (execa as any as ExecaMock).mockReset();
    vi.unstubAllGlobals();
    delete process.env.PLANE_API_KEY;
    delete process.env.PLANE_BASE_URL;
    return fs.rm(path.resolve(process.cwd(), '.tmp', 'kwf-plane-identity.json'), { force: true });
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

  it('falls back to cached identity on Plane rate limits', async () => {
    await fs.mkdir(path.resolve(process.cwd(), '.tmp'), { recursive: true });
    await fs.writeFile(
      path.resolve(process.cwd(), '.tmp', 'kwf-plane-identity.json'),
      JSON.stringify({
        workspaceSlug: 'ws',
        identity: {
          id: 'cached-me',
          username: 'cached@example.com',
          name: 'Cached Me',
        },
      }),
      'utf8',
    );

    (execa as any as ExecaMock).mockRejectedValueOnce(
      new Error('API Error 429: {"error_code":5900,"error_message":"RATE_LIMIT_EXCEEDED"}'),
    );

    const adapter = new PlaneAdapter({
      workspaceSlug: 'ws',
      projectId: 'proj',
      bin: 'plane',
      stageMap: {
        Todo: 'stage:todo',
      },
    });

    await expect(adapter.whoami()).resolves.toEqual({
      id: 'cached-me',
      username: 'cached@example.com',
      name: 'Cached Me',
    });
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
          state: { name: 'stage:todo' },
          labels: [{ name: 'bug' }, { name: 'stage:todo' }]
        }
      ])
    });

    const adapter = new PlaneAdapter({
      workspaceSlug: 'ws',
      projectId: 'proj',
      bin: 'plane',
      stageMap: {
        'stage:todo': 'stage:todo',
        'stage:blocked': 'stage:blocked',
        'stage:in-progress': 'stage:in-progress',
        'stage:in-review': 'stage:in-review',
      },
    });

    const snap = await adapter.fetchSnapshot();

    expect((execa as any).mock.calls[0]?.[0]).toBe('plane');
    expect((execa as any).mock.calls[0]?.[1]).toEqual(['-f', 'json', 'issues', 'list', '-p', 'proj']);

    expect(Array.from(snap.keys())).toEqual(['i2']);
    expect(snap.get('i2')?.stage.toString()).toBe('stage:todo');
    expect(snap.get('i2')?.labels).toEqual(['bug', 'stage:todo']);
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

  it('filters stale cached in-progress candidates when live issue state is blocked', async () => {
    const projectId = `proj-stale-filter-${Date.now()}`;

    (execa as any as ExecaMock)
      // whoami
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ id: 'me-1', email: 'me@example.com', display_name: 'Me' }),
      })
      // states lookup to resolve stage filter
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          results: [
            { id: 'state-in-progress-1', name: 'In Progress' },
            { id: 'state-blocked-1', name: 'Blocked' },
          ],
        }),
      })
      // snapshot list (stale: still In Progress)
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            id: 'i-stale',
            name: 'Stale active',
            state: { name: 'In Progress' },
            assignees: [{ id: 'me-1' }],
          },
        ]),
      })
      // live issue read (fresh: moved to Blocked, state exposed as UUID)
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ id: 'i-stale', state: 'state-blocked-1' }),
      });

    const adapter = new PlaneAdapter({
      workspaceSlug: 'ws',
      projectId,
      stageMap: {
        Blocked: 'stage:blocked',
        'In Progress': 'stage:in-progress',
      },
    });

    const ids = await adapter.listIdsByStage('stage:in-progress');

    expect(ids).toEqual([]);
    const calls = (execa as any).mock.calls.map((c: any) => c[1]);
    expect(calls.some((call: string[]) =>
      call.includes('issues')
      && call.includes('list')
      && call.includes('--state')
      && call.includes('state-in-progress-1')
      && call.includes('--assignee')
      && call.includes('me-1'),
    )).toBe(true);
    expect(calls).toContainEqual(['-f', 'json', 'issues', 'get', '-p', projectId, 'i-stale']);
    expect(calls).toContainEqual(['-f', 'json', 'states', '-p', projectId]);
  });

  it('client-filters backlog selection when Plane CLI ignores state and assignee filters', async () => {
    const projectId = `proj-backlog-filter-${Date.now()}`;

    (execa as any as ExecaMock)
      // whoami
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ id: 'me-1', email: 'me@example.com', display_name: 'Me' }),
      })
      // states lookup to resolve todo state id
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          results: [
            { id: 'state-todo-1', name: 'Todo' },
            { id: 'state-review-1', name: 'In Review' },
          ],
        }),
      })
      // broken Plane CLI response: ignores both --state and --assignee
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          results: [
            {
              id: 'todo-mine',
              name: 'Mine',
              priority: 'high',
              state: { id: 'state-todo-1', name: 'Todo' },
              assignees: [{ id: 'me-1' }],
            },
            {
              id: 'todo-other',
              name: 'Other person',
              priority: 'urgent',
              state: { id: 'state-todo-1', name: 'Todo' },
              assignees: [{ id: 'someone-else' }],
            },
            {
              id: 'review-mine',
              name: 'Wrong state',
              priority: 'urgent',
              state: { id: 'state-review-1', name: 'In Review' },
              assignees: [{ id: 'me-1' }],
            },
          ],
        }),
      });

    const adapter = new PlaneAdapter({
      workspaceSlug: 'ws',
      projectId,
      stageMap: {
        Todo: 'stage:todo',
        'In Review': 'stage:in-review',
      },
    });

    const ids = await adapter.listBacklogIdsInOrder();

    expect(ids).toEqual(['todo-mine']);
    const calls = (execa as any).mock.calls.map((c: any) => c[1]);
    expect(calls).toContainEqual([
      'issues',
      'list',
      '-p',
      projectId,
      '--state',
      'state-todo-1',
      '--assignee',
      'me-1',
      '-f',
      'json',
    ]);
  });

  it('uses the Plane API directly for backlog selection when API credentials are available', async () => {
    process.env.PLANE_API_KEY = 'test-key';
    process.env.PLANE_BASE_URL = 'https://plane.example';

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        results: [
          {
            id: 'todo-mine',
            name: 'Mine',
            priority: 'high',
            state: 'state-todo-1',
            assignees: [{ id: 'me-1' }],
          },
          {
            id: 'todo-other',
            name: 'Other',
            priority: 'urgent',
            state: 'state-todo-1',
            assignees: [{ id: 'someone-else' }],
          },
        ],
      }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const projectId = `proj-api-backlog-${Date.now()}`;
    (execa as any as ExecaMock)
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ id: 'me-1', email: 'me@example.com', display_name: 'Me' }),
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          results: [{ id: 'state-todo-1', name: 'Todo' }],
        }),
      });

    const adapter = new PlaneAdapter({
      workspaceSlug: 'ws',
      projectId,
      stageMap: {
        Todo: 'stage:todo',
      },
    });

    const ids = await adapter.listBacklogIdsInOrder();

    expect(ids).toEqual(['todo-mine']);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://plane.example/api/v1/workspaces/ws/projects/${projectId}/issues/`,
      expect.objectContaining({
        method: 'GET',
        headers: { 'x-api-key': 'test-key' },
      }),
    );
    const calls = (execa as any).mock.calls.map((c: any) => c[1]);
    expect(calls).not.toContainEqual([
      'issues',
      'list',
      '-p',
      projectId,
      '--state',
      'state-todo-1',
      '--assignee',
      'me-1',
      '-f',
      'json',
    ]);
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
        Todo: 'stage:todo',
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
      '-p',
      'proj',
      'i1',
      'u1',
    ]);
    expect((execa as any).mock.calls[2]?.[1]).toEqual([
      '-f',
      'json',
      'issues',
      'assign',
      '-p',
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
        Todo: 'stage:todo',
      },
    });

    await adapter.reconcileAssignments();

    expect((execa as any).mock.calls[1]?.[1]).toEqual([
      '-f',
      'json',
      'issues',
      'assign',
      '-p',
      'proj',
      'i9',
      'u9',
    ]);
  });

  it('reconciles creator assignment for non-backlog mapped stages', async () => {
    (execa as any as ExecaMock)
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          results: [
            {
              id: 'i10',
              name: 'In review, unassigned',
              state: { name: 'In Review' },
              assignees: [],
              created_by: 'u10',
            },
            {
              id: 'i11',
              name: 'In review, already assigned',
              state: { name: 'In Review' },
              assignees: ['u11'],
              created_by: 'u11',
            },
            {
              id: 'i12',
              name: 'Done, unmapped state',
              state: { name: 'Done' },
              assignees: [],
              created_by: 'u12',
            },
          ],
        }),
      })
      .mockResolvedValueOnce({ stdout: '{}' });

    const adapter = new PlaneAdapter({
      workspaceSlug: 'ws',
      projectId: 'proj',
      stageMap: {
        Todo: 'stage:todo',
        'In Review': 'stage:in-review',
      },
    });

    await adapter.reconcileAssignments();

    expect((execa as any).mock.calls[1]?.[1]).toEqual([
      '-f',
      'json',
      'issues',
      'assign',
      '-p',
      'proj',
      'i10',
      'u10',
    ]);
    expect((execa as any).mock.calls.length).toBe(2);
  });

  it('reconciles creator assignment for blocked mapped stage', async () => {
    (execa as any as ExecaMock)
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          results: [
            {
              id: 'i20',
              name: 'Blocked and unassigned',
              state: { name: 'Blocked' },
              assignees: [],
              created_by: 'u20',
            },
            {
              id: 'i21',
              name: 'Blocked and already assigned',
              state: { name: 'Blocked' },
              assignees: ['u21'],
              created_by: 'u21',
            },
          ],
        }),
      })
      .mockResolvedValueOnce({ stdout: '{}' });

    const adapter = new PlaneAdapter({
      workspaceSlug: 'ws',
      projectId: 'proj',
      stageMap: {
        Todo: 'stage:todo',
        Blocked: 'stage:blocked',
      },
    });

    await adapter.reconcileAssignments();

    expect((execa as any).mock.calls[1]?.[1]).toEqual([
      '-f',
      'json',
      'issues',
      'assign',
      '-p',
      'proj',
      'i20',
      'u20',
    ]);
    expect((execa as any).mock.calls.length).toBe(2);
  });

  it('orders backlog by priority when priorities differ', async () => {
    (execa as any as ExecaMock)
      // whoami
      .mockResolvedValueOnce({ stdout: JSON.stringify({ id: 'me1' }) })
      // states
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { id: 'todo-state', name: 'stage:todo' },
        ]),
      })
      // issues list
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            id: 'i-low',
            name: 'Low priority but newer',
            state: { name: 'stage:todo' },
            priority: 'low',
            updated_at: '2026-02-27T12:00:00Z',
          },
          {
            id: 'i-high',
            name: 'High priority but older',
            state: { name: 'stage:todo' },
            priority: 'high',
            updated_at: '2026-02-27T10:00:00Z',
          },
        ]),
      });

    const adapter = new PlaneAdapter({
      workspaceSlug: 'ws',
      projectId: 'proj',
      stageMap: {
        'stage:todo': 'stage:todo',
        'stage:blocked': 'stage:blocked',
        'stage:in-progress': 'stage:in-progress',
        'stage:in-review': 'stage:in-review',
      },
    });

    const ids = await adapter.listBacklogIdsInOrder();

    expect(ids).toEqual(['i-high', 'i-low']);
  });

  it('keeps multi-assignee backlog tickets when self is one of the assignees', async () => {
    (execa as any as ExecaMock)
      // whoami
      .mockResolvedValueOnce({ stdout: JSON.stringify({ id: 'me1', email: 'jules@local' }) })
      // states
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { id: 'todo-state', name: 'stage:todo' },
        ]),
      })
      // issues list
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            id: 'i-multi',
            name: 'Multi assignee',
            state: { name: 'stage:todo' },
            assignees: [{ user_id: 'other-user' }, { user_id: 'me1' }],
            updated_at: '2026-02-27T12:00:00Z',
          },
          {
            id: 'i-not-me',
            name: 'Not assigned to me',
            state: { name: 'stage:todo' },
            assignees: [{ id: 'another-user' }],
            updated_at: '2026-02-27T10:00:00Z',
          },
        ]),
      });

    const adapter = new PlaneAdapter({
      workspaceSlug: 'ws',
      projectId: 'proj',
      stageMap: {
        'stage:todo': 'stage:todo',
        'stage:blocked': 'stage:blocked',
        'stage:in-progress': 'stage:in-progress',
        'stage:in-review': 'stage:in-review',
      },
    });

    const ids = await adapter.listBacklogIdsInOrder();
    expect(ids).toEqual(['i-multi']);
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
        Backlog: 'stage:todo',
      },
    });

    await adapter.setStage('i1', 'stage:in-progress');

    expect((execa as any).mock.calls[0]?.[1]).toEqual(['-f', 'json', 'states', '-p', 'proj']);
    expect((execa as any).mock.calls[1]?.[1]).toEqual([
      '-f',
      'json',
      'issues',
      'update',
      '-p',
      'proj',
      '--state',
      's2',
      'i1',
    ]);
  });

  it('getWorkItem hydrates body/description from issue details for show/autopilot output', async () => {
    (execa as any as ExecaMock)
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: 'i42',
          name: 'Ticket with details body',
          state: { name: 'Todo' },
          description: 'Full Plane description from details endpoint',
        }),
      });

    const adapter = new PlaneAdapter({
      workspaceSlug: 'ws',
      projectId: 'proj',
      stageMap: {
        Todo: 'stage:todo',
      },
    });

    const item = await adapter.getWorkItem('i42');

    expect(item.body).toBe('Full Plane description from details endpoint');
    expect((execa as any).mock.calls[0]?.[1]).toEqual(['-f', 'json', 'issues', 'get', '-p', 'proj', 'i42']);
    expect((execa as any).mock.calls.length).toBe(1);
  });

  it('getWorkItem falls back to stripped HTML description when only HTML is available', async () => {
    (execa as any as ExecaMock)
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: 'i43',
          name: 'Ticket html',
          state: { name: 'Todo' },
          description_html: '<p>Hello<br/>Plane</p>',
        }),
      });

    const adapter = new PlaneAdapter({
      workspaceSlug: 'ws',
      projectId: 'proj',
      stageMap: {
        Todo: 'stage:todo',
      },
    });

    const item = await adapter.getWorkItem('i43');
    expect(item.body).toBe('Hello\nPlane');
  });

  it('getWorkItem falls back to snapshot when live issue details omit title/stage fields', async () => {
    (execa as any as ExecaMock)
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: 'i44',
          description: 'Only body from details endpoint',
        }),
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            id: 'i44',
            name: 'Fallback snapshot title',
            state: { name: 'Todo' },
            updated_at: '2026-03-15T18:00:00Z',
            labels: [{ name: 'bug' }],
          },
        ]),
      });

    const adapter = new PlaneAdapter({
      workspaceSlug: 'ws',
      projectId: 'proj',
      stageMap: {
        Todo: 'stage:todo',
      },
    });

    const item = await adapter.getWorkItem('i44');
    expect(item.title).toBe('Fallback snapshot title');
    expect(item.stage).toBe('stage:todo');
    expect(item.body).toBe('Only body from details endpoint');
    expect(item.labels).toEqual(['bug']);
    expect((execa as any).mock.calls[0]?.[1]).toEqual(['-f', 'json', 'issues', 'get', '-p', 'proj', 'i44']);
    expect((execa as any).mock.calls[1]?.[1]).toEqual(['-f', 'json', 'issues', 'list', '-p', 'proj']);
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
        'https://plane.example/api/v1/workspaces/ws/projects/proj/work-items/i9/comments/',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': 'test-key',
          },
          body: JSON.stringify({
            comment_html: '<p>hello</p>',
            comment_json: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
            },
          }),
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

  it('implements addLinks via Plane links API', async () => {
    const oldKey = process.env.PLANE_API_KEY;
    const oldBase = process.env.PLANE_BASE_URL;
    process.env.PLANE_API_KEY = 'test-key';
    process.env.PLANE_BASE_URL = 'https://plane.example';

    const fetchMock = vi
      .fn()
      // list links
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [],
        text: async () => '',
      })
      // create link
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => '',
      });
    vi.stubGlobal('fetch', fetchMock as any);

    try {
      const adapter = new PlaneAdapter({
        workspaceSlug: 'ws',
        projectId: 'proj',
        stageMap: {
          Todo: 'stage:todo',
        },
      });

      await adapter.addLinks('i9', [{ title: 'Nextcloud doc', url: 'https://docs.example/index.php/f/123' }]);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        'https://plane.example/api/v1/workspaces/ws/projects/proj/work-items/i9/links/',
        {
          method: 'GET',
          headers: {
            'x-api-key': 'test-key',
          },
        },
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        'https://plane.example/api/v1/workspaces/ws/projects/proj/work-items/i9/links/',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': 'test-key',
          },
          body: JSON.stringify({ url: 'https://docs.example/index.php/f/123', title: 'Nextcloud doc' }),
        },
      );
    } finally {
      vi.unstubAllGlobals();
      if (oldKey == null) delete process.env.PLANE_API_KEY;
      else process.env.PLANE_API_KEY = oldKey;
      if (oldBase == null) delete process.env.PLANE_BASE_URL;
      else process.env.PLANE_BASE_URL = oldBase;
    }
  });
});

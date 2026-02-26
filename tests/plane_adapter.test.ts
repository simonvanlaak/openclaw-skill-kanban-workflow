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
  mockReset: () => unknown;
};

describe('PlaneAdapter', () => {
  beforeEach(() => {
    (execa as any as ExecaMock).mockReset();
  });

  it('lists workitems and maps state.name to canonical Stage', async () => {
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
          state: { name: 'stage:queued' },
          labels: [{ name: 'bug' }, { name: 'stage:queued' }]
        }
      ])
    });

    const adapter = new PlaneAdapter({
      workspaceSlug: 'ws',
      projectId: 'proj',
      bin: 'plane'
    });

    const snap = await adapter.fetchSnapshot();

    expect(Array.from(snap.keys())).toEqual(['i2']);
    expect(snap.get('i2')?.stage.toString()).toBe('stage:queued');
    expect(snap.get('i2')?.labels).toEqual(['bug', 'stage:queued']);
  });

  it('supports mapping non-canonical Plane state names via stateMap', async () => {
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
      stateMap: {
        Doing: 'stage:in-progress'
      }
    });

    const snap = await adapter.fetchSnapshot();

    expect(snap.get('i3')?.stage.toString()).toBe('stage:in-progress');
  });
});

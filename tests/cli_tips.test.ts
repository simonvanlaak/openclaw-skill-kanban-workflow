import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/setup.js', () => {
  return {
    runSetup: vi.fn(async () => undefined),
  };
});

vi.mock('../src/config.js', () => {
  return {
    loadConfigFromFile: vi.fn(async () => ({
      version: 1,
      adapter: { kind: 'github', repo: 'o/r', stageMap: {} },
    })),
  };
});

vi.mock('../src/adapters/github.js', () => {
  return {
    GitHubAdapter: vi.fn().mockImplementation(() => ({})),
  };
});

vi.mock('../src/adapters/linear.js', () => ({
  LinearAdapter: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../src/adapters/plane.js', () => ({
  PlaneAdapter: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../src/adapters/planka.js', () => ({
  PlankaAdapter: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../src/verbs/verbs.js', () => {
  return {
    show: vi.fn(async () => ({ id: 'X' })),
    next: vi.fn(async () => ({ id: 'X' })),
    start: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    ask: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
    create: vi.fn(async () => ({ id: 'X' })),
  };
});

import { runCli } from '../src/cli.js';
import { loadConfigFromFile } from '../src/config.js';
import { runSetup } from '../src/setup.js';
import { next as nextVerb, start as startVerb } from '../src/verbs/verbs.js';

type IoCapture = { out: string[]; err: string[] };

function createIo(): { io: any; cap: IoCapture } {
  const cap: IoCapture = { out: [], err: [] };
  return {
    cap,
    io: {
      stdout: { write: (chunk: string) => cap.out.push(chunk) },
      stderr: { write: (chunk: string) => cap.err.push(chunk) },
    },
  };
}

describe('cli what-next tips', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prints a what-next tip after setup', async () => {
    const { io, cap } = createIo();

    const code = await runCli(['setup', '--stage-map-json', '{}', '--planka'], io);

    expect(code).toBe(0);
    expect(runSetup).toHaveBeenCalledOnce();
    expect(cap.out.join('')).toMatch(/Wrote config\/clawban\.json/);
    expect(cap.out.join('')).toMatch(/What next: run `clawban next`/);
  });

  it('prints a what-next tip after next', async () => {
    const { io, cap } = createIo();

    const code = await runCli(['next'], io);

    expect(code).toBe(0);
    expect(nextVerb).toHaveBeenCalledOnce();
    expect(cap.out.join('')).toMatch(/What next: run `clawban start --id <id>`/);
  });

  it('prints a what-next tip after start', async () => {
    const { io, cap } = createIo();

    const code = await runCli(['start', '--id', '123'], io);

    expect(code).toBe(0);
    expect(startVerb).toHaveBeenCalledOnce();
    expect(cap.out.join('')).toMatch(/What next: run the actual execution in a subagent/);
    expect(cap.out.join('')).toMatch(/then `clawban ask --id <id> --text/);
    expect(cap.out.join('')).toMatch(/or `clawban update --id <id> --text/);
  });

  it('errors with setup instructions when config is missing/invalid', async () => {
    const { io, cap } = createIo();

    vi.mocked(loadConfigFromFile).mockRejectedValueOnce(new Error('ENOENT'));

    const code = await runCli(['next'], io);

    expect(code).toBe(1);
    expect(cap.err.join('')).toMatch(/Setup not completed/i);
    expect(cap.err.join('')).toMatch(/What next: run `clawban setup`/);
  });
});

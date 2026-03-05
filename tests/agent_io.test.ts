import { describe, expect, it } from 'vitest';

import { parseWorkerOutputFromAgentCall } from '../src/workflow/agent_io.js';

describe('agent io parsing', () => {
  it('extracts text from JSON payloads and keeps stderr separate', () => {
    const stdout = JSON.stringify({
      result: {
        payloads: [
          { text: 'Line 1' },
          { text: 'Line 2' },
        ],
      },
    });
    const stderr = 'warning: noisy transport layer';

    const parsed = parseWorkerOutputFromAgentCall(stdout, stderr);

    expect(parsed.workerOutput).toBe('Line 1\nLine 2');
    expect(parsed.stderr).toBe(stderr);
    expect(parsed.ok).toBe(true);
    expect(parsed.workerOutput).not.toContain('warning:');
  });

  it('extracts text from top-level payload envelopes', () => {
    const stdout = JSON.stringify({
      payloads: [
        {
          content: [
            { type: 'output_text', text: '{"decision":"completed","completed_steps":["Finished implementation and updated related tests for schema parsing behavior."],"clarification_questions":[],"blocker_resolve_requests":[],"solution_summary":"Parser now reads worker JSON from payload text rather than the transport envelope.","evidence":["Validated extraction from top-level payloads to avoid payload/meta schema collisions."]}' },
          ],
        },
      ],
      meta: { requestId: 'abc123' },
    });

    const parsed = parseWorkerOutputFromAgentCall(stdout, '');
    expect(parsed.ok).toBe(true);
    expect(parsed.workerOutput).toContain('"decision":"completed"');
    expect(parsed.workerOutput).not.toContain('"payloads"');
    expect(parsed.workerOutput).not.toContain('"meta"');
  });

  it('extracts output_text fields when payload nodes do not use text key', () => {
    const stdout = JSON.stringify({
      result: {
        payloads: [{ output_text: 'Line A' }, { output_text: 'Line B' }],
      },
    });

    const parsed = parseWorkerOutputFromAgentCall(stdout, '');
    expect(parsed.ok).toBe(true);
    expect(parsed.workerOutput).toBe('Line A\nLine B');
  });

  it('extracts routing metadata when present in result meta', () => {
    const stdout = JSON.stringify({
      status: 'ok',
      result: {
        payloads: [{ text: 'Done' }],
        meta: {
          systemPromptReport: {
            sessionKey: 'agent:kanban-workflow-worker:main',
            sessionId: '9350ec2e-eb42-46a4-b45b-164f869dfa40',
          },
          agentMeta: {
            sessionId: 'ce7e1173-f600-48b4-a5d3-f86c9cfbf3b4',
          },
        },
      },
    });

    const parsed = parseWorkerOutputFromAgentCall(stdout, '');
    expect(parsed.routing?.sessionKey).toBe('agent:kanban-workflow-worker:main');
    expect(parsed.routing?.sessionId).toBe('9350ec2e-eb42-46a4-b45b-164f869dfa40');
    expect(parsed.routing?.agentSessionId).toBe('ce7e1173-f600-48b4-a5d3-f86c9cfbf3b4');
  });

  it('falls back to raw stdout when output is not JSON', () => {
    const parsed = parseWorkerOutputFromAgentCall('plain markdown report', '');
    expect(parsed.workerOutput).toBe('plain markdown report');
    expect(parsed.raw).toBe('plain markdown report');
    expect(parsed.ok).toBe(true);
  });

  it('marks non-ok agent json responses as errors', () => {
    const parsed = parseWorkerOutputFromAgentCall(
      JSON.stringify({ status: 'error', error: { message: 'model unavailable' } }),
      '',
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('model unavailable');
  });
});

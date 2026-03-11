import { describe, expect, it } from 'vitest';

import { validateWorkerResult, formatWorkerResultComment } from '../src/workflow/worker_result.js';
import { PlaneAdapter } from '../src/adapters/plane.js';

describe('worker_result links', () => {
  it('accepts optional links[] in schema validation', () => {
    const payload = {
      decision: 'completed',
      completed_steps: ['Implemented optional links field in worker schema.'],
      clarification_questions: [],
      blocker_resolve_requests: [],
      solution_summary: 'Added support for clickable Nextcloud links in Plane comments.',
      evidence: ['Validated link schema and HTML rendering using unit tests.'],
      links: [{ title: 'Nextcloud doc', url: 'https://docs.example.com/s/abc123' }],
    };

    const res = validateWorkerResult(JSON.stringify(payload));
    expect(res.ok).toBe(true);
  });

  it('formats links section as markdown link syntax', () => {
    const payload = {
      decision: 'completed',
      completed_steps: ['Implemented optional links field in worker schema.'],
      clarification_questions: [],
      blocker_resolve_requests: [],
      solution_summary: 'Added support for clickable Nextcloud links in Plane comments.',
      evidence: ['Validated link schema and HTML rendering using unit tests.'],
      links: [{ title: 'Nextcloud doc', url: 'https://docs.example.com/s/abc123' }],
    };

    const res = validateWorkerResult(JSON.stringify(payload));
    if (!res.ok) throw new Error(res.errors.join('\n'));

    const txt = formatWorkerResultComment(res.value);
    expect(txt).toContain('Links:');
    expect(txt).toContain('[Nextcloud doc](https://docs.example.com/s/abc123)');
  });

  it('renders markdown links to HTML anchors for Plane comments', () => {
    const adapter = new PlaneAdapter({
      workspaceSlug: 'four-of-a-kind',
      projectId: 'dummy',
      stageMap: {},
    });

    // Access private method for unit test purposes.
    const html = (adapter as any).renderCommentHtml('Links:\n1. [Doc](https://docs.example.com/s/abc123)');
    expect(html).toContain('<a href="https://docs.example.com/s/abc123"');
  });
});

import { describe, expect, it } from 'vitest';

import {
  coerceDecisionChoice,
  extractWorkerReportFacts,
  parseDecisionChoice,
  shouldQuietPollAfterCarryForward,
  summarizeReportForComment,
} from '../src/workflow/decision_policy.js';

describe('workflow decision policy', () => {
  it('coerces completed to blocked when verification is missing', () => {
    const facts = extractWorkerReportFacts(
      [
        'Blockers: resolved',
        'Uncertainties: none',
        'Confidence: 0.9',
      ].join('\n'),
    );

    const out = coerceDecisionChoice({ decision: 'completed', facts, continueCount: 0 });
    expect(out).toBe('blocked');
  });

  it('coerces completed to blocked when blockers are not resolved', () => {
    const facts = extractWorkerReportFacts(
      [
        'Verification: tests passed',
        'Blockers: open dependency',
        'Uncertainties: low',
        'Confidence: 0.8',
      ].join('\n'),
    );

    const out = coerceDecisionChoice({ decision: 'completed', facts, continueCount: 0 });
    expect(out).toBe('blocked');
  });

  it('coerces continue to blocked after continue cap is reached', () => {
    const facts = extractWorkerReportFacts(
      [
        'Verification: tests passed',
        'Blockers: resolved',
        'Uncertainties: low',
        'Confidence: 0.8',
      ].join('\n'),
    );

    const out = coerceDecisionChoice({ decision: 'continue', facts, continueCount: 2 });
    expect(out).toBe('blocked');
  });

  it('quiet-polls only when carry-forward and all execution outcomes are delegated_running', () => {
    expect(
      shouldQuietPollAfterCarryForward({
        activeCarryForward: true,
        executionOutcomes: ['delegated_running', 'delegated_running'],
      }),
    ).toBe(true);

    expect(
      shouldQuietPollAfterCarryForward({
        activeCarryForward: true,
        executionOutcomes: ['delegated_running', 'applied'],
      }),
    ).toBe(false);

    expect(
      shouldQuietPollAfterCarryForward({
        activeCarryForward: true,
        executionOutcomes: [],
      }),
    ).toBe(false);
  });

  it('parses only strict one-word decisions (or structured json)', () => {
    expect(parseDecisionChoice('continue')).toBe('continue');
    expect(parseDecisionChoice('  "blocked"  ')).toBe('blocked');
    expect(parseDecisionChoice('I think continue')).toBeNull();
    expect(parseDecisionChoice('not blocked, continue')).toBeNull();
    expect(parseDecisionChoice('{"decision":"completed"}')).toBe('completed');
  });

  it('preserves markdown formatting when summarizing report comments', () => {
    const report = [
      '# Status Report',
      '',
      '## Verification Evidence',
      '- item one',
      '- item two',
      '',
      '## Blockers',
      '| Blocker | Status |',
      '|---|---|',
      '| SSH | OPEN |',
    ].join('\n');

    const out = summarizeReportForComment(report, 1000);
    expect(out).toContain('# Status Report');
    expect(out).toContain('## Verification Evidence');
    expect(out).toContain('- item one');
    expect(out).toContain('| Blocker | Status |');
    expect(out).toContain('\n');
  });
});

import { describe, it, expect } from 'vitest';
import { scoreResult, buildReport } from './score.js';
import type { EvalResult } from './score.js';
import type { ExpectedOutcome } from './scenarios.js';

describe('scoreResult', () => {
  // handlePreToolUse returns structured { level, message } results — the
  // action comes from the level field, never from message-text sniffing.
  it('scores 1.0 for exact match on advise', () => {
    const expected: ExpectedOutcome = { action: 'advise', tool: 'rtk grep' };
    const actual = {
      level: 'advise' as const,
      message: '[ADVISE] Tool Router: text_search detected\nadvise: use rtk grep — ...',
    };
    expect(scoreResult(expected, actual)).toBe(1.0);
  });

  it('scores 0.5 for action match but wrong tool', () => {
    const expected: ExpectedOutcome = { action: 'advise', tool: 'rtk grep' };
    const actual = {
      level: 'advise' as const,
      message: '[ADVISE] Tool Router: text_search detected\nadvise: use Grep — ...',
    };
    expect(scoreResult(expected, actual)).toBe(0.5);
  });

  it('scores 0.0 when expected advise but got null (allow)', () => {
    const expected: ExpectedOutcome = { action: 'advise', tool: 'rtk read' };
    expect(scoreResult(expected, null)).toBe(0.0);
  });

  it('scores 1.0 for expected allow when got null', () => {
    const expected: ExpectedOutcome = { action: 'allow' };
    expect(scoreResult(expected, null)).toBe(1.0);
  });

  it('scores 0.0 for expected allow but got advise', () => {
    const expected: ExpectedOutcome = { action: 'allow' };
    const actual = {
      level: 'advise' as const,
      message: '[ADVISE] Tool Router: file_read detected\nadvise: use Read — ...',
    };
    expect(scoreResult(expected, actual)).toBe(0.0);
  });

  it('scores 1.0 for exact match on block', () => {
    const expected: ExpectedOutcome = { action: 'block' };
    const actual = {
      level: 'block' as const,
      message: '[BLOCK] Tool Router: file_modify operation blocked\nReason: ...',
    };
    expect(scoreResult(expected, actual)).toBe(1.0);
  });

  it('scores 1.0 for advise with no specific tool expected', () => {
    const expected: ExpectedOutcome = { action: 'block' };
    const actual = {
      level: 'block' as const,
      message: '[BLOCK] Tool Router: file_modify operation blocked',
    };
    expect(scoreResult(expected, actual)).toBe(1.0);
  });

  it('scores 0.0 for wrong action', () => {
    const expected: ExpectedOutcome = { action: 'block' };
    const actual = {
      level: 'advise' as const,
      message: '[ADVISE] Tool Router: text_search detected',
    };
    expect(scoreResult(expected, actual)).toBe(0.0);
  });

  it('does not escalate an advisory whose message embeds the literal [BLOCK]', () => {
    const expected: ExpectedOutcome = { action: 'advise' };
    const actual = {
      level: 'advise' as const,
      message: "[ADVISE] advise: use Grep — output mentions '[BLOCK]' literally",
    };
    expect(scoreResult(expected, actual)).toBe(1.0);
  });
});

describe('buildReport', () => {
  it('computes overall score as average', () => {
    const results: EvalResult[] = [
      makeResult('s1', 'full', 'bash', 1.0),
      makeResult('s2', 'full', 'bash', 0.5),
      makeResult('s3', 'rtk_only', 'native', 0.0),
      makeResult('s4', 'rtk_only', 'native', 1.0),
    ];
    const report = buildReport(results);
    expect(report.overallScore).toBeCloseTo(0.625);
    expect(report.totalCases).toBe(4);
    expect(report.passCount).toBe(3);
  });

  it('computes scores by category', () => {
    const results: EvalResult[] = [
      makeResult('s1', 'full', 'bash', 1.0),
      makeResult('s2', 'full', 'bash', 0.5),
      makeResult('s3', 'full', 'native', 0.0),
    ];
    const report = buildReport(results);
    expect(report.byCategory['bash']).toBeCloseTo(0.75);
    expect(report.byCategory['native']).toBeCloseTo(0.0);
  });

  it('computes scores by environment', () => {
    const results: EvalResult[] = [
      makeResult('s1', 'full', 'bash', 1.0),
      makeResult('s2', 'rtk_only', 'bash', 0.0),
    ];
    const report = buildReport(results);
    expect(report.byEnvironment['full']).toBeCloseTo(1.0);
    expect(report.byEnvironment['rtk_only']).toBeCloseTo(0.0);
  });

  it('reports failures', () => {
    const results: EvalResult[] = [
      makeResult('s1', 'full', 'bash', 0.0),
      makeResult('s2', 'full', 'bash', 1.0),
    ];
    const report = buildReport(results);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].scenarioId).toBe('s1');
  });
});

function makeResult(
  id: string,
  env: string,
  category: string,
  score: number,
): EvalResult {
  return {
    scenarioId: id,
    environment: env,
    category,
    expected: { action: 'advise', tool: 'test' },
    actual: score > 0 ? { action: 'advise', tool: 'test' } : { action: 'allow' },
    score,
    pass: score >= 0.5,
  };
}

import { describe, it, expect } from 'vitest';
import { majorityPass, buildReport } from '../../evals/reduce.js';
import type { RunResult, ScenarioResult } from '../../evals/types.js';

const runs = (...flags: boolean[]): RunResult[] =>
  flags.map((pass, i) => ({ runIndex: i, pass, observed: pass ? 'ok' : 'miss' }));

describe('reduce: N-of-M majority', () => {
  it('passes on a majority (2/3)', () => expect(majorityPass(runs(true, true, false))).toBe(true));
  it('fails below majority (1/3)', () => expect(majorityPass(runs(true, false, false))).toBe(false));
  it('passes when all pass', () => expect(majorityPass(runs(true, true, true))).toBe(true));
  it('passes on a single run that passed', () => expect(majorityPass(runs(true))).toBe(true));
  it('fails on a single run that failed', () => expect(majorityPass(runs(false))).toBe(false));
});

describe('reduce: report builder', () => {
  it('aggregates pass count and records failures with a reason', () => {
    const scenarios: ScenarioResult[] = [
      { id: 'a', runs: runs(true, true, true), pass: true },
      { id: 'b', runs: runs(true, false, false), pass: false },
    ];
    const r = buildReport('claude-opus-4-8', scenarios);
    expect(r.model).toBe('claude-opus-4-8');
    expect(r.totalScenarios).toBe(2);
    expect(r.passCount).toBe(1);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].id).toBe('b');
  });
});

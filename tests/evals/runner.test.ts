import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { gradeTranscript, runScenario, parseArgs, TeardownRegistry } from '../../evals/runner.js';
import { SCENARIOS } from '../../evals/scenarios.js';
import type { Scenario } from '../../evals/types.js';

const fx = (n: string) => readFileSync(join(process.cwd(), 'evals/fixtures', n), 'utf-8');
const POS = fx('canned-loop-fit-positive.jsonl');
const NEG = fx('canned-loop-fit-negative.jsonl');
const get = (id: string): Scenario => SCENARIOS.find((s) => s.id === id)!;
const judgeAlways = (ok: boolean) => async () => ok;

describe('runner: gradeTranscript dispatch by invariant', () => {
  it('positive scenario passes when opt-in present', async () => {
    expect((await gradeTranscript(get('loop-fit-positive'), POS, judgeAlways(true))).pass).toBe(true);
  });
  it('negative scenario passes only when structurally absent AND judge confirms', async () => {
    expect((await gradeTranscript(get('loop-fit-negative'), NEG, judgeAlways(true))).pass).toBe(true);
    expect((await gradeTranscript(get('loop-fit-negative'), NEG, judgeAlways(false))).pass).toBe(false);
  });
  it('negative scenario fails fast if opt-in is structurally present (judge not consulted)', async () => {
    const judge = vi.fn(async () => true);
    const r = await gradeTranscript(get('loop-fit-negative'), POS, judge);
    expect(r.pass).toBe(false);
    expect(judge).not.toHaveBeenCalled();
  });
});

describe('runner: runScenario with injected driver', () => {
  it('runs N times and reduces by majority', async () => {
    const driveSession = vi.fn(async () => POS);
    const res = await runScenario(get('loop-fit-positive'), { driveSession, model: 'm', runs: 3, judge: judgeAlways(true) });
    expect(res.runs).toHaveLength(3);
    expect(res.pass).toBe(true);
    expect(driveSession).toHaveBeenCalledTimes(3);
  });
});

describe('runner: TeardownRegistry deletes only tracked paths', () => {
  it('removes exactly what was tracked, nothing else', () => {
    const reg = new TeardownRegistry();
    reg.track('/tmp/rig-eval-abc'); reg.track('/tmp/rig-session-abc.json');
    const removed: string[] = [];
    reg.cleanup((p) => removed.push(p));
    expect(removed.sort()).toEqual(['/tmp/rig-eval-abc', '/tmp/rig-session-abc.json']);
    expect(removed).not.toContain('/tmp/rig-session-someone-elses.json');
  });
});

describe('runner: parseArgs', () => {
  it('defaults model+runs and parses flags', () => {
    expect(parseArgs([])).toMatchObject({ runs: 3 });
    expect(parseArgs(['--scenario', 'loop-fit-negative', '--runs', '1', '--model', 'x'])).toMatchObject({
      scenario: 'loop-fit-negative', runs: 1, model: 'x',
    });
  });
});

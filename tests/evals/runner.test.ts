import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { gradeTranscript, runScenario, parseArgs, TeardownRegistry } from '../../evals/runner.js';
import { SCENARIOS } from '../../evals/scenarios.js';
import type { Scenario } from '../../evals/types.js';

const fx = (n: string) => readFileSync(join(process.cwd(), 'evals/fixtures', n), 'utf-8');
const POS = fx('canned-loop-fit-positive.jsonl');
const NEG = fx('canned-loop-fit-negative.jsonl');
const DISMISS = fx('canned-loop-fit-dismissal.jsonl');
const get = (id: string): Scenario => SCENARIOS.find((s) => s.id === id)!;
const judgeAlways = (ok: boolean) => async () => ok;

describe('runner: gradeTranscript dispatch by invariant', () => {
  it('positive scenario passes when opt-in present', async () => {
    expect((await gradeTranscript(get('loop-fit-positive'), POS, judgeAlways(true))).pass).toBe(true);
  });
  it('negative scenario passes deterministically when no loop trajectory is referenced (judge not consulted)', async () => {
    const judge = vi.fn(async () => false); // would fail the grade if it were ever consulted
    const r = await gradeTranscript(get('loop-fit-negative'), NEG, judge);
    expect(r.pass).toBe(true);
    expect(judge).not.toHaveBeenCalled();
  });
  it('negative scenario consults the judge when the trajectory is referenced (offer vs mention)', async () => {
    // Token present → could be an OFFER or a DISMISSAL-by-name; structure can't
    // tell them apart, so the judge decides.
    expect((await gradeTranscript(get('loop-fit-negative'), POS, judgeAlways(false))).pass).toBe(false);
    expect((await gradeTranscript(get('loop-fit-negative'), POS, judgeAlways(true))).pass).toBe(true);
  });
  it('negative scenario: a visible dismissal-by-name is not auto-failed — the judge clears it', async () => {
    // Regression (live Opus 4.8, 2026-06-12): the model dismissed "the
    // agent-loop pattern" / "maintainer trajectory" BY NAME in visible output.
    // matchLoopOptIn fires on the tokens, so the old grader auto-failed the
    // compliant CLI brief. Now the judge — which recognises a dismissal as a
    // non-offer — is consulted and clears it.
    const judge = vi.fn(async () => true); // correct verdict: referenced but not offered
    const r = await gradeTranscript(get('loop-fit-negative'), DISMISS, judge);
    expect(r.pass).toBe(true);
    expect(judge).toHaveBeenCalledOnce();
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

// Eval runner: orchestration (drive → grade → reduce). The live claude -p
// driver and its filesystem scaffold/teardown live in evals/drive.ts and are
// injected here as `driveSession`, so this module is fully unit-testable with
// canned transcripts.

import { rmSync } from 'fs';
import { extractAssistantText, matchLoopOptIn, matchSectionsPresent } from './grade.js';
import { majorityPass, buildReport } from './reduce.js';
import { SCENARIOS } from './scenarios.js';
import type { Scenario, RunResult, ScenarioResult, EvalReport } from './types.js';

/** A judge returns true iff the transcript is COMPLIANT (no loop offered). */
export type Judge = (transcript: string) => Promise<boolean>;
/** Drives one headless session for a scenario and returns its transcript. */
export type DriveSessionFn = (scenario: Scenario, model: string) => Promise<string>;

export interface RunDeps {
  driveSession: DriveSessionFn;
  model: string;
  runs: number;
  judge: Judge;
}

/** Grade a transcript against a scenario's (single, v1) invariant. */
export async function gradeTranscript(
  scenario: Scenario,
  transcript: string,
  judge: Judge,
): Promise<{ pass: boolean; observed: string }> {
  // Grade the VISIBLE assistant output only. extractAssistantText drops
  // thinking blocks and non-assistant lines — a model may reason about
  // "agent-loop pattern" while DISMISSING it (the raw transcript then carries
  // the token though the user was never offered the trajectory). The user-
  // visible text is the correct grading surface.
  const text = extractAssistantText(transcript);
  const inv = scenario.invariants[0];
  switch (inv.kind) {
    case 'loop-optin-present': {
      const ok = matchLoopOptIn(text);
      return { pass: ok, observed: ok ? 'loop opt-in present' : 'loop opt-in MISSING' };
    }
    case 'loop-optin-absent': {
      if (matchLoopOptIn(text)) {
        return { pass: false, observed: 'loop opt-in unexpectedly present' };
      }
      const compliant = await judge(text); // judge consulted only when structurally absent
      return {
        pass: compliant,
        observed: compliant ? 'no loop offered (judge confirmed)' : 'judge flagged a loop offer',
      };
    }
    case 'sections-present': {
      const ok = matchSectionsPresent(text);
      return { pass: ok, observed: ok ? 'all required sections present' : 'required sections missing' };
    }
    default:
      return { pass: false, observed: `unknown invariant: ${(inv as { kind: string }).kind}` };
  }
}

export async function runScenario(scenario: Scenario, deps: RunDeps): Promise<ScenarioResult> {
  const runs: RunResult[] = [];
  for (let i = 0; i < deps.runs; i++) {
    const transcript = await deps.driveSession(scenario, deps.model);
    const { pass, observed } = await gradeTranscript(scenario, transcript, deps.judge);
    runs.push({ runIndex: i, pass, observed });
  }
  return { id: scenario.id, runs, pass: majorityPass(runs) };
}

export async function runAll(deps: RunDeps & { scenarioId?: string }): Promise<EvalReport> {
  const selected = deps.scenarioId
    ? SCENARIOS.filter((s) => s.id === deps.scenarioId)
    : SCENARIOS;
  const results: ScenarioResult[] = [];
  for (const s of selected) results.push(await runScenario(s, deps));
  return buildReport(deps.model, results);
}

/** Tracks exact paths created by a run and removes only those (never globs). */
export class TeardownRegistry {
  private readonly paths = new Set<string>();
  track(p: string): void {
    this.paths.add(p);
  }
  tracked(): string[] {
    return [...this.paths];
  }
  cleanup(rm: (p: string) => void = (p) => rmSync(p, { recursive: true, force: true })): void {
    for (const p of this.paths) rm(p);
    this.paths.clear();
  }
}

export interface EvalArgs {
  model: string;
  runs: number;
  scenario?: string;
}

export function parseArgs(argv: string[]): EvalArgs {
  const out: EvalArgs = {
    model: process.env.EVAL_MODEL ?? 'claude-opus-4-8',
    runs: 3,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model' && argv[i + 1]) out.model = argv[++i];
    else if (argv[i] === '--runs' && argv[i + 1]) out.runs = Number(argv[++i]) || out.runs;
    else if (argv[i] === '--scenario' && argv[i + 1]) out.scenario = argv[++i];
  }
  return out;
}

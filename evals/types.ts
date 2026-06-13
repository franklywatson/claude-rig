// Behavioral eval harness — core types.
// Analogous in spirit to tests/eval/score.ts's EvalReport (overall pass count +
// failures list) but shaped for live claude -p behavioral runs rather than
// synchronous routing scenarios.

export type InvariantKind =
  | 'loop-optin-present' // transcript fires the loop opt-in (loop-specific tokens)
  | 'loop-optin-absent' // transcript does NOT offer the loop trajectory
  | 'sections-present'; // an opted-in design carries the three required sections

export interface Invariant {
  kind: InvariantKind;
  description: string;
}

export interface Scenario {
  id: string;
  mode: 'positive' | 'negative' | 'sections';
  /** Path to the brief fixture, relative to repo root. */
  briefFile: string;
  /** The scripted prompt handed to `claude -p`. */
  prompt: string;
  invariants: Invariant[];
}

export interface RunResult {
  runIndex: number;
  pass: boolean;
  /** Short human-readable note on what was / wasn't observed. */
  observed: string;
}

export interface ScenarioResult {
  id: string;
  runs: RunResult[];
  /** Majority verdict across runs (N-of-M). */
  pass: boolean;
}

export interface EvalReport {
  model: string;
  totalScenarios: number;
  passCount: number;
  scenarios: ScenarioResult[];
  failures: Array<{ id: string; reason: string }>;
}

export function emptyReport(model: string): EvalReport {
  return { model, totalScenarios: 0, passCount: 0, scenarios: [], failures: [] };
}

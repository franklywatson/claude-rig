// Behavioral eval harness — core types.
// Analogous in spirit to tests/eval/score.ts's EvalReport (overall pass count +
// failures list) but shaped for live claude -p behavioral runs rather than
// synchronous routing scenarios.

export type InvariantKind =
  | 'loop-optin-present' // transcript fires the loop opt-in (loop-specific tokens)
  | 'loop-optin-absent' // transcript does NOT offer the loop trajectory
  | 'sections-present' // an opted-in design carries the three required sections
  | 'jcodemunch-tool-used'; // the agent followed a divert/advisory and called an mcp__jcodemunch__ tool

export interface Invariant {
  kind: InvariantKind;
  description: string;
}

/** A file materialized into the scaffolded temp project before the run. */
export interface ProjectFile {
  /** Destination path within the temp project (POSIX, relative). */
  dest: string;
  /** Repo-relative source fixture path to copy from. */
  src: string;
}

export interface Scenario {
  id: string;
  mode: 'positive' | 'negative' | 'sections';
  /** Path to the brief fixture, relative to repo root. */
  briefFile: string;
  /** The scripted prompt handed to `claude -p`. */
  prompt: string;
  invariants: Invariant[];
  /** Extra files copied into the temp project after `rig init` (e.g. a fixture
   *  codebase for routing/divert scenarios). Optional. */
  projectFiles?: ProjectFile[];
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

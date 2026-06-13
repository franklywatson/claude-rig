// N-of-M majority reduction and EvalReport assembly.

import type { RunResult, ScenarioResult, EvalReport } from './types.js';

/** Scenario passes if a strict majority of its runs passed (⌈M/2⌉). */
export function majorityPass(runs: RunResult[]): boolean {
  if (runs.length === 0) return false;
  const passed = runs.filter((r) => r.pass).length;
  return passed >= Math.ceil(runs.length / 2);
}

export function buildReport(model: string, scenarios: ScenarioResult[]): EvalReport {
  const passCount = scenarios.filter((s) => s.pass).length;
  const failures = scenarios
    .filter((s) => !s.pass)
    .map((s) => {
      const passed = s.runs.filter((r) => r.pass).length;
      return { id: s.id, reason: `${passed}/${s.runs.length} runs passed — ${s.runs.find((r) => !r.pass)?.observed ?? 'no detail'}` };
    });
  return { model, totalScenarios: scenarios.length, passCount, scenarios, failures };
}

import type { ExpectedOutcome } from './scenarios.js';

export interface EvalResult {
  scenarioId: string;
  environment: string;
  category: string;
  expected: ExpectedOutcome;
  actual: { action: string; tool?: string } | null; // null = hook returned null (allow)
  score: number;
  pass: boolean;
}

export interface EvalReport {
  overallScore: number;
  totalCases: number;
  passCount: number;
  byCategory: Record<string, number>;
  byEnvironment: Record<string, number>;
  failures: Array<{
    scenarioId: string;
    environment: string;
    expected: string;
    actual: string;
  }>;
}

export interface ParsedResult {
  action: string;
  tool?: string;
}

/**
 * Parse a hook result into a structured { action, tool? } form.
 * Handles structured EnforcementViolation output (advise/block),
 * RewriteResult (rewrite), and null (allow). Severity comes from the
 * structured level — never from sniffing the message text.
 */
export function parseResult(
  result: import('../../src/types.js').EnforcementViolation | import('../../src/types.js').RewriteResult | null,
): ParsedResult {
  if (result === null) return { action: 'allow' };
  if ('type' in result && result.type === 'rewrite') {
    const firstWord = result.command.split(/\s+/)[0];
    // "rtk grep ..." -> tool is "rtk grep"
    const secondWord = result.command.split(/\s+/)[1];
    const tool = secondWord ? `${firstWord} ${secondWord}` : firstWord;
    return { action: 'rewrite', tool };
  }
  if ('level' in result) {
    if (result.level === 'block') return { action: 'block' };
    const match = result.message.match(/advise: use (.+?) —/i) ?? result.message.match(/advise: use (\S+)/i);
    return { action: 'advise', tool: match?.[1]?.trim() };
  }
  return { action: 'unknown' };
}

/**
 * Score a single routing result against the expected outcome.
 *
 * 1.0 = exact match (action + tool both correct)
 * 0.5 = partial match (action correct, tool missing/wrong)
 * 0.0 = miss (action wrong, or expected routing but got nothing)
 */
export function scoreResult(
  expected: ExpectedOutcome,
  result: import('../../src/types.js').EnforcementViolation | import('../../src/types.js').RewriteResult | null,
): number {
  const parsed = parseResult(result);

  if (expected.action === 'allow') {
    return parsed.action === 'allow' ? 1.0 : 0.0;
  }

  if (parsed.action === 'allow') return 0.0;

  const actionMatch = parsed.action === expected.action;

  if (!expected.tool) {
    return actionMatch ? 1.0 : 0.0;
  }

  const toolMatch = (parsed.tool ?? '').toLowerCase().includes(expected.tool.toLowerCase());

  if (actionMatch && toolMatch) return 1.0;
  if (actionMatch) return 0.5;
  return 0.0;
}

/** Build a report from all eval results. */
export function buildReport(results: EvalResult[]): EvalReport {
  const totalCases = results.length;
  const passCount = results.filter(r => r.pass).length;
  const overallScore = totalCases > 0 ? results.reduce((sum, r) => sum + r.score, 0) / totalCases : 0;

  const byCategory: Record<string, number> = {};
  const byEnvironment: Record<string, number> = {};

  for (const r of results) {
    const catResults = results.filter(x => x.category === r.category);
    byCategory[r.category] = catResults.reduce((s, x) => s + x.score, 0) / catResults.length;

    const envResults = results.filter(x => x.environment === r.environment);
    byEnvironment[r.environment] = envResults.reduce((s, x) => s + x.score, 0) / envResults.length;
  }

  const failures = results
    .filter(r => !r.pass)
    .map(r => ({
      scenarioId: r.scenarioId,
      environment: r.environment,
      expected: `${r.expected.action}${r.expected.tool ? ` → ${r.expected.tool}` : ''}`,
      actual: r.actual
        ? `${r.actual.action}${r.actual.tool ? ` → ${r.actual.tool}` : ''}`
        : 'allow (no routing)',
    }));

  return { overallScore, totalCases, passCount, byCategory, byEnvironment, failures };
}

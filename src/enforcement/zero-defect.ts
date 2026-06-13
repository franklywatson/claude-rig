import type { EnforcementViolation, HarnessConfig } from '../types.js';

const FAILURE_PATTERNS = [
  /\bFAIL(?:ED)?\b/,
  /\bERROR\b/,
  /\berror TS\d{4}\b/,
  /\b\d+ failed\b/,
];

const FAILURE_LINE_PATTERNS = [
  /^\s*(FAIL|FAILED)\s+/,
  /^\s*ERROR\s+/,
  /\berror TS\d{4}\b/,
];

/**
 * Phases whose runs expect failing tests (the RED step of red-green-refactor).
 * Mirrors SCOPED_PHASES in test-scope.ts and post-tool-use.ts — all three list
 * the phases where a full-suite failure is not yet a defect to block on.
 */
const SCOPED_PHASES = ['tdd+', 'sdd+'];

/**
 * Extract a test file path from a failure line.
 * Handles vitest/jest `FAIL tests/foo.test.ts` and pytest `FAILED tests/test_foo.py`.
 */
function extractFilePath(line: string): string | null {
  // vitest/jest: FAIL tests/foo.test.ts
  let match = line.match(/FAIL\s+(\S+)/);
  if (match) return match[1];
  // pytest: FAILED tests/test_foo.py::test_name
  match = line.match(/FAILED\s+(\S+)/);
  if (match) return match[1];
  // ERROR: ERROR tests/setup.ts
  match = line.match(/ERROR\s+(\S+)/);
  if (match) return match[1];
  // TypeScript: error TS2322 in src/foo.ts(42,5)
  match = line.match(/error\s+TS\d+\s+.*?(\S+\.\w+)\(/);
  if (match) return match[1];
  return null;
}

/**
 * Derive a test file path from a source file path.
 * e.g., src/router/resolver.ts -> tests/router/resolver.test.ts
 */
function sourceToTestPath(sourceFile: string): string {
  const base = sourceFile.replace(/^src\//, '').replace(/\.\w+$/, '');
  return `tests/${base}.test.ts`;
}

/**
 * Check if a failing test file is related to a changed source file.
 */
function isRelatedToChangedFile(testFile: string, changedFiles: string[]): boolean {
  // Direct match: test file itself was changed
  if (changedFiles.includes(testFile)) return true;

  // Source-to-test mapping: changed src/foo.ts relates to tests/foo.test.ts
  for (const changed of changedFiles) {
    const derived = sourceToTestPath(changed);
    if (testFile === derived) return true;
  }

  return false;
}

export interface ClassifiedFailure {
  regressions: string[];
  preExisting: string[];
}

/**
 * Classify test failures as regressions (in-branch) or pre-existing.
 */
export function classifyFailures(testOutput: string, changedFiles: string[]): ClassifiedFailure {
  const lines = testOutput.split('\n');
  const failureLines: string[] = [];

  for (const line of lines) {
    if (FAILURE_LINE_PATTERNS.some(p => p.test(line))) {
      failureLines.push(line.trim());
    }
  }

  const regressions: string[] = [];
  const preExisting: string[] = [];

  for (const line of failureLines) {
    const filePath = extractFilePath(line);
    if (!filePath) {
      // Can't classify without a file path — treat as regression
      regressions.push(line);
      continue;
    }

    if (isRelatedToChangedFile(filePath, changedFiles)) {
      regressions.push(line);
    } else {
      preExisting.push(line);
    }
  }

  return { regressions, preExisting };
}

/**
 * Check test output for failures and errors.
 * Returns null if clean, or a zero-defect violation carrying its level.
 * When changedFiles is provided, classifies failures as regressions vs pre-existing.
 *
 * Phase-aware: during a scoped-execution phase (tdd+/sdd+), a failing test is
 * the expected RED step of red-green-refactor — indistinguishable from a
 * regression to a pattern match — so blocking is downgraded to advisory. The
 * block returns in verify+ (final verification), where a green suite is
 * mandatory. Mirrors checkTestScope's phase gating. currentPhase is omitted by
 * callers that don't track phase, leaving the strict behavior unchanged.
 */
export function checkZeroDefect(
  testOutput: string,
  config: HarnessConfig,
  changedFiles?: string[],
  currentPhase?: string | null,
): EnforcementViolation | null {
  const tolerance = config.rules.zero_defect?.tolerance ?? 'strict';
  const unrelatedErrors = config.rules.zero_defect?.unrelated_errors ?? 'block';

  const hasFailure = FAILURE_PATTERNS.some(p => p.test(testOutput));
  if (!hasFailure) return null;

  // During tdd+/sdd+, failing tests are expected (RED). Cap the level at
  // advisory so the loop isn't blocked on every RED run; the message formatters
  // derive their level from this effective tolerance.
  const inScopedPhase = currentPhase != null && SCOPED_PHASES.includes(currentPhase);
  const effectiveTolerance = inScopedPhase ? 'permissive' : tolerance;

  // No changed files provided — use original behavior
  if (!changedFiles) {
    return formatViolation(testOutput, effectiveTolerance);
  }

  // Classify failures
  const { regressions, preExisting } = classifyFailures(testOutput, changedFiles);

  // No regressions — check pre-existing handling
  if (regressions.length === 0) {
    if (unrelatedErrors === 'silent' || preExisting.length === 0) return null;
    if (unrelatedErrors === 'advise') {
      return formatPreExistingMessage(preExisting);
    }
    // block: fall through to format all as violations
    return formatViolation(testOutput, effectiveTolerance);
  }

  // Has regressions — always block on those
  const parts: EnforcementViolation[] = [];

  if (regressions.length > 0) {
    parts.push(formatRegressionsMessage(regressions, effectiveTolerance));
  }

  if (preExisting.length > 0 && unrelatedErrors !== 'silent') {
    parts.push(formatPreExistingMessage(preExisting));
  }

  return {
    level: parts.some(p => p.level === 'block') ? 'block' : 'advise',
    message: parts.map(p => p.message).join('\n\n---\n\n'),
  };
}

function formatViolation(testOutput: string, tolerance: string): EnforcementViolation {
  const lines = testOutput.split('\n');
  const failureLines: string[] = [];
  for (const line of lines) {
    if (FAILURE_LINE_PATTERNS.some(p => p.test(line))) {
      failureLines.push(line.trim());
    }
  }

  const level = tolerance === 'strict' ? 'block' : 'advise';
  const prefix = level === 'block' ? '[BLOCK]' : '[ADVISE]';

  return {
    level,
    message: [
      `${prefix} ZERO-DEFECT VIOLATION`,
      '',
      `${failureLines.length} failure(s) found:`,
      ...failureLines.slice(0, 10).map(l => `  ${l}`),
      '',
      'Zero-defect tolerance: every error, warning, and failure must be addressed.',
      '"This failure is unrelated" is never acceptable.',
      'Fix ALL errors before proceeding.',
    ].join('\n'),
  };
}

function formatRegressionsMessage(regressions: string[], tolerance: string): EnforcementViolation {
  const level = tolerance === 'strict' ? 'block' : 'advise';
  const prefix = level === 'block' ? '[BLOCK]' : '[ADVISE]';

  return {
    level,
    message: [
      `${prefix} REGRESSION(S) DETECTED`,
      '',
      `${regressions.length} regression(s) in files you changed:`,
      ...regressions.slice(0, 10).map(l => `  ${l}`),
      '',
      'These failures are in your branch. Fix them before proceeding.',
    ].join('\n'),
  };
}

function formatPreExistingMessage(preExisting: string[]): EnforcementViolation {
  // Pre-existing failures are always advisory: they predate the branch, so
  // they never escalate the combined result to block on their own.
  return {
    level: 'advise',
    message: [
      '[ADVISE] PRE-EXISTING FAILURE(S)',
      '',
      `${preExisting.length} pre-existing failure(s) in untouched files:`,
      ...preExisting.slice(0, 10).map(l => `  ${l}`),
      '',
      'These failures existed before your changes. Consider fixing them separately.',
    ].join('\n'),
  };
}

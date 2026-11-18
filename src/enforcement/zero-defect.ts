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

// What only a failed test run prints. The patterns below are tried on whole
// output, line by line (`m`). Each stays within one line and can match a
// stretch of text in one way only, so none is slow on long output.

// A failed test in TAP, which node:test prints when its output is piped, with
// a test number or a description. A result marked TODO or SKIP does not fail
// the run.
const TAP_FAILURE =
  /^[ \t]*not ok(?:[ \t]+\d+(?=[ \t]|$)|[ \t]+-[ \t])(?![^\n]*#[ \t]*(?:TODO|SKIP|todo|skip|Todo|Skip)\b)/m;

// node:test's closing count of failed tests, in TAP and in its spec reporter.
const NODE_FAILURE_COUNT = /^(?:#|ℹ) (?:fail|cancelled) [1-9]\d*\s*$/m;

// The spec reporter repeats timed failures in its recap. A TODO carries a note
// after the time, and other tools use the cross without a test duration.
const SPEC_FAILURE = /^[ \t]*✖ [^\n]*\(\d+(?:\.\d+)?ms\)[ \t\r]*$/;
// Successful results, TAP test titles and package-manager command echoes can
// quote any diagnostic, including an entire failing test.
const RESULT_METADATA = /^(?:[✓✔↓]\s|ok \d+\b|# Subtest: |PASS\s|\$ )/;
const PACKAGE_DIAGNOSTIC = /\b(?:FAIL(?:ED)?|ERROR)\b|\b[1-9]\d* failed\b/;

// The whole line pnpm ends with when the `test` script failed. For any other
// script it prints "Command failed with exit code N".
const PNPM_TEST_FAILED = /^[ \t]*\[?ELIFECYCLE\]?[^\S\r\n]+Test failed\. See above for more details\.[ \t]*$/m;

// A runner's own FAIL or FAILED line, which goes on to name a file.
const RUNNER_FAIL_LINE = /^[ \t]*(?:FAIL|FAILED)[ \t][^\n]*?(?:\/|\.[A-Za-z])/m;

// The summary line of vitest or jest, which puts the failed count first.
const RUNNER_SUMMARY = /^[ \t]*(?:Test Files|Test Suites|Tests):?[ \t]+[1-9]\d* failed(?=,|[ \t]*[|(])/m;

// Color codes, which a tool prints when color is forced on.
const COLOR_CODES = /\x1b\[[0-9;]*m/g;

const TEST_RUN_SIGNS = [RUNNER_FAIL_LINE, RUNNER_SUMMARY, TAP_FAILURE, SPEC_FAILURE, NODE_FAILURE_COUNT, PNPM_TEST_FAILED];

// How a command writes a color code (`\033[31m`).
const COLOR_NOTATION = /\\(?:033|e|x1[bB])\[[0-9;]*m/g;

// What prints a value: `$?`, a variable, a format such as `%d`. A brace ends
// before the next `$` or `{` and a width does not start with a zero, so that
// no stretch of text can be matched in two ways.
const PRINTED_VALUES = /\$\{[^}{$\n]*\}|\$\w+|\$\?|%[-+0#]*(?:[1-9]\d*)?(?:\.\d+)?[a-z]/g;

/**
 * Text made comparable with what a command says: no colors, quote marks,
 * backslashes or capitals, white space single (a written-out `\t` or `\n`
 * too), and every number alike. What prints a value in a command stands as a
 * number. A command and its output are read the same way, so a backslash that
 * a plain `echo` prints as it is written makes no difference.
 */
export function comparable(text: string): string {
  return text
    .replace(COLOR_CODES, '')
    .replace(COLOR_NOTATION, '')
    .replace(/\\[tn]/g, ' ')
    .replace(/[\\"']/g, '')
    .replace(PRINTED_VALUES, '0')
    .replace(/\d+/g, '0')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Whether output shows a test run that failed, in words only a test runner or
 * a package manager's test script prints. An `ERROR` line, a bare "1 failed"
 * or a bare "FAILED" is not such a sign: a build prints those too.
 *
 * `saidByCommand` is what the command the output came from says itself, made
 * comparable. A sign the command spells out is not counted: `npm run build &&
 * npm test || echo "FAILED - see build.log"` prints it whether or not the
 * tests ran. A runner's FAIL line is known by the word and the one after it,
 * the other signs by the text they match (`not ok 1`, `Tests: 1 failed`).
 */
export function showsFailedTestRun(output: string, saidByCommand = ''): boolean {
  return output.split('\n').some(line => isTestFailureLine(line, saidByCommand));
}

export function isTestFailureLine(rawLine: string, saidByCommand = ''): boolean {
  const line = rawLine.replace(COLOR_CODES, '');
  return TEST_RUN_SIGNS.some(sign => {
    const found = sign.exec(line);
    if (!found) return false;
    if (!saidByCommand) return true;
    const words = sign === RUNNER_FAIL_LINE ? line.trim().split(/\s+/).slice(0, 2).join(' ') : found[0];
    return !saidByCommand.includes(comparable(words));
  });
}

/**
 * Whether one line of output reads as a failure to this check: in the words
 * it has always looked for, or as a sign of a failed test run.
 */
export function readsAsFailure(line: string): boolean {
  return FAILURE_PATTERNS.some(p => p.test(line)) || isTestFailureLine(line);
}

// What a failed run closes with. The last such line is listed when the output
// names no failure, or when the lines that named them were cut off.
const CLOSING_LINE_PATTERNS = [NODE_FAILURE_COUNT, PNPM_TEST_FAILED, RUNNER_SUMMARY];

/**
 * The lines a message lists. With `testRunSigns`, a failed test run is read
 * in its own words too: each failure it names, or failing that the line the
 * run closed with.
 */
function failureLines(testOutput: string, testRunSigns: boolean): string[] {
  const named: string[] = [];
  let closing: string | undefined;
  let diagnostic: string | undefined;
  for (const rawLine of testOutput.split('\n')) {
    const line = testRunSigns ? rawLine.replace(COLOR_CODES, '').trim() : rawLine.trim();
    if (testRunSigns && RESULT_METADATA.test(line)) continue;
    // TAP directives and the spec reporter's TODO annotation decide the
    // result even when the test name itself contains an error message.
    if (testRunSigns && /^not ok[ \t]/.test(line)) {
      if (TAP_FAILURE.test(line)) named.push(line);
      continue;
    }
    if (testRunSigns && line.startsWith('✖ ')) {
      if (SPEC_FAILURE.test(line) && !named.includes(line)) named.push(line);
      continue;
    }
    if (FAILURE_LINE_PATTERNS.some(p => p.test(rawLine))) {
      named.push(line);
      continue;
    }
    if (!testRunSigns) continue;
    if (RUNNER_FAIL_LINE.test(line)) {
      named.push(line);
    } else if (CLOSING_LINE_PATTERNS.some(p => p.test(line))) {
      closing = line;
    } else if (!diagnostic && PACKAGE_DIAGNOSTIC.test(rawLine)) {
      diagnostic = line;
    }
  }
  if (named.length) return named;
  const fallback = closing ?? diagnostic;
  return fallback ? [fallback] : [];
}

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
export function classifyFailures(
  testOutput: string,
  changedFiles: string[],
  testRunSigns = false,
): ClassifiedFailure {
  return classifyLines(failureLines(testOutput, testRunSigns), changedFiles);
}

function classifyLines(failures: string[], changedFiles: string[]): ClassifiedFailure {
  const regressions: string[] = [];
  const preExisting: string[] = [];

  for (const line of failures) {
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
 *
 * With `testRunSigns`, a failed test run is also read in its own words (see
 * showsFailedTestRun). That is for output known to be a test run's: a
 * node:test run fails without any of the words this check looks for otherwise.
 */
export function checkZeroDefect(
  testOutput: string,
  config: HarnessConfig,
  changedFiles?: string[],
  currentPhase?: string | null,
  testRunSigns = false,
): EnforcementViolation | null {
  const tolerance = config.rules.zero_defect?.tolerance ?? 'strict';
  const unrelatedErrors = config.rules.zero_defect?.unrelated_errors ?? 'block';

  if (!testRunSigns && !FAILURE_PATTERNS.some(p => p.test(testOutput))) return null;
  const failures = failureLines(testOutput, testRunSigns);
  if (testRunSigns && !failures.length) return null;

  // During tdd+/sdd+, failing tests are expected (RED). Cap the level at
  // advisory so the loop isn't blocked on every RED run; the message formatters
  // derive their level from this effective tolerance.
  const inScopedPhase = currentPhase != null && SCOPED_PHASES.includes(currentPhase);
  const effectiveTolerance = inScopedPhase ? 'permissive' : tolerance;

  // No changed files provided — use original behavior
  if (!changedFiles) {
    return formatViolation(failures, effectiveTolerance);
  }

  // Classify failures
  const { regressions, preExisting } = classifyLines(failures, changedFiles);

  // No regressions — check pre-existing handling
  if (regressions.length === 0) {
    if (unrelatedErrors === 'silent' || preExisting.length === 0) return null;
    if (unrelatedErrors === 'advise') {
      return formatPreExistingMessage(preExisting);
    }
    // block: fall through to format all as violations
    return formatViolation(failures, effectiveTolerance);
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

function formatViolation(failures: string[], tolerance: string): EnforcementViolation {
  const level = tolerance === 'strict' ? 'block' : 'advise';
  const prefix = level === 'block' ? '[BLOCK]' : '[ADVISE]';

  return {
    level,
    message: [
      `${prefix} ZERO-DEFECT VIOLATION`,
      '',
      `${failures.length} failure(s) found:`,
      ...failures.slice(0, 10).map(l => `  ${l}`),
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

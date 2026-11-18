import { resolve } from 'node:path';
import { FileTracker } from './file-tracker.js';
import { SessionCache } from '../session/cache.js';
import type { EnforcementViolation, HarnessConfig } from '../types.js';
import { checkStaleTests, staleSetKey } from './stale-test.js';
import { checkConstitutional } from './constitutional.js';
import { checkZeroDefect } from './zero-defect.js';
import {
  incrementMetric,
  captureExternalGraphifyStats,
  captureGraphifyStatsViaReport,
} from '../session/metrics.js';
import type { ExecFn } from '../session/metrics.js';

/**
 * Extract a Bash command's output from the PostToolUse payload.
 *
 * Claude Code delivers command output in `tool_response` — either a plain
 * string or an object carrying `stdout`/`stderr` (joined here because test
 * runners routinely report failures on stderr). `tool_input.output` is kept
 * as a fallback for older harnesses and hand-built fixtures; it is never
 * populated by current Claude Code payloads.
 */
export function extractBashOutput(
  toolResponse: unknown,
  args: Record<string, unknown>,
): string | undefined {
  if (typeof toolResponse === 'string' && toolResponse.length > 0) {
    return toolResponse;
  }
  if (toolResponse && typeof toolResponse === 'object') {
    const response = toolResponse as Record<string, unknown>;
    const parts = [response.stdout, response.stderr].filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );
    if (parts.length > 0) return parts.join('\n');
  }
  const legacy = args.output;
  return typeof legacy === 'string' && legacy.length > 0 ? legacy : undefined;
}

/**
 * PostToolUse hook handler. Composes all enforcement checks.
 * Returns null if all clean, or a combined violation whose level is derived
 * from the checks themselves (any block-level violation → 'block') — never
 * from message text, which can embed arbitrary tool output.
 *
 * `toolResponse` is the hook payload's `tool_response` field — the real
 * channel for command output (see extractBashOutput).
 */
export function handlePostToolUse(
  tool: string,
  args: Record<string, unknown>,
  tracker: FileTracker,
  cache: SessionCache,
  config: HarnessConfig,
  execFn?: ExecFn,
  toolResponse?: unknown,
): EnforcementViolation | null {
  // Batch every cache mutation this invocation makes (turn counter,
  // edited-file sets, turn-stamped history, stale key, metric counters) into a
  // single session-cache file write instead of one write per setter.
  return cache.transaction(() =>
    runPostToolChecks(tool, args, tracker, cache, config, execFn, toolResponse),
  );
}

// The runner names this check has always looked for anywhere in a command.
// One case no longer counts: a runner name inside a file name that carries an
// extension (`check-vitest-config.cjs`, `vitest.config.ts`) names a file, not
// a test run. An extension starts with a letter, so the versioned binary
// `pytest-3.12` is still a runner. A runner's own launcher file (`vitest.mjs`,
// `jest.js`, `vitest.cmd`) still counts too.
const TEST_RUNNER =
  /(?:vitest|jest|pytest|mocha)(?![\w-]*\.[A-Za-z])|(?<![\w.-])(?:vitest|jest|pytest|mocha)\.(?:[cm]?js|cmd|exe|ps1|bat|sh)(?![\w.-])/;

// A package manager's test script (`npm test`, `npm run test`, and the same
// for pnpm, yarn and bun) that starts the command or one of its `&&`, `||`,
// `;`, `|` or newline steps, after any VAR=value prefixes, with any arguments.
// The first group is what stands before the step: nothing when the script is
// the first thing the command runs.
const PACKAGE_TEST_SCRIPT =
  /(^|&&|\|\||[;|\n])[ \t]*(?:\w+=[^\s;|&<>]*[ \t]+)*(?:npm|pnpm|yarn|bun)[ \t]+(?:run[ \t]+)?test(?=$|[\s;|&<>])/;

// Shell syntax that can hold text which never runs as a command: substitutions,
// comments, escapes, subshells, heredocs.
const UNREAD_SHELL_SYNTAX = /[`$#\\()]|<</;

// The line npm prints before it runs the test script: `> demo@1.0.0 test`, or
// `> test` for a package with no name.
const TEST_SCRIPT_LINE = /^> \S*@\S* test(?=\s|$)|^> test\r?$/m;

// What shows, where that line is missing, that tests ran and failed: a FAIL or
// FAILED line, a failed count in a runner's own summary line, a failing TAP
// result or node:test's count of failures, or the line pnpm ends with when the
// test script failed. A bare "1 failed" is not enough: a build prints that too.
const FAILED_TEST_RUN =
  /^\s*(?:FAIL|FAILED)\s|^\s*(?:Test Files|Test Suites|Tests):?\s.*\b[1-9]\d* failed\b|^\s*not ok \d+(?!.*# (?:TODO|SKIP))|^# fail [1-9]|^ℹ fail [1-9]|ELIFECYCLE\W+Test failed\b/m;

// Leading `cd dir &&` steps. They only say where what follows runs: a `cd`
// prints nothing unless it fails, and then nothing after `&&` starts.
const DIRECTORY_CHANGES = /^(?:cd[ \t]+[^\s;|&<>]+[ \t]*(?:&&|[;\n])[ \t]*)+/;

/**
 * Find a package manager's test script in a Bash command. `first` says whether
 * it is the first thing the command runs, directory changes aside.
 *
 * This is a bounded pattern, not a shell parser. A quoted word stays a word,
 * but its text is not read: `npm run "build" test` runs the build script, and
 * a commit message can mention `npm test`. A script that follows syntax the
 * pattern cannot read is left alone; what comes after the script
 * (`; echo $?`, a comment) does not matter.
 */
function findPackageTestScript(command: string): { first: boolean } | null {
  const text = command
    // Double quotes around a command substitution can hold quotes of their
    // own (`"$(cat <<'EOF' ... "x" ... EOF)"`), so where such a word ends is
    // not known: it becomes syntax the pattern cannot read.
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, word => (/^"[^]*(?:\$\(|`)/.test(word) ? '$' : '""'))
    .trimStart()
    .replace(DIRECTORY_CHANGES, '');
  const script = PACKAGE_TEST_SCRIPT.exec(text);
  if (!script || UNREAD_SHELL_SYNTAX.test(text.slice(0, script.index + script[0].length))) return null;
  return { first: script[1] === '' };
}

/**
 * Whether a Bash command runs tests: it names a test runner, or it calls a
 * package manager's test script.
 */
export function isTestCommand(command: string): boolean {
  return TEST_RUNNER.test(command) || findPackageTestScript(command) !== null;
}

/**
 * The part of a command's output that came from its test run, or null when no
 * test run shows in it.
 *
 * A command that names a runner is read whole, as it always was, and so is
 * one that starts with a package test script. A package test script behind an
 * earlier step (`npm run build && npm test`) only runs if that step lets it,
 * and the step prints output of its own. Its test run is read from the line
 * npm prints for the script. Where that line is missing (cut off by `| tail`,
 * or a package manager that prints none), the output counts only if it shows
 * a failed test run.
 */
function testRunOutput(command: string, output: string): string | null {
  if (TEST_RUNNER.test(command)) return output;
  const script = findPackageTestScript(command);
  if (!script) return null;
  if (script.first) return output;
  const scriptLine = TEST_SCRIPT_LINE.exec(output);
  if (scriptLine) return output.slice(scriptLine.index);
  return FAILED_TEST_RUN.test(output) ? output : null;
}

function checkTestCommandOutput(
  command: string,
  output: string | undefined,
  cache: SessionCache,
  config: HarnessConfig,
): EnforcementViolation | null {
  if (typeof command !== 'string' || !output) return null;
  const testOutput = testRunOutput(command, output);
  if (testOutput === null) return null;
  const changedFiles = cache.getChangedFiles();
  return checkZeroDefect(
    testOutput,
    config,
    changedFiles.length > 0 ? changedFiles : undefined,
    cache.getCurrentPhase(),
  );
}

/**
 * PostToolUseFailure handler. A failed Bash call carries its output in the
 * payload's `error` field. Runs only the zero-defect check and writes nothing
 * to the session cache, so a failed Edit or Write is never tracked as an edit.
 */
export function handlePostToolUseFailure(
  tool: string,
  args: Record<string, unknown>,
  error: unknown,
  cache: SessionCache,
  config: HarnessConfig,
): EnforcementViolation | null {
  if (tool !== 'Bash' || typeof error !== 'string' || !error) return null;
  return checkTestCommandOutput(args.command as string, error, cache, config);
}

function runPostToolChecks(
  tool: string,
  args: Record<string, unknown>,
  tracker: FileTracker,
  cache: SessionCache,
  config: HarnessConfig,
  execFn?: ExecFn,
  toolResponse?: unknown,
): EnforcementViolation | null {
  const metric = incrementMetric(tool, args);
  if (metric) {
    cache.incrementMetricCounter(metric);
  }

  const violations: EnforcementViolation[] = [];

  // Track skill-chain phase transitions so other hooks (e.g. the PreToolUse
  // test-scope check) can read the current phase from the session cache.
  if (tool === 'Skill') {
    const phase = skillToPhase(args.skill);
    if (phase) {
      // Entering a scoped-execution phase from a different phase (or none)
      // starts a new feature: clear the edit history so test-scope
      // suggestions don't accumulate every file edited all session.
      // Re-entering the same phase keeps the in-progress feature's edits.
      if (SCOPED_PHASES.includes(phase) && cache.getCurrentPhase() !== phase) {
        cache.clearEditedFiles();
      }
      cache.setPhase(phase);
    }
  }

  // Track file edits
  if (tool === 'Edit' || tool === 'Write') {
    const filePath = args.file_path as string;

    // Cross-process turn model: hooks run as separate processes, so the
    // FileTracker arrives empty and its in-memory turn counter never
    // advances — which made the creation-turn exemption apply forever and
    // left the stale-test check dormant. A "turn" is one PostToolUse
    // Edit/Write invocation: the counter and the turn-stamped edit history
    // persist in the session cache. An empty tracker (the real hook case)
    // is hydrated from history; a tracker that already carries edits
    // (same-process reuse in unit tests) is left intact to avoid duplicates.
    const turn = cache.advanceEditTurn();
    if (tracker.getSourceEdits().length === 0 && tracker.getTestEdits().length === 0) {
      for (const edit of cache.getEditHistory()) {
        tracker.setTurn(edit.turn);
        tracker.recordEdit(edit.file);
      }
    }
    // Never rewind: a same-process tracker may have advanced its own turn
    // (nextTurn) past the cache counter; the effective turn is the max.
    tracker.setTurn(Math.max(turn, tracker.getTurn()));

    if (filePath) {
      tracker.recordEdit(filePath);

      // Persist to the session cache: hooks run as separate processes, so the
      // in-memory FileTracker resets between invocations. The cache is what
      // lets the PreToolUse test-scope check and the stale-test turn model
      // see prior edits.
      const category = tracker.classifyFile(filePath);
      if (category === 'source' || category === 'test') {
        cache.addEditedFile(filePath, category);
        cache.recordEditTurn(filePath, turn);
      }

      // Constitutional check on edited test files. Edit delivers the inserted
      // text in `new_string`; Write delivers the full file body in `content`.
      // Read both or Write-created files skip the check entirely.
      const content = (args.content as string) ?? (args.new_string as string) ?? '';
      const constitutional = checkConstitutional(filePath, content, config);
      if (constitutional) violations.push(constitutional);
    }

    // Stale test check — gated on a change to the stale source-file set so an
    // unchanged (often growing) list is not re-emitted on every Edit/Write.
    // updateStaleKey runs on every Edit/Write to track transitions, including
    // the set clearing to empty (which resets the dedup so a later relapse
    // re-fires); checkStaleTests still returns null when nothing is stale.
    if (cache.updateStaleKey(staleSetKey(tracker, config))) {
      const stale = checkStaleTests(tracker, config);
      if (stale) violations.push(stale);
    }
  }

  // Zero-defect check on test command output
  if (tool === 'Bash') {
    const output = extractBashOutput(toolResponse, args);
    const zeroDefect = checkTestCommandOutput(args.command as string, output, cache, config);
    if (zeroDefect) violations.push(zeroDefect);
  }

  // Capture graphify stats for external directories accessed via jcodemunch
  // or built directly with `graphify update` in Bash
  const external = extractExternalDirectory(tool, args);
  if (external && execFn) {
    try {
      // The Bash trigger fires right after `graphify update` completed — read
      // the report directly instead of re-checking/re-building the graph.
      const stats = external.source === 'bash'
        ? captureGraphifyStatsViaReport(external.dir, execFn)
        : captureExternalGraphifyStats(external.dir, execFn);
      if (stats) {
        cache.setGraphifyStats(resolve(external.dir), stats);
      }
    } catch {
      // graphify not available — skip silently
    }
  }

  if (violations.length === 0) return null;

  // Combine violations: level is the max severity across the checks.
  return {
    level: violations.some(v => v.level === 'block') ? 'block' : 'advise',
    message: violations.map(v => v.message).join('\n\n---\n\n'),
  };
}

/** Phases whose entry resets the edited-file history (scoped test execution).
 * Mirrors SCOPED_PHASES in test-scope.ts — both must list the phases where
 * test runs are scoped to the current feature's edits. */
const SCOPED_PHASES = ['tdd+', 'sdd+'];

/** Skill-name → skill-chain phase. Keys cover the installed skill directory
 * names plus the bare phase aliases. `investigate` is an alias for debug+.
 * Must stay in sync with PHASE_ORDER in src/skills/phase-tracker.ts — every
 * chain phase needs a reachable skill name here (enforced by a sync test). */
export const SKILL_PHASE_MAP: Record<string, string> = {
  'brain-plus': 'brain+',
  'plan-plus': 'plan+',
  'tdd-plus': 'tdd+',
  'sdd-plus': 'sdd+',
  'verify-plus': 'verify+',
  'review-plus': 'review+',
  'debug-plus': 'debug+',
  'investigate': 'debug+',
  'brain+': 'brain+',
  'plan+': 'plan+',
  'tdd+': 'tdd+',
  'sdd+': 'sdd+',
  'verify+': 'verify+',
  'review+': 'review+',
  'debug+': 'debug+',
};

/** Map a Skill tool invocation's skill name to a chain phase, stripping any
 * plugin namespace prefix (`my-plugin:tdd-plus` → `tdd-plus`). */
function skillToPhase(skill: unknown): string | null {
  if (typeof skill !== 'string') return null;
  const bare = skill.split(':').pop() ?? '';
  return SKILL_PHASE_MAP[bare] ?? null;
}

const BASH_GRAPHIFY_UPDATE = /\bgraphify(?:y)?\s+update\s+(?:"([^"]+)"|'([^']+)'|(\S+))/;

/**
 * Extract an external (non-CWD) directory path from jcodemunch tool calls or
 * a Bash `graphify update <dir>` command. Returns null for CWD paths or
 * unrecognized tools. The source distinguishes the just-built Bash case
 * (read report directly) from MCP indexing (may need a build first).
 */
function extractExternalDirectory(
  tool: string,
  args: Record<string, unknown>,
): { dir: string; source: 'mcp' | 'bash' } | null {
  let directory: string | undefined;
  let source: 'mcp' | 'bash' = 'mcp';

  if (tool === 'mcp__jcodemunch__index_folder') {
    directory = (args.path as string) ?? (args.folder_path as string);
  } else if (tool === 'mcp__jcodemunch__resolve_repo') {
    directory = args.path as string;
  } else if (tool === 'Bash' && typeof args.command === 'string') {
    const match = args.command.match(BASH_GRAPHIFY_UPDATE);
    if (match) {
      directory = match[1] ?? match[2] ?? match[3];
      source = 'bash';
    }
  }

  if (!directory) return null;
  const cwd = process.cwd();
  if (directory.startsWith(cwd)) return null;
  return { dir: directory, source };
}

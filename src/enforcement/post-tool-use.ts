import { resolve } from 'node:path';
import { FileTracker } from './file-tracker.js';
import { SessionCache } from '../session/cache.js';
import type { EnforcementViolation, HarnessConfig } from '../types.js';
import { checkStaleTests, staleSetKey } from './stale-test.js';
import { checkConstitutional } from './constitutional.js';
import { checkZeroDefect, comparable, readsAsFailure, showsFailedTestRun } from './zero-defect.js';
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

// Shell syntax that can hold text which never runs as a command: substitutions
// and expansions, escapes, subshells, heredocs.
const UNREAD_SHELL_SYNTAX = /[`$\\()]|<</;

// Quoted words and comments, found left to right in one pass, so that a `#`
// inside quotes is no comment and a quote inside a comment opens no word. A
// comment starts where a word could: `build#5` and a URL fragment are none.
const QUOTED_OR_COMMENT = /"(?:[^"\\]|\\.)*"|'[^']*'|(?<![^\s;&|()<>])#[^\n]*/g;

// A directory `cd` can be given without running anything: path characters, a
// quoted word, `$DIR` or `${DIR}`. The `$` and the name after it are matched
// apart, so that no text can be matched in two ways.
const PLAIN_DIRECTORY = String.raw`(?:""|\$\{\w+\}|\$(?=\w)|[\w./~+@%:=,-])+`;

// Leading `cd dir &&` steps. They only say where what follows runs: a `cd`
// prints nothing unless it fails, and then nothing after `&&` starts.
const DIRECTORY_CHANGES = new RegExp(String.raw`^(?:cd[ \t]+${PLAIN_DIRECTORY}[ \t]*(?:&&|[;\n])[ \t]*)+`);

// A step sent to the background (`&`, as opposed to `&&`, `2>&1` and `|&`)
// writes while the steps after it run. With `set -x` the shell prints every
// command it runs.
const WRITES_ALONGSIDE = /(?<![>&|])&(?![>&])|\bset[ \t]+[-+](?:\w*[xv]|o[ \t]+(?:xtrace|verbose))/;

// The steps of a command, each cut out at `&&`, `||`, `;` or a new line.
// One that prints nothing, or only its own words (no substitution, no pipe):
const QUIET_STEP = new RegExp(
  String.raw`^(?:true|exit(?:[ \t]+(?:\d+|\$[\w?]+))?|:|wait|set[ \t]+[-+][eu]+|\w+=[^\s|\`()]*|cd[ \t]+${PLAIN_DIRECTORY}|(?:echo|printf)(?=$|\s)[^|\`()]*)$`,
);
// another package test script, which is a test run as well:
const TEST_SCRIPT_STEP = /^(?:\w+=[^\s|<>`()]*[ \t]+)*(?:npm|pnpm|yarn|bun)[ \t]+(?:run[ \t]+)?test(?=$|[\s<>|])/;
// and an npm script by name with nothing but arguments of its own. npm prints
// a line for it when it starts. With an npm flag or setting, a pipe or a
// redirection that line may never reach the output.
const NPM_SCRIPT_STEP = /^npm[ \t]+run(?:-script)?[ \t]+([\w@][\w:.@/-]*)(?:[ \t]+--(?:[ \t][^|<>`()]*)?)?$/;

interface PackageTestRun {
  /** Nothing but directory changes runs before the script. */
  first: boolean;
  /** An earlier step runs the pretest script by name. */
  pretestBefore: boolean;
  /** Later steps that are npm scripts by name: each one that starts prints a line. */
  laterScripts: string[];
  /**
   * Something else in the command can write to the output once the tests have
   * started, and no line marks where: a step that is none of the kinds above,
   * a program the test output is piped into, a step in the background.
   */
  unmarked: boolean;
}

/**
 * Whether a program in a pipe only passes on or drops the lines it is given:
 * `tail -5`, `grep -v pattern`, `tee out.log`. Given a file to read, or made
 * to rewrite the text (`sed`, `tr`), it prints text of its own.
 */
function isOutputFilter(program: string): boolean {
  const [name, ...words] = program.trim().replace(/\d*>>?&?[ \t]*\S*/g, ' ').trim().split(/\s+/);
  const operands = words.filter(word => !/^-|^[+-]?\d+$/.test(word)).length;
  if (/^(?:tail|head|cat|sort|uniq|wc|nl|tac|less|more)$/.test(name)) return operands === 0;
  // With -r or -f, grep reads files of its own.
  if (/^(?:grep|egrep|fgrep|rg)$/.test(name)) return operands === 1 && !words.some(word => /^-\w*[rRf]|^--(?:recursive|file)/.test(word));
  return name === 'tee';
}

/**
 * Whether a step can print more than its own command does: through a
 * substitution, or through a pipe into a program that is no filter.
 */
function printsMoreThanItsOwn(step: string): boolean {
  return /[`(]/.test(step) || step.split(/\|&?/).slice(1).some(program => !isOutputFilter(program));
}

/**
 * Find a package manager's test script in a Bash command, and what runs
 * around it.
 *
 * This is a bounded pattern, not a shell parser. A quoted word stays a word,
 * but its text is not read: `npm run "build" test` runs the build script, and
 * a commit message can mention `npm test`. A script that follows syntax the
 * pattern cannot read is left alone.
 */
function findPackageTestScript(command: string): PackageTestRun | null {
  // A command this long is no test run somebody typed.
  if (command.length > 10_000) return null;
  const text = command
    // Comments go, and a quoted word becomes `""`. Double quotes around a
    // command substitution can hold quotes of their own
    // (`"$(cat <<'EOF' ... "x" ... EOF)"`), so where such a word ends is not
    // known. It becomes a backtick: syntax the pattern cannot read, and no
    // directory a plain `cd` can be given.
    .replace(QUOTED_OR_COMMENT, part => (part[0] === '#' ? '' : /^"[^]*(?:\$\(|`)/.test(part) ? '`' : '""'))
    .trimStart()
    .replace(DIRECTORY_CHANGES, '');
  const script = PACKAGE_TEST_SCRIPT.exec(text);
  if (!script) return null;
  const before = text.slice(0, script.index);
  if (UNREAD_SHELL_SYNTAX.test(before + script[0])) return null;
  // First comes the rest of the test script's own step: arguments,
  // redirections, pipes.
  const after = text.slice(script.index + script[0].length);
  const [ownStep, ...laterSteps] = after.split(/&&|\|\||[;\n]/);
  const run: PackageTestRun = {
    first: script[1] === '',
    pretestBefore: /\bpretest\b/.test(before),
    laterScripts: [],
    // An escaped quote, a `$'...'` word or a heredoc can hide a step from the
    // pass above inside what it took for a quoted word.
    unmarked: WRITES_ALONGSIDE.test(text) || /\\|\$"|<</.test(after) || printsMoreThanItsOwn(ownStep),
  };
  for (const step of laterSteps.map(part => part.trim())) {
    if (step === '' || QUIET_STEP.test(step)) continue;
    if (TEST_SCRIPT_STEP.test(step) && !printsMoreThanItsOwn(step)) continue;
    const byName = NPM_SCRIPT_STEP.exec(step);
    if (byName) run.laterScripts.push(byName[1]);
    else run.unmarked = true;
  }
  return run;
}

/**
 * Whether a Bash command runs tests: it names a test runner, or it calls a
 * package manager's test script.
 */
export function isTestCommand(command: string): boolean {
  return TEST_RUNNER.test(command) || findPackageTestScript(command) !== null;
}

/**
 * Where the lines npm prints before it runs a script begin in output:
 * `> demo@1.0.0 test`, or `> test` for a package with no name.
 */
function scriptLines(output: string, script: string): number[] {
  const name = script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = new RegExp(`^> (?:[^\\s@]*@\\S* ${name}(?=\\s|$)|${name}\\r?$)`, 'gm');
  return Array.from(output.matchAll(line), found => found.index);
}

// What Claude Code leaves in the middle of an output it cut short.
const CUT_SHORT = /\[\d+ characters truncated\]/;

/**
 * A Bash command's output. `stderr` is set only when it arrived apart from
 * stdout: where its lines fall among stdout's is then not known.
 */
interface BashOutput {
  text: string;
  stderr?: string;
}

function readBashOutput(toolResponse: unknown, args: Record<string, unknown>): BashOutput | undefined {
  if (toolResponse && typeof toolResponse === 'object') {
    const { stdout, stderr } = toolResponse as Record<string, unknown>;
    if (typeof stdout === 'string' && stdout && typeof stderr === 'string' && stderr) {
      return { text: stdout, stderr };
    }
  }
  const text = extractBashOutput(toolResponse, args);
  return text === undefined ? undefined : { text };
}

/**
 * What a command says itself, made comparable with its output (see
 * `comparable`). A comment says nothing. Neither does the step that runs the
 * test script, where the test run is all it can print: its arguments and the
 * patterns of its filters never reach the output
 * (`npm test -- -t "failed login" 2>&1 | grep "FAIL  tests/sum.test.ts"`).
 */
function saidBy(command: string): string {
  const written = command.replace(QUOTED_OR_COMMENT, part => (part[0] === '#' ? ' '.repeat(part.length) : part));
  // The same with quoted words filled in, their length kept, so that a step
  // ends where it does in the command as written. A word that may hold a
  // substitution is filled with what marks one.
  const filled = written.replace(QUOTED_OR_COMMENT, part => (/^"[^]*(?:\$\(|`)/.test(part) ? '`' : 'q').repeat(part.length));
  const script = PACKAGE_TEST_SCRIPT.exec(filled);
  if (!script) return comparable(written);
  const start = script.index + script[1].length;
  const stepEnd = filled.slice(start).search(/&&|\|\||[;\n]/);
  const end = stepEnd === -1 ? filled.length : start + stepEnd;
  const afterScript = filled.slice(script.index + script[0].length, end);
  return comparable(printsMoreThanItsOwn(afterScript) ? written : `${written.slice(0, start)} ${written.slice(end)}`);
}

/**
 * Output without the lines that read as a failure and that the command spells
 * out itself. After a passing run `npm test; echo "FAILED=$?"` prints
 * `FAILED=0`, however the words are printed (an `echo` in braces, `printf`,
 * `>&2`). Every other line stays, whatever the command holds: the line npm
 * prints for a script (`> lint`) among them. Looking a line up in a long
 * command takes time, and few lines of a long output read as a failure.
 */
function withoutOwnWords(output: string, said: string): string {
  return output
    .split('\n')
    .filter(line => !(readsAsFailure(line) && said.includes(comparable(line))))
    .join('\n');
}

/**
 * The part of a command's output that came from its test run, or null when no
 * test run shows in it.
 *
 * A command that names a runner is read whole, as it always was. So is a
 * package test script that nothing else in the command can write around,
 * apart from the lines the command spells out itself, which are left out.
 *
 * Otherwise other steps print into the same output, and some of them may not
 * have run at all (`npm run build && npm test && npm run lint`). The test run
 * is then cut out at the lines npm prints for its scripts: it starts at the
 * first `pretest` or `test` line and ends at the first line of an npm script
 * that comes later in the command. A later script that prints no such line
 * did not start.
 *
 * That holds only while every line is there and nothing writes without one.
 * Where it does not hold (the start cut off by `| tail`, a package manager
 * that prints no lines, a later step that is no plain npm script, output cut
 * in the middle), what is left counts only if it shows a failed test run, in
 * words the command does not hold itself. Output on a separate stderr is read
 * with the test run on the same condition.
 */
function testRunOutput(command: string, output: BashOutput): string | null {
  if (TEST_RUNNER.test(command)) {
    return output.stderr === undefined ? output.text : `${output.text}\n${output.stderr}`;
  }
  const run = findPackageTestScript(command);
  if (!run) return null;
  const said = saidBy(command);
  const text = withoutOwnWords(output.text, said);
  const stderr = output.stderr === undefined ? undefined : withoutOwnWords(output.stderr, said);
  if (run.first && !run.unmarked && run.laterScripts.length === 0) {
    return stderr === undefined ? text : `${text}\n${stderr}`;
  }

  // The lines npm printed for the test script and for a pretest script before
  // it. Where an earlier step runs pretest by name, a pretest line may be
  // that step's.
  const lifecycle = [...(run.pretestBefore ? [] : scriptLines(text, 'pretest')), ...scriptLines(text, 'test')];
  const cutOut = !run.unmarked && lifecycle.length > 0 && !CUT_SHORT.test(text);
  const start = run.first || lifecycle.length === 0 ? 0 : Math.min(...lifecycle);
  const later = run.laterScripts
    .flatMap(script => [...scriptLines(text, `pre${script}`), ...scriptLines(text, script)])
    .filter(at => at > start);
  // A test script can run one of the later scripts itself, before its tests.
  // That line is no end: failing tests follow it.
  const end = later.length > 0 && !showsFailedTestRun(text.slice(Math.min(...later)), said) ? Math.min(...later) : text.length;
  const testRun = text.slice(start, end);
  const failed = showsFailedTestRun(testRun, said) || (stderr !== undefined && showsFailedTestRun(stderr, said));
  if (!cutOut && !failed) return null;
  return failed && stderr !== undefined ? `${testRun}\n${stderr}` : testRun;
}

function checkTestCommandOutput(
  command: string,
  output: BashOutput | undefined,
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
    // A command that names a runner is checked exactly as it always was. The
    // output of a package test script is also read for what only a failed
    // test run prints.
    !TEST_RUNNER.test(command),
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
  return checkTestCommandOutput(args.command as string, { text: error }, cache, config);
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
    const output = readBashOutput(toolResponse, args);
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

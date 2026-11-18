import { comparable, isTestFailureLine, readsAsFailure, showsFailedTestRun } from './zero-defect.js';

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
const PLAIN_DIRECTORY = String.raw`(?:"|\$\{\w+\}|\$(?=\w)|[\w./~+@%:=,-])+`;

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

// Includes package-manager flags before `run`, for example `npm --prefix . run pretest`.
const EXPLICIT_PRETEST = /(?:^|[;&|\n])[ \t]*(?:\w+=[^\s;&|]*[ \t]+)*(?:npm|pnpm|yarn|bun)[ \t]+(?:[^;&|\n]*?\brun(?:-script)?[ \t]+)?pretest(?=$|[\s;&|<>])/;

interface PackageTestRun {
  /** A successful foreground && chain requires the test script to exit zero. */
  requiresTestSuccess: boolean;
  /** Words other steps may print, compared with apparent failures in the transcript. */
  said: string;
  /** Nothing but directory changes runs before the script. */
  first: boolean;
  /** An earlier step runs the pretest script by name. */
  pretestBefore: boolean;
  /** Ordered script invocations. A directory change can select a different .npmrc. */
  scripts: { name: string; directory: number }[];
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
  // Keep offsets into the original arguments. A quoted substitution masks a
  // directory as computed; other quoted words cannot introduce a shell step.
  const written = command.replace(QUOTED_OR_COMMENT, part => part[0] === '#' ? ' '.repeat(part.length) : part);
  const masked = written.replace(QUOTED_OR_COMMENT, part =>
    (/^"[^]*(?:\$\(|`)/.test(part) ? '`' : '"').repeat(part.length));
  const text = masked.trimStart().replace(DIRECTORY_CHANGES, '');
  const script = PACKAGE_TEST_SCRIPT.exec(text);
  if (!script) return null;
  const before = text.slice(0, script.index);
  if (UNREAD_SHELL_SYNTAX.test(before + script[0])) return null;
  // First comes the rest of the test script's own step: arguments,
  // redirections, pipes.
  const after = text.slice(script.index + script[0].length);
  const [ownStep, ...laterSteps] = after.split(/&&|\|\||[;\n]/);
  const start = masked.length - text.length + script.index;
  const end = start + script[0].length + ownStep.length;
  const mixedPipe = printsMoreThanItsOwn(ownStep);
  const run: PackageTestRun = {
    requiresTestSuccess: !/[;|&\n]/.test(text.replaceAll('&&', '')),
    said: comparable(mixedPipe ? written : written.slice(0, start) + ' ' + written.slice(end)),
    first: script[1] === '',
    pretestBefore: EXPLICIT_PRETEST.test(before),
    scripts: [{ name: 'test', directory: 0 }],
    // An escaped quote, a `$'...'` word or a heredoc can hide a step from the
    // pass above inside what it took for a quoted word.
    unmarked: WRITES_ALONGSIDE.test(text) || /\\|\$"|<</.test(after) || mixedPipe,
  };
  let directory = 0;
  for (const step of laterSteps.map(part => part.trim())) {
    if (step === '' || QUIET_STEP.test(step)) {
      if (/^cd[ \t]/.test(step)) directory++;
      continue;
    }
    if (TEST_SCRIPT_STEP.test(step) && !printsMoreThanItsOwn(step)) {
      run.scripts.push({ name: 'test', directory });
      continue;
    }
    const byName = NPM_SCRIPT_STEP.exec(step);
    if (byName) run.scripts.push({ name: byName[1], directory });
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

// npm prints `> name@version script` (or just `> script`), then echoes the
// expanded command on the next `> ` line. Only the first line identifies a script.
const SCRIPT_BANNER = /^> (?:[^\s@]*@\S* ([\w@./:-]+)(?=\s|$)|([\w@./:-]+)\r?$)/;

// What Claude Code leaves in the middle of an output it cut short.
const CUT_SHORT = /\[\d+ characters truncated\]/;

/** Split the transcript at the npm scripts that the command can actually run. */
function scriptSections(lines: string[], run: PackageTestRun) {
  const sections: { step: number; lines: string[] }[] = [{ step: -1, lines: [] }];
  let current = sections[0];
  let sawMainScript = false;
  let commandEcho = false;
  for (const line of lines) {
    if (line.startsWith('> ')) {
      // npm echoes arguments such as --test-name-pattern=ERROR. An echoed
      // executable can even have the same name as the following npm script.
      if (commandEcho) continue;
      const banner = SCRIPT_BANNER.exec(line);
      if (banner) {
        commandEcho = true;
        const name = banner[1] ?? banner[2];
        if (current.step < 0 && name !== 'test' && (name !== 'pretest' || run.pretestBefore)) continue;
        // After the main banner, a new pre/main banner can start the next
        // invocation. When there is none, this is still the same workspace run.
        const from = sawMainScript && name !== 'post' + run.scripts[current.step].name ? current.step + 1 : current.step;
        const step = run.scripts.findIndex((script, index) => index >= from &&
          (name === script.name || name === 'pre' + script.name || name === 'post' + script.name));
        if (step >= 0 && step !== current.step) {
          current = { step, lines: [] };
          sections.push(current);
          sawMainScript = false;
        }
        if (current.step >= 0 && name === run.scripts[current.step].name) sawMainScript = true;
        continue;
      }
    }
    commandEcho = false;
    current.lines.push(line);
  }
  return sections;
}

/** Package-script diagnostics must belong to the test step. In a shared
 * stream with no reliable boundary, only a reporter can identify a failure. */
function packageTestOutput(run: PackageTestRun, text: string, separateStderr: string | undefined, succeeded: boolean): string {
  const { said } = run;
  const linesOf = (text: string) => text.split('\n').filter(line =>
    !(said && readsAsFailure(line) && said.includes(comparable(line))));
  const stdout = linesOf(text);
  const stderr = separateStderr ? linesOf(separateStderr) : [];
  const sections = scriptSections(stdout, run);
  const reporterLines = (lines: string[]) => lines.filter(line => isTestFailureLine(line, said)).join('\n');
  const testExitedZero = succeeded && run.requiresTestSuccess;
  const onlyTests = run.first && !run.unmarked && run.scripts.every(script => script.name === 'test');
  if (onlyTests) {
    const lines = sections.flatMap(section => section.lines).concat(stderr);
    return testExitedZero ? reporterLines(lines) : lines.join('\n');
  }

  const selected: string[] = [];
  const complete = !testExitedZero && !run.unmarked && !CUT_SHORT.test(text);
  for (const [index, { step, lines }] of sections.entries()) {
    if (step < 0) {
      if (sections.length === 1) {
        // pnpm 11 echoes each script with "$ ". Keep compiler diagnostics
        // with the script that emitted a failure sign. Filtered output may
        // have lost every banner; only runner records then establish ownership.
        const [unmarked, ...scripts] = lines.join('\n').split(/^\$ [^\n]*$/m);
        selected.push(reporterLines(unmarked.split('\n')));
        for (const script of scripts) {
          if (showsFailedTestRun(script, said)) selected.push(script);
        }
      }
      continue;
    }
    const script = run.scripts[step];
    const next = sections[index + 1]?.step ?? run.scripts.length;
    const missingBoundary = run.scripts.slice(step + 1, next).some(later =>
      later.name !== 'test' && later.directory !== script.directory);
    if (complete && script.name === 'test' && !missingBoundary) {
      selected.push(lines.join('\n'));
    } else {
      // A nested npm script can launch the runner itself.
      selected.push(reporterLines(lines));
    }
  }
  // Separate stderr has no position among the stdout banners.
  selected.push(reporterLines(stderr));
  return selected.join('\n');
}

/** Select the test output and the classifier that understands its reporter. */
export function selectTestOutput(command: string, text: string, stderr: string | undefined, succeeded: boolean) {
  if (TEST_RUNNER.test(command)) {
    return { text: stderr === undefined ? text : `${text}\n${stderr}`, packageScript: false };
  }
  const run = findPackageTestScript(command);
  return run && { text: packageTestOutput(run, text, stderr, succeeded), packageScript: true };
}

import { describe, it, expect, beforeEach } from 'vitest';
import {
  handlePostToolUse,
  handlePostToolUseFailure,
  isTestCommand,
  SKILL_PHASE_MAP,
} from '../../src/enforcement/post-tool-use.js';
import { SkillPhaseTracker } from '../../src/skills/phase-tracker.js';
import { FileTracker } from '../../src/enforcement/file-tracker.js';
import { SessionCache } from '../../src/session/cache.js';
import type { HarnessConfig } from '../../src/types.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

describe('handlePostToolUse', () => {
  let tracker: FileTracker;
  let cache: SessionCache;
  let config: HarnessConfig;

  beforeEach(() => {
    tracker = new FileTracker();
    cache = new SessionCache();
    config = structuredClone(DEFAULT_CONFIG);
  });

  it('tracks source file edits via Edit tool', () => {
    const result = handlePostToolUse('Edit', { file_path: 'src/router/resolver.ts' }, tracker, cache, config);
    expect(tracker.getSourceEdits()).toHaveLength(1);
    expect(tracker.getSourceEdits()[0].file).toBe('src/router/resolver.ts');
    expect(result).toBeNull(); // no violation yet
  });

  it('tracks test file edits via Edit tool', () => {
    handlePostToolUse('Edit', { file_path: 'tests/router/resolver.test.ts' }, tracker, cache, config);
    expect(tracker.getTestEdits()).toHaveLength(1);
  });

  it('tracks file edits via Write tool', () => {
    handlePostToolUse('Write', { file_path: 'src/router/rules.ts' }, tracker, cache, config);
    expect(tracker.getSourceEdits()).toHaveLength(1);
  });

  it('emits stale test warning after second source edit without test', () => {
    handlePostToolUse('Edit', { file_path: 'src/router/resolver.ts' }, tracker, cache, config);
    handlePostToolUse('Edit', { file_path: 'tests/router/resolver.test.ts' }, tracker, cache, config);
    // resolver.ts has a test, no stale warning
    handlePostToolUse('Edit', { file_path: 'src/router/rules.ts' }, tracker, cache, config);
    tracker.nextTurn();
    tracker.nextTurn();
    const result = handlePostToolUse('Edit', { file_path: 'src/router/hook.ts' }, tracker, cache, config);
    // rules.ts is stale (no test edit)
    // Note: result from this call is about hook.ts edit itself, but stale check runs
    expect(tracker.getStaleSources()).toEqual(
      expect.arrayContaining([expect.objectContaining({ file: 'src/router/rules.ts' })]),
    );
  });

  describe('handlePostToolUseFailure', () => {
    const command = 'npx vitest run';
    const error = 'Exit code 1\nFAIL tests/foo.test.ts\nTests: 1 failed';

    it('blocks failed tests outside tdd+ and advises during tdd+', () => {
      expect(handlePostToolUseFailure('Bash', { command }, error, cache, config)?.level).toBe('block');
      cache.setPhase('tdd+');
      expect(handlePostToolUseFailure('Bash', { command }, error, cache, config)?.level).toBe('advise');
    });

    it('ignores other tools and non-test commands', () => {
      expect(handlePostToolUseFailure('Edit', { command }, error, cache, config)).toBeNull();
      expect(handlePostToolUseFailure('Bash', { command: 'grep foo bar' }, error, cache, config)).toBeNull();
    });

    it.each([undefined, 1, '', {}])('ignores error %s even with legacy output', (invalid) => {
      expect(handlePostToolUseFailure('Bash', { command, output: error }, invalid, cache, config)).toBeNull();
    });

    it('classifies a failure in a changed file as a regression', () => {
      cache.setChangedFiles(['tests/foo.test.ts']);
      expect(handlePostToolUseFailure('Bash', { command }, error, cache, config)?.message).toContain('REGRESSION');
    });

    it.each(['npm test', 'npm run test', 'npx vitest run'])('blocks a failed %s', (testCommand) => {
      const result = handlePostToolUseFailure('Bash', { command: testCommand }, error, cache, config);
      expect(result?.level).toBe('block');
      expect(result?.message).toContain('1 failure(s) found');
    });

    it.each([undefined, 7, {}])('ignores a command that is not a string: %j', (notACommand) => {
      expect(handlePostToolUseFailure('Bash', { command: notACommand }, error, cache, config)).toBeNull();
    });

    it('ignores a failed script whose file name only contains a runner name', () => {
      const configError = 'Exit code 1\nERROR: vitest.config.ts has no test.include entry';
      expect(
        handlePostToolUseFailure('Bash', { command: 'node check-vitest-config.cjs' }, configError, cache, config),
      ).toBeNull();
    });
  });

  describe('isTestCommand', () => {
    // Every runner invocation the earlier substring rule caught still counts.
    it.each([
      'npx vitest run',
      'npx vitest run tests/foo.test.ts',
      'npx vitest run --config vitest.config.ts',
      'npx vitest@3 run',
      'rtk vitest run',
      'node node_modules/vitest/vitest.mjs run',
      'node node_modules/jest/bin/jest.js',
      './node_modules/.bin/jest --ci',
      'python -u -m pytest -q',
      'uv run --project pkg pytest',
      'pytest-3 -q',
      'pytest-3.12 -q',
      '/usr/bin/pytest-3.11 tests/',
      'tox -e pytest-py3.12',
      'npx mocha',
      'npx ts-mocha tests/**/*.ts',
      'npm run test:jest',
      'pnpm --filter pkg exec vitest run',
      'yarn workspace pkg vitest run',
      'watch -n 1 npx vitest run',
      'bash -c "npx vitest run"',
      'bash scripts/vitest.sh',
      'echo `vitest run --config vitest.config.mjs 2>&1`',
      'vitest \\\n  run',
    ])('recognizes the runner in %j', (testCommand) => {
      expect(isTestCommand(testCommand)).toBe(true);
    });

    it.each([
      'npm test',
      'npm run test',
      'npm test -- tests/foo.test.ts',
      'npm test -- -t "handles errors (slow)"',
      'cd "$PROJECT_DIR" && npm test',
      'pnpm test',
      'yarn test',
      'bun run test',
      'CI=1 npm test',
      'cd web && npm test',
      'npm test 2>&1 | tail -20',
      'npm test; echo "exit: $?"',
      'npm test; echo $?',
      'npm test # the whole suite',
      'npm run lint; npm test',
      'cd web\nnpm test',
      // A `#` inside a word starts no comment.
      'curl -s http://localhost:3000/#/health && npm test',
      'echo build#5; npm test',
    ])('recognizes the package test script in %j', (testCommand) => {
      expect(isTestCommand(testCommand)).toBe(true);
    });

    it.each([
      'node check-vitest-config.cjs',
      'npx eslint vitest.config.ts',
      'cat jest.config.js',
      'git add pytest.ini',
    ])('does not take a runner name inside a file name for a test run: %j', (otherCommand) => {
      expect(isTestCommand(otherCommand)).toBe(false);
    });

    // Text that never runs as a command, or is another script altogether.
    it.each([
      'echo ERROR # ignored ; npm test',
      "cat <<'EOF'\nnpm test\nERROR fixture\nEOF",
      'bash script.sh -c "npm test"',
      'result=$(echo npm test); echo ERROR',
      'X=$(echo npm test ; echo ERROR)',
      'echo "a \\" ; npm test "',
      "echo $'a\\'b ; npm test'",
      "echo $'a\\'b ; npm test '",
      'gh issue view #12 && npm test',
      'echo done ;# npm test',
      'git commit -m "make npm test pass"',
      'git commit -m "wip; npm test still red"',
      "git commit -m 'lint && npm test in CI'",
      'git commit -m "$(cat <<\'EOF\'\ndocs: recommend "npm ci && npm test && npm run build"\nEOF\n)"',
      'echo "$(echo "x; npm test ")"',
      'echo "`echo "x; npm test "`"',
      'echo \\; npm test',
      'echo `echo x; npm test `',
      '(cd web; npm test)',
      'f() { echo x; }; npm test',
      'echo npm test',
      'a=b;c npm test',
      'npm run build',
      'npm run build test',
      'npm run "build" test',
      "npm run 'build' test",
      'npm install',
      'npm run test-data:build',
      'pnpm testing',
      'grep foo bar',
      '',
    ])('does not take %j for a package test script', (otherCommand) => {
      expect(isTestCommand(otherCommand)).toBe(false);
    });
  });

  describe('a package test script behind an earlier step', () => {
    // What `npm run build && npm test` really printed in a demo project
    // (npm 10), first with a build that fails, then with a failing test.
    const buildFailed = [
      'Exit code 1',
      '',
      '> demo@1.0.0 build',
      '> node build.cjs',
      '',
      'ERROR: missing build configuration',
    ].join('\n');
    const testFailed = [
      'Exit code 1',
      '',
      '> demo@1.0.0 build',
      '> node build.cjs',
      '',
      'build ok, arguments: []',
      '',
      '> demo@1.0.0 test',
      '> node mark-test.cjs && vitest run',
      '',
      ' RUN  v5.1.0 /tmp/demo',
      '',
      ' FAIL  tests/sum.test.ts > adds',
      'AssertionError: expected 3 to be 4 // Object.is equality',
      '',
      ' Test Files  1 failed (1)',
      '      Tests  1 failed (1)',
    ].join('\n');
    const laterStep = [
      'npm run build && npm test',
      'npm run build &&\n  npm test',
      'cd web && npm run build && npm test',
      'set -e; npm run build; npm test',
    ];

    it.each(laterStep)('says nothing when an earlier step failed before the tests started: %j', (command) => {
      expect(handlePostToolUseFailure('Bash', { command }, buildFailed, cache, config)).toBeNull();
      cache.setPhase('tdd+');
      expect(handlePostToolUseFailure('Bash', { command }, buildFailed, cache, config)).toBeNull();
    });

    it.each(laterStep)('blocks, or advises during tdd+, when the test script ran and failed: %j', (command) => {
      const result = handlePostToolUseFailure('Bash', { command }, testFailed, cache, config);
      expect(result?.level).toBe('block');
      expect(result?.message).toContain('1 failure(s) found');
      cache.setPhase('tdd+');
      expect(handlePostToolUseFailure('Bash', { command }, testFailed, cache, config)?.level).toBe('advise');
    });

    // Each sign on its own: the line npm prints for the script (with and
    // without a package name), a runner's FAIL line, a runner's summary line.
    it.each([
      ['> demo@1.0.0 test', 'ERROR: could not load the test setup'],
      ['> test', 'ERROR: could not load the test setup'],
      ['> @ test /home/me/demo', 'ERROR: could not load the test setup'],
      [' FAIL  tests/sum.test.ts > adds', 'AssertionError: expected 3 to be 4'],
      [' Test Files  1 failed (1)', '      Tests  1 failed (1)'],
      ['Tests:       1 failed, 4 passed, 5 total', ''],
      ['Test Suites: 1 failed, 1 total', ''],
      // node:test from Node 23 on, when its output is not a terminal
      ['ℹ fail 1', 'ERROR: total came back as text'],
    ])('reads %j as a sign that the test script ran', (sign, detail) => {
      const output = ['Exit code 1', '', '> demo@1.0.0 build', '> node build.cjs', '', 'build ok', '', sign, detail].join('\n');
      expect(
        handlePostToolUseFailure('Bash', { command: 'npm run build && npm test' }, output, cache, config)?.level,
      ).toBe('block');
    });

    // Lines that look like a sign and are not one: a count of zero, a TAP test
    // still marked to do, a build's own verdict, another script's line, a
    // script whose command starts with the shell's `test`. The error comes
    // after the line, so reading from that line on would report it.
    it.each([
      'Tests:       0 failed, 5 passed, 5 total',
      'not ok 2 - rounding # TODO not written yet',
      'BUILD FAILED in 3s',
      '> demo@1.0.0 test:unit',
      '> test -d dist || mkdir dist',
    ])('does not read %j as a sign that the test script ran', (line) => {
      const output = ['Exit code 1', '', '> demo@1.0.0 build', '> node build.cjs', '', line, 'ERROR: missing build configuration'].join('\n');
      expect(handlePostToolUseFailure('Bash', { command: 'npm run build && npm test' }, output, cache, config)).toBeNull();
    });

    // A leading `cd dir &&` only says where the script runs. Whatever the test
    // script prints is then read as it is for a command that starts with it:
    // here a type error from a test script that never reached its runner.
    it.each([
      'cd web && npm test',
      'cd "$PROJECT_DIR" && pnpm test',
      'cd $PROJECT_DIR && npm test',
      'cd web; yarn test',
      'cd web\nnpm test',
      'cd packages && cd api && npm test',
    ])('reads a test script behind a directory change like one that starts the command: %j', (command) => {
      const typeError = "Exit code 2\nsrc/total.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.";
      const plain = handlePostToolUseFailure('Bash', { command: 'npm test' }, typeError, cache, config);
      expect(plain?.level).toBe('block');
      expect(handlePostToolUseFailure('Bash', { command }, typeError, cache, config)).toEqual(plain);
    });

    // `pnpm run build && pnpm test` with pnpm 11.25.0. pnpm names the script
    // only in its last line, and only when that script failed. These are the
    // lines it really printed, for a failing build and for a test script that
    // fails before any runner starts.
    it('reads the line pnpm prints for a failed test script, and not the one for a failed build', () => {
      const command = 'pnpm run build && pnpm test';
      const buildFailedInPnpm = [
        'Exit code 1',
        '$ node build.cjs',
        'ERROR: missing build configuration',
        '[ELIFECYCLE] Command failed with exit code 1.',
      ].join('\n');
      const testScriptFailedInPnpm = [
        'Exit code 2',
        '$ node build.cjs',
        'build ok',
        '$ node typecheck.cjs && node --test tap/adds.mjs',
        "src/total.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
        '[ELIFECYCLE] Test failed. See above for more details.',
      ].join('\n');
      expect(handlePostToolUseFailure('Bash', { command }, buildFailedInPnpm, cache, config)).toBeNull();
      expect(handlePostToolUseFailure('Bash', { command }, testScriptFailedInPnpm, cache, config)?.level).toBe('block');
    });

    // `npm run build && npm test` again, with an asset build that counts one
    // missing file and exits 1. This is what npm really printed.
    const assetBuildFailed = [
      'Exit code 1',
      '',
      '> demo@1.0.0 build',
      '> node build-assets.cjs',
      '',
      'Asset compilation: 1 failed',
    ].join('\n');

    it.each(laterStep)('does not take a failed count printed by a build for a test run: %j', (command) => {
      expect(handlePostToolUseFailure('Bash', { command }, assetBuildFailed, cache, config)).toBeNull();
    });

    // `npm run build; npm test`, exit 0: the build printed an error, then the
    // tests ran and passed. This is what npm and vitest really printed.
    const buildErrorThenGreenTests = [
      '',
      '> demo@1.0.0 build',
      '> node build-config.cjs',
      '',
      'ERROR: missing build configuration',
      '',
      '> demo@1.0.0 test',
      '> node mark-test.cjs && vitest run',
      '',
      ' RUN  v5.1.0 /tmp/demo',
      '',
      ' ✓ tests/pass.test.ts (1 test) 2ms',
      '',
      ' Test Files  1 passed (1)',
      '      Tests  1 passed (1)',
    ].join('\n');

    it('reads the output from the test script line on, not what an earlier step printed', () => {
      const result = handlePostToolUse(
        'Bash',
        { command: 'npm run build; npm test' },
        tracker,
        cache,
        config,
        undefined,
        buildErrorThenGreenTests,
      );
      expect(result).toBeNull();
    });

    // `cd . && pnpm test` with pnpm 11.25.0 and a failing node:test run. pnpm
    // prints the script's command, not a line that names the script, so the
    // TAP result is what shows that tests ran. This is what they really printed
    // (the middle of the failure detail is left out).
    const pnpmTapFailed = [
      'Exit code 1',
      '$ node mark-test.cjs && node --test tap/adds.mjs',
      'TAP version 13',
      '# ERROR: total came back as text',
      '# Subtest: adds',
      'not ok 1 - adds',
      '  ---',
      "  failureType: 'testCodeFailure'",
      '  error: |-',
      '    Expected values to be strictly equal:',
      '    ',
      '    3 !== 4',
      '    ',
      "  code: 'ERR_ASSERTION'",
      '  ...',
      '1..1',
      '# tests 1',
      '# pass 0',
      '# fail 1',
      '[ELIFECYCLE] Test failed. See above for more details.',
    ].join('\n');

    it('reports a failing TAP run behind an earlier step just as it does without one', () => {
      const plain = handlePostToolUseFailure('Bash', { command: 'pnpm test' }, pnpmTapFailed, cache, config);
      const behindCd = handlePostToolUseFailure('Bash', { command: 'cd . && pnpm test' }, pnpmTapFailed, cache, config);
      expect(plain?.level).toBe('block');
      expect(behindCd).toEqual(plain);
    });

    // The TAP line is all there is: no ERROR or FAIL word beside it.
    it.each(['not ok 1 - adds', '    not ok 2 - a nested test', '# fail 1'])(
      'reads the TAP line %j as a failing test run',
      (tapLine) => {
        const output = ['Exit code 1', '$ node --test', tapLine].join('\n');
        const result = handlePostToolUseFailure('Bash', { command: 'pnpm run build && pnpm test' }, output, cache, config);
        expect(result?.level).toBe('block');
        expect(result?.message).toContain(`  ${tapLine.trim()}`);
      },
    );

    it('does not take a passing TAP run behind an earlier step for a failing one', () => {
      const output = ['$ node --test', '# ERROR: total came back as text', 'ok 1 - adds', '1..1', '# pass 1', '# fail 0'].join('\n');
      const result = handlePostToolUse('Bash', { command: 'pnpm run build && pnpm test' }, tracker, cache, config, undefined, output);
      expect(result).toBeNull();
    });

    it('reports a failing test after an earlier step without counting that step\'s error line', () => {
      // The build's line has the shape zero-defect counts as a failure line.
      const output = [
        'Exit code 1',
        '',
        '> demo@1.0.0 build',
        '> node build-config.cjs',
        '',
        'ERROR missing build configuration',
        '',
        '> demo@1.0.0 test',
        '> node mark-test.cjs && vitest run',
        '',
        ' FAIL  tests/sum.test.ts > adds',
        'AssertionError: expected 3 to be 4 // Object.is equality',
        '',
        ' Test Files  1 failed (1)',
        '      Tests  1 failed (1)',
      ].join('\n');
      const result = handlePostToolUseFailure('Bash', { command: 'npm run build; npm test' }, output, cache, config);
      expect(result?.level).toBe('block');
      expect(result?.message).toContain('1 failure(s) found');
    });

    it('takes a failed count as a sign the tests ran when a pipeline cut their start off', () => {
      // `... | tail -5` exits 0 and drops the "> demo@1.0.0 test" line.
      const tail = [
        '',
        '> demo@1.0.0 build',
        '> node build.cjs',
        '',
        'build ok, arguments: []',
        ' Test Files  1 failed (1)',
        '      Tests  1 failed (1)',
        '   Start at  10:53:39',
        '   Duration  195ms',
      ].join('\n');
      const result = handlePostToolUse(
        'Bash',
        { command: 'npm run build && npm test 2>&1 | tail -5' },
        tracker,
        cache,
        config,
        undefined,
        tail,
      );
      expect(result?.message).toContain('ZERO-DEFECT');
    });

    it('checks a test script that starts the command whatever its output looks like', () => {
      const scriptError = 'Exit code 1\nERROR: could not load the test setup';
      expect(handlePostToolUseFailure('Bash', { command: 'npm test' }, scriptError, cache, config)?.level).toBe('block');
    });

    // Unchanged here: a command that names a runner is checked as before, even
    // behind `&&`. Only the package-script form asks for a sign that it ran.
    it('leaves a command that names a runner as it was', () => {
      expect(
        handlePostToolUseFailure('Bash', { command: 'npm run build && npx vitest run' }, buildFailed, cache, config),
      ).not.toBeNull();
    });
  });

  // The fixtures below are what npm 10.9.9, pnpm 11.25.0, Node 22.23.5, tsc and
  // vitest 5.1.0 really printed in a demo project, with stacks and timings left
  // out. A fixture that was put together from such lines says so.
  const typeError = "check.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.";
  const tapPassed = [
    'TAP version 13',
    '# Subtest: adds',
    'ok 1 - adds',
    '  ---',
    "  type: 'test'",
    '  ...',
    '1..1',
    '# tests 1',
    '# pass 1',
    '# fail 0',
  ];
  const tapFailed = [
    'TAP version 13',
    '# Subtest: adds',
    'not ok 1 - adds',
    '  ---',
    "  failureType: 'testCodeFailure'",
    "  error: '4 == 5'",
    "  code: 'ERR_ASSERTION'",
    '  ...',
    '1..1',
    '# tests 1',
    '# pass 0',
    '# fail 1',
  ];
  const buildOk = ['', '> demo@1.0.0 build', '> node build-ok.cjs', '', 'build ok'];
  const nodeTest = ['', '> demo@1.0.0 test', '> node mark-test.cjs && node --test --test-reporter=tap calc.cjs', ''];
  const failed = (command: string, ...lines: string[]) =>
    handlePostToolUseFailure('Bash', { command }, lines.join('\n'), cache, config);

  describe('a failing node:test run started through a package script', () => {
    // `assert.equal(2 + 2, 5)` with the default message: the output holds no
    // FAIL, ERROR or "N failed" for the check to find.
    it.each(['npm test', 'cd . && npm test', 'npm run build && npm test'])('blocks and names the test: %j', (command) => {
      const output = command.includes('build') ? [...buildOk, ...nodeTest, ...tapFailed] : [...nodeTest, ...tapFailed];
      const result = failed(command, 'Exit code 1', ...output);
      expect(result?.level).toBe('block');
      expect(result?.message).toContain('1 failure(s) found');
      expect(result?.message).toContain('  not ok 1 - adds');
      cache.setPhase('tdd+');
      expect(failed(command, 'Exit code 1', ...output)?.level).toBe('advise');
    });

    it('reports it when the session has changed files recorded', () => {
      cache.setChangedFiles(['calc.cjs', 'src/other.ts']);
      const result = failed('npm test', 'Exit code 1', ...nodeTest, ...tapFailed);
      expect(result?.level).toBe('block');
      expect(result?.message).toContain('not ok 1 - adds');
    });

    it.each(['pnpm test', 'cd . && pnpm test', 'pnpm run build && pnpm test'])('blocks through pnpm: %j', (command) => {
      const result = failed(
        command,
        'Exit code 1',
        '$ node build-ok.cjs',
        'build ok',
        '$ node mark-test.cjs && node --test --test-reporter=tap calc.cjs',
        ...tapFailed,
        '[ELIFECYCLE] Test failed. See above for more details.',
      );
      expect(result?.level).toBe('block');
      expect(result?.message).toContain('  not ok 1 - adds');
    });

    it('reports a pnpm test script that exits 1 and prints nothing of its own', () => {
      const result = failed(
        'pnpm run build && pnpm test',
        'Exit code 1',
        '$ node build-ok.cjs',
        'build ok',
        '$ node mark-test.cjs && node -e "process.exit(1)"',
        '[ELIFECYCLE] Test failed. See above for more details.',
      );
      expect(result?.level).toBe('block');
      expect(result?.message).toContain('  [ELIFECYCLE] Test failed. See above for more details.');
    });

    it('says nothing about a passing run that has a TODO failure in it', () => {
      const output = [...buildOk, ...nodeTest, 'ok 1 - adds', 'not ok 2 - rounds # TODO not written yet', '# fail 0', '# todo 1'];
      const result = handlePostToolUse('Bash', { command: 'npm run build && npm test' }, tracker, cache, config, undefined, output.join('\n'));
      expect(result).toBeNull();
    });
  });

  describe('the lifecycle npm runs around a test script', () => {
    const pretest = ['', '> demo@1.0.0 pretest', '> node mark-pretest.cjs && tsc --noEmit --skipLibCheck check.ts', ''];

    it('reports a pretest that fails behind an earlier step, as it does for the test script alone', () => {
      const alone = failed('npm test', 'Exit code 2', ...pretest, typeError);
      const behindBuild = failed('npm run build && npm test', 'Exit code 2', ...buildOk, ...pretest, typeError);
      expect(alone?.level).toBe('block');
      expect(alone?.message).toContain('error TS2322');
      expect(behindBuild).toEqual(alone);
    });

    it('reads from the pretest line on, not what the earlier step printed', () => {
      // Put together: a build that prints an error and goes on, then a pretest
      // and tests that pass.
      const output = ['', '> demo@1.0.0 build', '> node build-config.cjs', '', 'ERROR: missing build configuration', ...pretest, ...nodeTest, ...tapPassed];
      const result = handlePostToolUse('Bash', { command: 'npm run build; npm test' }, tracker, cache, config, undefined, output.join('\n'));
      expect(result).toBeNull();
    });

    it('says nothing when pretest was run by name and failed before npm test started', () => {
      expect(failed('npm run pretest && npm test', 'Exit code 2', ...pretest, typeError)).toBeNull();
      expect(failed('npm run build && npm run pretest && npm test', 'Exit code 2', ...buildOk, ...pretest, typeError)).toBeNull();
    });

    it('does not count pretest lines at all once pretest is run by name', () => {
      // Put together: a workspace run prints one pretest line per package, and
      // the second package fails. How many lines a step prints is not known.
      const workspaces = ['', '> web@1.0.0 pretest', '> tsc --noEmit', '', '', '> api@1.0.0 pretest', '> tsc --noEmit', '', typeError];
      expect(failed('npm run pretest --workspaces && npm test', 'Exit code 2', ...workspaces)).toBeNull();
      // Put together: the line pnpm printed for a script before version 11.
      const olderPnpm = ['', '> demo@1.0.0 pretest /home/me/demo', '> tsc --noEmit', '', typeError];
      expect(failed('pnpm run pretest && pnpm test', 'Exit code 2', ...olderPnpm)).toBeNull();
      expect(failed('pnpm pretest && pnpm test', 'Exit code 2', ...olderPnpm)).toBeNull();
      expect(failed('npm --prefix . run pretest && npm test', 'Exit code 2', ...pretest, typeError)).toBeNull();
    });

    it('still reads the test line after a pretest that was run by name', () => {
      // Put together: pretest passes by name, then the tests fail.
      const result = failed('npm run pretest && npm test', 'Exit code 1', '', '> demo@1.0.0 pretest', '> tsc --noEmit', ...nodeTest, ...tapFailed);
      expect(result?.message).toContain('  not ok 1 - adds');
    });

    it('reads the pretest line of a package with no name', () => {
      // Put together from the nameless form npm prints (`> test`).
      const result = failed('npm run build && npm test', 'Exit code 2', '', '> build', '> node build-ok.cjs', '', 'build ok', '', '> pretest', '> tsc --noEmit', '', typeError);
      expect(result?.level).toBe('block');
    });

    it.each(['> demo@1.0.0 pretest:lint', '> pretest -x', '> demo@1.0.0 prepretest'])(
      'does not take %j for the start of the test lifecycle',
      (line) => {
        expect(failed('npm run build && npm test', 'Exit code 2', ...buildOk, '', line, '', typeError)).toBeNull();
      },
    );
  });

  describe('a directory change the pattern cannot read', () => {
    // `cd "$(node locate.cjs)" && pnpm test`: the locator printed an error, cd
    // failed, and pnpm never started. This is what bash really printed.
    const cdFailed = ['Exit code 1', 'ERROR: configured workspace is missing', 'bash: line 1: cd: packages/web: No such file or directory'];

    it.each([
      'cd "$(node locate.cjs)" && pnpm test',
      'cd "$(git rev-parse --show-toplevel)" && npm test',
      'cd "`pwd`/web" && npm test',
      'cd $(pwd) && npm test',
      'cd `pwd` && npm test',
      'cd "${ROOT:-$(pwd)}" && npm test',
      'cd web && cd "$(node locate.cjs)" && npm test',
    ])('leaves a test script behind a computed directory alone: %j', (command) => {
      expect(isTestCommand(command)).toBe(false);
      expect(failed(command, ...cdFailed)).toBeNull();
    });

    it.each([
      'cd web && npm test',
      'cd "/srv/my project/web" && npm test',
      "cd 'web app' && npm test",
      'cd "$PROJECT_DIR" && npm test',
      'cd $PROJECT_DIR/web && npm test',
      'cd ${PROJECT_DIR}/web && npm test',
      'cd ~/proj && npm test',
      'cd ../api; npm test',
    ])('still reads a test script behind a plain directory change: %j', (command) => {
      const plain = failed('npm test', 'Exit code 2', typeError);
      expect(plain?.level).toBe('block');
      expect(failed(command, 'Exit code 2', typeError)).toEqual(plain);
    });
  });

  describe('a line that only quotes what pnpm prints for a failed test script', () => {
    // `pnpm run build && pnpm test`: tsc, run by the build, quoted the string
    // in its diagnostic. pnpm's own last line names no test.
    it('says nothing when the build fails with a diagnostic that quotes the line', () => {
      const result = failed(
        'pnpm run build && pnpm test',
        'Exit code 2',
        '$ tsc --noEmit --skipLibCheck hint.ts',
        `hint.ts(1,7): error TS2322: Type '"[ELIFECYCLE] Test failed. See above for more details."' is not assignable to type '"ready"'.`,
        '[ELIFECYCLE] Command failed with exit code 2.',
      );
      expect(result).toBeNull();
    });
  });

  describe('steps after a package test script', () => {
    const passingTest = ['', '> demo@1.0.0 test', '> node mark-test.cjs && node --test --test-reporter=tap calc-ok.cjs', '', ...tapPassed];
    const failingTest = [...nodeTest, ...tapFailed];
    const lintFailed = ['', '> demo@1.0.0 lint', '> tsc --noEmit --skipLibCheck check.ts', '', typeError];

    it('says nothing when the tests pass and a later npm script fails', () => {
      expect(failed('npm run build && npm test && npm run lint', 'Exit code 2', ...buildOk, ...passingTest, ...lintFailed)).toBeNull();
      expect(failed('npm test && npm run lint', 'Exit code 2', ...passingTest, ...lintFailed)).toBeNull();
      expect(failed('npm test && npm run lint -- --max-warnings 0', 'Exit code 2', ...passingTest, ...lintFailed)).toBeNull();
      expect(failed('npm test && CI=1 npm run lint', 'Exit code 2', ...passingTest, ...lintFailed)).toBeNull();
    });

    it('stops at the line of whichever later npm script started', () => {
      // `npm test || npm run build; npm run lint`: the tests pass, so the build
      // is skipped and the lint script is the one that prints a line.
      expect(failed('npm test || npm run build; npm run lint', 'Exit code 2', ...passingTest, ...lintFailed)).toBeNull();
      expect(failed('npm test && npm run build && npm run lint', 'Exit code 2', ...passingTest, ...buildOk, ...lintFailed)).toBeNull();
    });

    it('says nothing when the tests pass and a build that follows them fails', () => {
      const buildFailedAfter = ['', '> demo@1.0.0 build', '> tsc --noEmit --skipLibCheck check.ts', '', typeError];
      expect(failed('npm test && npm run build', 'Exit code 2', ...passingTest, ...buildFailedAfter)).toBeNull();
    });

    it('reports failing tests when the later step never started', () => {
      const result = failed('npm run build && npm test && npm run lint', 'Exit code 1', ...buildOk, ...failingTest);
      expect(result?.level).toBe('block');
      expect(result?.message).toContain('  not ok 1 - adds');
    });

    it('reports the failing tests and not the lint error that follows them', () => {
      const result = failed('npm test; npm run lint', 'Exit code 2', ...failingTest, ...lintFailed);
      expect(result?.level).toBe('block');
      expect(result?.message).toContain('1 failure(s) found');
      expect(result?.message).toContain('  not ok 1 - adds');
      expect(result?.message).not.toContain('TS2322');
    });

    it('stops at the line of a script that runs before the later one', () => {
      // Put together: a prelint script fails, so the lint line never prints.
      const prelintFailed = ['', '> demo@1.0.0 prelint', '> tsc --noEmit --skipLibCheck check.ts', '', typeError];
      expect(failed('npm test && npm run lint', 'Exit code 2', ...passingTest, ...prelintFailed)).toBeNull();
    });

    it('stops at the later script in a package with no name', () => {
      // Put together from the nameless form npm prints.
      const output = ['', '> test', '> node --test', '', ...tapPassed, '', '> lint', '> tsc --noEmit', '', typeError];
      expect(failed('npm test && npm run lint', 'Exit code 2', ...output)).toBeNull();
    });

    it('keeps every package of a workspace run in the test output', () => {
      // Put together: two workspace packages, the second one fails.
      const twoPackages = (second: string[]) => [
        '', '> web@1.0.0 test', '> node --test', '', ...tapPassed,
        '', '> api@1.0.0 test', '> node --test', '', ...second,
      ];
      const result = failed('npm test --workspaces && npm run lint', 'Exit code 1', ...twoPackages(tapFailed));
      expect(result?.message).toContain('  not ok 1 - adds');
      expect(failed('npm test --workspaces && npm run lint', 'Exit code 2', ...twoPackages(tapPassed), ...lintFailed)).toBeNull();
    });

    it('does not stop at a line the test script printed itself when failing tests follow it', () => {
      // Put together: the test script runs the lint script before its tests.
      const result = failed(
        'npm test && npm run lint',
        'Exit code 1',
        '', '> demo@1.0.0 test', '> npm run lint && node --test', '',
        '', '> demo@1.0.0 lint', '> eslint .', '',
        ...tapFailed,
      );
      expect(result?.level).toBe('block');
      expect(result?.message).toContain('  not ok 1 - adds');
    });

    it('does not take the line of an earlier run of the later script for the end', () => {
      // Put together: lint runs before and after the tests, and the pretest
      // script fails in between.
      const result = failed(
        'npm run lint && npm test && npm run lint',
        'Exit code 2',
        '', '> demo@1.0.0 lint', '> eslint .', '',
        '', '> demo@1.0.0 pretest', '> tsc --noEmit --skipLibCheck check.ts', '', typeError,
      );
      expect(result?.level).toBe('block');
    });

    it('reads a dot in the later script name as a dot', () => {
      // Put together: the test script runs `lint-fix` before a type check that
      // fails. That line is not the line of the later script `lint.fix`.
      const result = failed(
        'npm test && npm run lint.fix',
        'Exit code 2',
        '', '> demo@1.0.0 test', '> npm run lint-fix && tsc --noEmit', '',
        '', '> demo@1.0.0 lint-fix', '> eslint --fix .', '',
        typeError,
      );
      expect(result?.level).toBe('block');
    });

    // A later step that prints no line of its own to stop at. The output is the
    // test run's only if it shows a failed test run.
    it.each([
      'npm test && npx tsc --noEmit',
      'npm test && node scripts/check-types.js',
      'npm test; make lint',
      'npm test && pnpm run lint',
      'npm test && npm run -s lint',
      'npm test && npm run lint --silent',
      'npm test && npm run lint -s',
      'npm test && npm_config_loglevel=silent npm run lint',
      'npm test && (cd docs && npm run lint)',
      'npm test & npm run lint',
      'npm test && cd "$(node locate.cjs)"',
      // A later npm script whose own line may never reach the output.
      'npm test && npm run lint 2>&1 | tail -3',
      'npm test && npm run lint 2>&1 | grep error',
      'npm test; npm run lint > lint.log 2>&1; tail -2 lint.log',
      'npm test && npm run lint --if-present && npm run build',
      'npm test && npm run lint -q',
      // A step that looks quiet and runs a command of its own.
      'npm test && echo "build: $(node build-config.cjs 2>&1)"',
      'npm test; echo $(npm run lint 2>&1)',
      'npm test; echo done | node build-config.cjs',
      'npm test; printf "%s\\n" "`cat build.log`"',
      'npm test; true | node build-config.cjs',
      'npm test; exit $(node status.cjs)',
      // The test script's own step hands its output to another program, or
      // takes arguments from one.
      'npm test | node summarize.cjs',
      'npm test -- $(node select-tests.cjs)',
      'npm test 2>&1 | tee >(node upload.cjs)',
      'npm test && npm test | node summarize.cjs',
      // A step sent to the background before the tests writes while they run.
      'node late-error.cjs &\nnpm test',
      // `set -x` makes the shell print every command it runs.
      'npm test; set -x; echo done',
      'set -x; npm test; echo done',
      'set -euxo pipefail\nnpm test',
      // Not the silent steps they look like.
      'npm test; exit FAILED',
      'npm test | grep -r ERROR',
      'npm test | grep -f patterns.txt',
      // A heredoc after the script holds lines the pattern cannot tell from steps.
      "npm test <<'EOF'\nsome input\nEOF",
      "npm test <<EOF\necho it's\nEOF\nnpm run lint | tail -1; echo 'ok'",
      // Quoting the pattern cannot follow can hide a step inside a "word".
      "npm test; echo 'don'\\''t stop'; npm run lint 2>&1 | tail -3; echo 'ok'",
      "npm test; echo it\\'s done; npm run lint 2>&1 | tail -3; echo it\\'s over",
      "npm test; echo $'a\\'b'; npm run lint | tail -1",
      // npm reads its settings from the environment in either case.
      'npm test && NPM_CONFIG_LOGLEVEL=silent npm run lint',
      // A program in a pipe that prints text of its own, or changes the text.
      'npm test | cat - lint.log',
      'npm test | grep error build.log',
      'npm test | tr a-z A-Z',
      'npm test | sed -n 1,20p',
      'npm test | sort lint.log',
    ])('asks for a failed test run when the later step cannot be told apart: %j', (command) => {
      // Put together: the tests pass and the later step prints a type error.
      expect(failed(command, 'Exit code 2', ...passingTest, typeError)).toBeNull();
      const result = failed(command, 'Exit code 1', ...failingTest);
      expect(result?.level).toBe('block');
      expect(result?.message).toContain('  not ok 1 - adds');
    });

    it('asks for a failed test run when npm printed none of its script lines', () => {
      // Put together: npm is set to run silently (`loglevel=silent` in .npmrc),
      // so nothing marks where the tests end and the lint script begins.
      expect(failed('npm test && npm run lint', 'Exit code 2', ...tapPassed, typeError)).toBeNull();
      expect(failed('npm test && npm run lint', 'Exit code 1', ...tapFailed)?.level).toBe('block');
    });

    // `npm run build && npm test && echo PASSED || echo FAILED` is a common way
    // to end a command. Here the build fails, so the echo is all that runs
    // after it, and the command exits 0.
    it.each([
      ['npm run build && npm test && echo PASSED || echo FAILED', 'FAILED'],
      ['npm run build && npm test || echo FAILED', 'FAILED'],
      ['npm run build && npm test || echo "FAIL"', 'FAIL'],
      ['npm run build && npm test || echo "FAILED $?"', 'FAILED 1'],
      ['npm run build && npm test && echo PASSED || echo "FAILED - see the output above"', 'FAILED - see the output above'],
      ['npm run build && npm test || echo "FAIL build or tests"', 'FAIL build or tests'],
      ['npm run build && npm test || echo "Tests: 1 failed step"', 'Tests: 1 failed step'],
      // Words that read like a failed test run, whatever pattern is used. A
      // sign whose words the command holds itself is not trusted, and a line
      // the command spells out is left out of the output.
      ['npm run build && npm test && echo ok || echo "not ok"', 'not ok'],
      ['npm run build && npm test || echo "not ok 1 - build or tests"', 'not ok 1 - build or tests'],
      ['npm run build && npm test || echo "FAILED - see build.log"', 'FAILED - see build.log'],
      ['npm run build && npm test || echo "FAILED build/test"', 'FAILED build/test'],
      ['npm run build && npm test || echo "FAILED $? in src/app.ts"', 'FAILED 1 in src/app.ts'],
      ['npm run build && npm test || echo FAILED: see dist/build.log >&2', 'FAILED: see dist/build.log'],
      ['npm run build && npm test || printf "Tests: 1 failed, 0 passed\\n"', 'Tests: 1 failed, 0 passed'],
      ["npm run build && npm test || printf '%s\\n' 'FAIL tests/sum.test.ts'", 'FAIL tests/sum.test.ts'],
      ['npm run build && npm test || echo -e "FAILED in src/app.ts\\n"', 'FAILED in src/app.ts'],
      // The same words printed in other ways.
      ['npm run build && npm test || { echo "FAILED - see build.log"; exit 1; }', 'FAILED - see build.log'],
      ['npm run build && npm test || (echo "FAILED - see build.log"; exit 1)', 'FAILED - see build.log'],
      ['npm run build && npm test || >&2 echo "FAILED - see build.log"', 'FAILED - see build.log'],
      ['npm run build && npm test || echo "FAILED - see build.log" | tee -a status.txt', 'FAILED - see build.log'],
      ['npm run build && npm test && echo ok || { echo "not ok 1 - build or tests"; exit 1; }', 'not ok 1 - build or tests'],
      ["npm run build && npm test || node -e 'console.log(\"FAILED - see build.log\")'", 'FAILED - see build.log'],
      // Printed differently from how the command spells them: in color, with a
      // tab, with a home directory filled in, with the quotes taken off.
      ['npm run build && npm test || echo -e "\\033[31mFAILED\\033[0m - see build.log"', '\x1b[31mFAILED\x1b[0m - see build.log'],
      ["npm run build && npm test || printf 'FAILED\\tbuild/test\\n'", 'FAILED\tbuild/test'],
      ['npm run build && npm test || echo FAILED see ~/build.log', 'FAILED see /home/dave/build.log'],
      ['npm run build && npm test || echo "FAILED \\"build/test\\""', 'FAILED "build/test"'],
      // Put together from two quoted pieces, or changed on the way out.
      ['npm run build && npm test || echo "FA""ILED - see build.log"', 'FAILED - see build.log'],
      ['npm run build && npm test || echo "not" "ok 1 - build or tests"', 'not ok 1 - build or tests'],
      ['npm run build && npm test || echo "failed - see build.log" | tr a-z A-Z', 'FAILED - SEE BUILD.LOG'],
      // A variable in single quotes is printed as it is written.
      ["npm run build && npm test || echo 'FAILED $step build/test'", 'FAILED $step build/test'],
    ])('does not take what a closing echo prints for a failed test run: %j', (command, echoed) => {
      const output = ['', '> demo@1.0.0 build', '> node build-config.cjs', '', 'ERROR: missing build configuration', echoed, ''];
      expect(handlePostToolUse('Bash', { command }, tracker, cache, config, undefined, output.join('\n'))).toBeNull();
      // The same through pnpm, which prints no line for a script.
      const pnpm = command.replaceAll('npm', 'pnpm');
      const pnpmOutput = ['$ node build-config.cjs', 'ERROR: missing build configuration', '[ELIFECYCLE] Command failed with exit code 1.', echoed, ''];
      expect(handlePostToolUse('Bash', { command: pnpm }, tracker, cache, config, undefined, pnpmOutput.join('\n'))).toBeNull();
    });

    it("does not take an echo before the tests for a failed test run", () => {
      // The echo prints first, then the build fails and the tests never start.
      const command = 'echo "FAIL tests/sum.test.ts is the one to watch" && npm run build && npm test';
      const output = ['FAIL tests/sum.test.ts is the one to watch', '', '> demo@1.0.0 build', '> node build-config.cjs', '', 'ERROR: missing build configuration', ''];
      expect(handlePostToolUse('Bash', { command }, tracker, cache, config, undefined, output.join('\n'))).toBeNull();
    });

    // A filter, a test name, a comment or a commit message can hold the words
    // of a sign and print nothing. The sign still counts.
    it.each([
      ['npm run build && npm test 2>&1 | grep -E "FAIL|failed"', [' FAIL  tests/sum.test.ts > adds', ' Test Files  1 failed (1)', '      Tests  1 failed (1)']],
      ['npm run build && npm test 2>&1 | grep FAIL', [' FAIL  tests/sum.test.ts > adds']],
      ['npm run build && npm test 2>&1 | grep failed', [' Test Files  1 failed (1)', '      Tests  1 failed (1)']],
      ['npm run build && npm test -- -t "failed login" 2>&1 | tail -2', ['Tests:       1 failed, 1 total', 'Test Suites: 1 failed, 1 total']],
      ['set -e # fail fast\nnpm run build\nnpm test | tail -3', ['# pass 0', '# fail 1', '# cancelled 0']],
      ['npm run build && npm test | tail -3 # shows "# fail 1" when a test failed', ['# pass 0', '# fail 1', '# cancelled 0']],
      ['yarn build && yarn test || echo "FAILED: tests failed"', [' FAIL  tests/sum.test.ts > adds', ' Test Files  1 failed (1)', 'FAILED: tests failed']],
      ['npm test; git commit -m "fix: FAILED state no longer reported as failed"', [' FAIL  tests/sum.test.ts > adds', ' Test Files  1 failed (1)']],
      // The test step names the very line a failing run prints: as the
      // pattern of a filter, or as the test to run.
      ['npm run build && npm test 2>&1 | grep "FAIL  tests/sum.test.ts"', [' FAIL  tests/sum.test.ts > adds']],
      ['npm run build && npm test 2>&1 | grep "not ok 1"', ['not ok 1 - adds']],
      ['npm run build && npm test 2>&1 | grep -E "^ok; | FAIL  tests/sum.test.ts"', [' FAIL  tests/sum.test.ts > adds']],
      ['npm run build && npm test | tail -6 | grep -v "# fail 0"', ['# pass 0', '# fail 1', '# cancelled 0']],
      ['npm run build && npm test -- --last-failed tests/test_sum.py::test_adds 2>&1 | tail -2', ['FAILED tests/test_sum.py::test_adds - assert 3 == 4', '1 failed in 0.03s']],
    ])('still reports failing tests when the command holds the words of a sign and cannot print them: %j', (command, lines) => {
      const output = [...buildOk, ...lines, ''].join('\n');
      expect(handlePostToolUse('Bash', { command }, tracker, cache, config, undefined, output)?.level).toBe('block');
    });

    it('does not take a line the test step filters for as words of the command', () => {
      // The pattern of a filter never reaches the output. Only the test run
      // does, and here the one line it printed is the whole pattern.
      const command = 'npm test 2>&1 | grep "FAIL  tests/sum.test.ts > adds"';
      const result = handlePostToolUse('Bash', { command }, tracker, cache, config, undefined, ' FAIL  tests/sum.test.ts > adds\n');
      expect(result?.level).toBe('block');
      expect(result?.message).toContain('FAIL  tests/sum.test.ts > adds');
    });

    it('keeps the words of a test step whose arguments run a command', () => {
      // Put together, through pnpm: the substitution prints a line to stderr
      // before the tests start, and the tests pass.
      const command = 'pnpm run build; pnpm test -- "$(echo FAILED tests/sum.test.ts >&2)"';
      const output = ['$ node build-ok.cjs', 'build ok', 'FAILED tests/sum.test.ts', '$ node --test', ...tapPassed, ''];
      expect(handlePostToolUse('Bash', { command }, tracker, cache, config, undefined, output.join('\n'))).toBeNull();
    });

    it('keeps the words of a test step that prints through a program of its own', () => {
      // Put together: the tests pass, and `sed` puts words of the command in
      // front of every line they print.
      const command = 'npm run build; npm test | sed "s/^/FAILED build.log: /"';
      const output = [...buildOk, 'FAILED build.log: ok 1 - adds', 'FAILED build.log: # pass 1', 'FAILED build.log: # fail 0', ''];
      expect(handlePostToolUse('Bash', { command }, tracker, cache, config, undefined, output.join('\n'))).toBeNull();
    });

    it('keeps the line npm prints for a script when the command holds its text', () => {
      // Put together, in a package with no name: `> lint.done` in the command
      // holds the text of npm's `> lint` line.
      const output = ['', '> test', '> node --test', '', ...tapPassed, '', '> lint', '> tsc --noEmit', '', typeError];
      expect(failed('npm test; npm run lint; echo done > lint.done', 'Exit code 2', ...output)).toBeNull();
    });

    it('does not hold the words of a closing echo against tests that a filter left nothing of', () => {
      // `grep` finds nothing in a passing run and exits 1, so the echo prints 1.
      const command = 'npm test 2>&1 | grep -E "FAIL|ERROR"; echo "FAILED=$?"';
      expect(handlePostToolUse('Bash', { command }, tracker, cache, config, undefined, 'FAILED=1\n')).toBeNull();
    });

    // `npm test; echo "FAILED=$?"` after passing tests prints `FAILED=0`.
    it.each([
      ['npm test; code=$?; echo "FAILED=$code"', 'FAILED=0'],
      ['npm test 2>&1 | tail -20; echo "FAILED: ${PIPESTATUS[0]}"', 'FAILED: 0'],
      ["npm test; printf 'FAILED=%d\\n' $?", 'FAILED=0'],
      ["npm test; printf 'FAILED\\t%d\\n' $?", 'FAILED\t0'],
      ['npm test; echo "no ERROR" "today"', 'no ERROR today'],
      // Words only a failed test run prints otherwise.
      ['npm test; echo "not ok 1 - is what a failed test prints"', 'not ok 1 - is what a failed test prints'],
      // A plain `echo` prints a backslash as it is written.
      ['npm test; echo "FAILED=$?\\n"', 'FAILED=0\\n'],
      ["npm test; echo 'no ERROR in C:\\tmp\\new.log'", 'no ERROR in C:\\tmp\\new.log'],
      ['npm test; echo "FAILED=$?"', 'FAILED=0'],
      ['npm test && echo "=== no ERROR, nothing FAILED ==="', '=== no ERROR, nothing FAILED ==='],
      ['npm test; echo "exit code: $? (0 failed is good)"', 'exit code: 0 (0 failed is good)'],
    ])('does not hold the words of a closing echo against tests that passed: %j', (command, echoed) => {
      const output = [...passingTest, echoed, ''].join('\n');
      expect(handlePostToolUse('Bash', { command }, tracker, cache, config, undefined, output)).toBeNull();
      const result = failed(command, 'Exit code 1', ...failingTest, echoed.replace('=0', '=1'));
      expect(result?.message).toContain('1 failure(s) found');
      expect(result?.message).toContain('  not ok 1 - adds');
    });

    it('asks for a failed test run when the output was cut in the middle', () => {
      // Put together: Claude Code leaves a marker where it cut a long output,
      // and the line of the lint script may be in the part that is gone.
      const cut = '... [5212 characters truncated] ...';
      expect(failed('npm test && npm run lint', 'Exit code 2', ...passingTest, cut, typeError)).toBeNull();
      expect(failed('npm test && npm run lint', 'Exit code 1', ...failingTest, cut)?.level).toBe('block');
    });

    it('still reports failing tests in front of such an echo', () => {
      const output = [...buildOk, ...failingTest, 'FAILED', ''];
      const result = handlePostToolUse(
        'Bash', { command: 'npm run build && npm test && echo PASSED || echo FAILED' }, tracker, cache, config, undefined, output.join('\n'),
      );
      expect(result?.level).toBe('block');
      expect(result?.message).toContain('  not ok 1 - adds');
    });

    it('still reports failing tests when the command holds the words of one of their signs', () => {
      // A failing vitest test behind a build. The braces leave the cut open,
      // and the command says FAILED itself: the summary line is the sign.
      const vitestFailed = ['', '> demo@1.0.0 test', '> vitest run', '', ' FAIL  tests/sum.test.ts > adds', 'AssertionError: expected 3 to be 4', '', ' Test Files  1 failed (1)', '      Tests  1 failed (1)'];
      const inBraces = 'npm run build && npm test || { echo "FAILED - see build.log"; exit 1; }';
      const vitest = failed(inBraces, 'Exit code 1', ...buildOk, ...vitestFailed, 'FAILED - see build.log');
      expect(vitest?.level).toBe('block');
      expect(vitest?.message).toContain('FAIL  tests/sum.test.ts > adds');
      // A failing node:test run through pnpm, and a command that says "not ok"
      // itself: node's count of failures is the sign.
      const notOk = 'pnpm run build && pnpm test && echo ok || { echo "not ok"; exit 1; }';
      const tap = failed(notOk, 'Exit code 1', '$ node build-ok.cjs', 'build ok', '$ node --test', ...tapFailed, 'not ok');
      expect(tap?.level).toBe('block');
      expect(tap?.message).toContain('  not ok 1 - adds');
    });

    it("does not let the command's own words stand in for failing tests after a later script's line", () => {
      // Put together: the tests pass, lint fails, and a closing printf prints a
      // line with a tab in it that reads like a runner's FAIL line.
      const command = "npm test && npm run lint || printf 'FAILED\\tsrc/lint.log\\n'";
      expect(failed(command, 'Exit code 2', ...passingTest, ...lintFailed, 'FAILED\tsrc/lint.log')).toBeNull();
      // The same where the shell fills in a home directory: the line is not
      // spelled out in the command, but its first words are.
      const withHome = 'npm test && npm run lint || echo FAILED see ~/lint.log';
      expect(failed(withHome, 'Exit code 2', ...passingTest, ...lintFailed, 'FAILED see /home/dave/lint.log')).toBeNull();
    });

    it('asks for a failed test run when the shell prints each command it runs', () => {
      // Put together from what bash prints under `set -x`: the tests pass, and
      // the trace line of the closing echo holds its words too.
      const traced = ['+ npm test', ...passingTest, '+ echo FAILED=0', 'FAILED=0', ''];
      for (const command of ['set -x; npm test; echo "FAILED=$?"', 'set -o xtrace; npm test; echo "FAILED=$?"']) {
        expect(handlePostToolUse('Bash', { command }, tracker, cache, config, undefined, traced.join('\n'))).toBeNull();
      }
    });

    it('leaves out a closing echo that prints its words in color', () => {
      const command = 'npm test; echo -e "\\033[32mno ERROR\\033[0m"';
      const output = [...passingTest, '\x1b[32mno ERROR\x1b[0m', ''].join('\n');
      expect(handlePostToolUse('Bash', { command }, tracker, cache, config, undefined, output)).toBeNull();
    });

    // Later steps that print nothing to mistake for a failure, or that are a
    // test run themselves. The test script's output is read as it is alone.
    it.each([
      'npm test; echo "exit: $?"',
      'npm test && echo ok',
      'npm test || echo failed',
      'npm test || true',
      'npm test; exit 1',
      'npm test # the whole suite',
      'npm test; # then lint',
      'npm test 2>&1 | tee out.log | tail -20',
      'npm test 2>&1 | grep -v "^$" | head -50',
      'npm test 2>&1 | tail -n 40',
      'npm test | grep -E "error|FAIL" | head -n 5 | cat',
      'npm test; code=$?; echo "exit $code"',
      'npm test; status=$?; set +e; wait; echo "exit: $status"',
      'npm test && cd ../api && npm test',
      'cd web && npm test; cd ..',
      // A comment on a line of its own, before or after the script.
      'npm test\n# done',
      'npm test;# done',
      '# run the tests\nnpm test',
      "# don't skip this\nnpm test -- -t 'adds'",
      'npm test # issue #12: "quoted" text',
    ])('reads a test script whole when nothing else can have written to its output: %j', (command) => {
      const plain = failed('npm test', 'Exit code 2', typeError);
      expect(plain?.level).toBe('block');
      expect(failed(command, 'Exit code 2', typeError)).toEqual(plain);
    });

    it('through pnpm, tells a failed lint from a failed test by the line pnpm ends with', () => {
      // Put together from the lines pnpm 11.25.0 prints for each script.
      const tests = ['$ node --test --test-reporter=tap calc-ok.cjs', ...tapPassed];
      const lint = ['$ tsc --noEmit --skipLibCheck check.ts', typeError, '[ELIFECYCLE] Command failed with exit code 2.'];
      expect(failed('pnpm test && pnpm run lint', 'Exit code 2', ...tests, ...lint)).toBeNull();
      const result = failed('pnpm test && pnpm run lint', 'Exit code 2', '$ tsc --noEmit && node --test', typeError, '[ELIFECYCLE] Test failed. See above for more details.');
      expect(result?.level).toBe('block');
    });
  });

  // Inputs that took seconds with a pattern that could match one stretch of
  // text in many ways. The command pattern runs on every Bash command.
  describe('the command and script-line patterns on long input', () => {
    it('reads a long directory of variables quickly', () => {
      const started = performance.now();
      expect(isTestCommand(`cd ${'$NAMEAAAAAAAAAAAAAAAA'.repeat(7)} | cat`)).toBe(false);
      expect(isTestCommand(`cd ${'$A/'.repeat(2_000)}web && npm test`)).toBe(true);
      expect(performance.now() - started).toBeLessThan(1_000);
    });

    it('looks for script lines in a long line quickly', () => {
      const started = performance.now();
      expect(failed('npm run build && npm test', `> ${'@'.repeat(50_000)}`)).toBeNull();
      expect(performance.now() - started).toBeLessThan(1_000);
    });

    it('leaves a command of many thousand characters alone', () => {
      // An unclosed quote followed by escaped quotes was slow to pair up.
      const started = performance.now();
      expect(isTestCommand(`echo "${'\\"'.repeat(200_000)} && npm test`)).toBe(false);
      expect(isTestCommand(`npm test -- ${'a '.repeat(10_000)}`)).toBe(false);
      expect(performance.now() - started).toBeLessThan(1_000);
    });

    it("looks for the command's own words in a long output quickly", () => {
      const command = `npm test; echo "${'no ERROR here '.repeat(600)}"`;
      const output = Array.from({ length: 5_000 }, (_, line) => `no ERROR here ${line} ${'x '.repeat(8)}`);
      const started = performance.now();
      failed(command, 'Exit code 1', ...nodeTest, ...tapFailed, ...output, 'a '.repeat(50_000));
      expect(performance.now() - started).toBeLessThan(1_000);
    });

    it("looks up lines in the command's own words quickly when they all but occur in it", () => {
      // Every line was looked up in the whole command, which took seconds
      // for a long command whose text the lines nearly repeat.
      const command = `npm test; echo ${'a'.repeat(9_900)}`;
      const run = (output: string) => handlePostToolUse('Bash', { command }, tracker, cache, config, undefined, output);
      const started = performance.now();
      expect(run('aab\n'.repeat(25_000))).toBeNull();
      expect(run('aaaaaaab ERROR\n'.repeat(2_000))?.level).toBe('block');
      expect(performance.now() - started).toBeLessThan(1_000);
    });

    it("makes a long line comparable with the command's words quickly", () => {
      // An unclosed `${` scanned to the end of the line from every start, and
      // a run of zeros after a `%` could be read as flags or as a width.
      const started = performance.now();
      for (const line of [`ERROR ${'${'.repeat(50_000)}`, `ERROR %${'0'.repeat(100_000)}`]) {
        expect(handlePostToolUse('Bash', { command: 'npm test; echo done' }, tracker, cache, config, undefined, line)?.level).toBe('block');
      }
      expect(performance.now() - started).toBeLessThan(1_000);
    });

    it('reads the output of a command that names a runner as it always was', () => {
      // What a passing vitest test printed that logs a TAP-like line. Only a
      // package test script is read for what a failed node:test run prints.
      const output = ["stdout | tests/log.test.ts > logs", 'not ok 1 - sample line', '', ' Test Files  1 passed (1)', '      Tests  1 passed (1)'];
      const run = (command: string) => handlePostToolUse('Bash', { command }, tracker, cache, config, undefined, output.join('\n'));
      expect(run('npx vitest run')).toBeNull();
      expect(run('npm test')?.level).toBe('block');
      // The lines a command's own echo prints stay in a runner command's output.
      const echoed = 'npx vitest run; echo "ERROR in the summary"';
      expect(handlePostToolUse('Bash', { command: echoed }, tracker, cache, config, undefined, 'ERROR in the summary')?.level).toBe('block');
    });
  });

  describe('stdout and stderr delivered apart', () => {
    const run = (command: string, stdout: string[], stderr: string[]) =>
      handlePostToolUse('Bash', { command }, tracker, cache, config, undefined, {
        stdout: stdout.join('\n'),
        stderr: stderr.join('\n'),
        interrupted: false,
      });
    const buildLine = ['', '> demo@1.0.0 build', '> node build-config.cjs', ''];
    const buildError = ['ERROR: missing build configuration'];

    // `npm run build; npm test`, exit 0. The build wrote its error to stderr,
    // then the tests ran and passed. Where that error falls among the lines on
    // stdout is not known.
    it('does not hold an error on stderr against tests that passed on stdout', () => {
      const stdout = [...buildLine, '', '> demo@1.0.0 test', '> node mark-test.cjs && node --test --test-reporter=tap calc-ok.cjs', '', ...tapPassed];
      expect(run('npm run build; npm test', stdout, buildError)).toBeNull();
      expect(run('npm run build; npm test || true', stdout, buildError)).toBeNull();
    });

    // `npm run build; npm test || true`, exit 0, with a failing vitest test.
    // vitest writes its summary to stdout and the failure itself to stderr.
    const vitestStdout = [
      ...buildLine,
      '', '> demo@1.0.0 test', '> node mark-test.cjs && vitest run', '',
      ' RUN  v5.1.0 /tmp/demo',
      '',
      ' ❯ tests/sum.test.ts (1 test | 1 failed) 6ms',
      '   × adds 5ms',
      '',
      ' Test Files  1 failed (1)',
      '      Tests  1 failed (1)',
    ];
    const vitestStderr = [
      ...buildError,
      '',
      '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
      '',
      ' FAIL  tests/sum.test.ts > adds',
      'AssertionError: expected 3 to be 4 // Object.is equality',
    ];

    it('reads stderr with the test run when the test run failed', () => {
      const result = run('npm run build; npm test || true', vitestStdout, vitestStderr);
      expect(result?.level).toBe('block');
      expect(result?.message).toContain('FAIL  tests/sum.test.ts > adds');
    });

    it('takes a failed test run on stderr alone as the sign', () => {
      // Put together: the summary lines are cut from stdout.
      const result = run('npm run build; npm test || true', vitestStdout.slice(0, -2), vitestStderr);
      expect(result?.level).toBe('block');
      expect(result?.message).toContain('FAIL  tests/sum.test.ts > adds');
    });

    it('leaves out what the command echoes to stderr itself', () => {
      // Put together: the tests pass, and a closing echo writes to stderr.
      const stdout = ['', '> demo@1.0.0 test', '> node --test', '', ...tapPassed];
      expect(run('npm test; echo "ERROR: 0 problems, see above" >&2', stdout, ['ERROR: 0 problems, see above'])).toBeNull();
    });

    it("does not take the command's own words on stderr for a failed test run", () => {
      // Put together: the build's error and a closing printf's line are on
      // stderr, the passing tests on stdout. The printed line has a tab in it.
      const stdout = [...buildLine, '', '> demo@1.0.0 test', '> node --test', '', ...tapPassed];
      const command = "npm run build; npm test; printf 'FAILED\\tbuild/test\\n' >&2";
      expect(run(command, stdout, [...buildError, 'FAILED\tbuild/test'])).toBeNull();
      // The same where the shell fills in a home directory: the line is not
      // spelled out in the command, but its first words are.
      const withHome = 'npm run build; npm test; echo FAILED see ~/build.log >&2';
      expect(run(withHome, stdout, [...buildError, 'FAILED see /home/dave/build.log'])).toBeNull();
    });

    it('still joins both streams for a test script that runs alone', () => {
      // Put together: the test setup fails and says so on stderr only.
      const result = run('npm test || true', ['', '> demo@1.0.0 test', '> node run-tests.cjs', ''], ['ERROR: could not load the test setup']);
      expect(result?.level).toBe('block');
    });

    // `npm run build; npm test | tail -12`, exit 0, with a failing node:test
    // run: the pipe cut the test script line from stdout.
    it('reports a failing run whose start a pipe cut off', () => {
      const stdout = [...buildLine, '  ...', '1..1', '# tests 1', '# suites 0', '# pass 0', '# fail 1', '# cancelled 0'];
      const result = run('npm run build; npm test | tail -12', stdout, buildError);
      expect(result?.level).toBe('block');
      expect(result?.message).toContain('  # fail 1');
    });
  });

  it('checks a failing npm test whose pipeline exits 0', () => {
    const result = handlePostToolUse(
      'Bash',
      { command: 'npm test 2>&1 | tail -5' },
      tracker,
      cache,
      config,
      undefined,
      'FAIL tests/a.test.ts\nTests: 1 failed',
    );
    expect(result?.message).toContain('ZERO-DEFECT');
  });

  it('checks zero-defect on Bash test commands (legacy tool_input.output fallback)', () => {
    const testOutput = 'FAIL tests/a.test.ts\nTests: 1 failed';
    const result = handlePostToolUse('Bash', { command: 'npx vitest run', output: testOutput }, tracker, cache, config);
    expect(result).not.toBeNull();
    expect(result?.message).toContain('ZERO-DEFECT');
  });

  describe('zero-defect output extraction from the real hook payload (tool_response)', () => {
    // Claude Code's PostToolUse payload delivers command output in
    // `tool_response` (a string, or an object with stdout/stderr) — NOT in
    // `tool_input.output`. The handler must read the real field or the check
    // is dormant in every live session.
    const failingOutput = 'FAIL tests/a.test.ts\nTests: 1 failed';

    it('fires when output arrives as a tool_response string', () => {
      const result = handlePostToolUse(
        'Bash',
        { command: 'npx vitest run' },
        tracker,
        cache,
        config,
        undefined,
        failingOutput,
      );
      expect(result).not.toBeNull();
      expect(result?.message).toContain('ZERO-DEFECT');
    });

    it('fires when output arrives as tool_response { stdout }', () => {
      const result = handlePostToolUse(
        'Bash',
        { command: 'npx vitest run' },
        tracker,
        cache,
        config,
        undefined,
        { stdout: failingOutput },
      );
      expect(result).not.toBeNull();
      expect(result?.message).toContain('ZERO-DEFECT');
    });

    it('joins stdout and stderr when both present (failures often land on stderr)', () => {
      const result = handlePostToolUse(
        'Bash',
        { command: 'npx vitest run' },
        tracker,
        cache,
        config,
        undefined,
        { stdout: 'RUN v3.0.0', stderr: 'FAIL tests/a.test.ts\nTests: 1 failed' },
      );
      expect(result).not.toBeNull();
      expect(result?.message).toContain('ZERO-DEFECT');
    });

    it('prefers tool_response over the legacy tool_input.output when both present', () => {
      const result = handlePostToolUse(
        'Bash',
        { command: 'npx vitest run', output: 'Tests: 5 passed' },
        tracker,
        cache,
        config,
        undefined,
        failingOutput,
      );
      expect(result).not.toBeNull();
      expect(result?.message).toContain('ZERO-DEFECT');
    });

    it('passes cleanly when tool_response shows a passing run', () => {
      const result = handlePostToolUse(
        'Bash',
        { command: 'npx vitest run' },
        tracker,
        cache,
        config,
        undefined,
        'Test Files  1 passed (1)\nTests  5 passed (5)',
      );
      expect(result).toBeNull();
    });

    it('returns null when tool_response carries no string output', () => {
      const result = handlePostToolUse(
        'Bash',
        { command: 'npx vitest run' },
        tracker,
        cache,
        config,
        undefined,
        { interrupted: false },
      );
      expect(result).toBeNull();
    });

    it('threads the cache phase into zero-defect: a tdd+ RED run is advisory, not a block', () => {
      config.rules.zero_defect = { tolerance: 'strict', unrelated_errors: 'block' };
      cache.setPhase('tdd+');
      const result = handlePostToolUse(
        'Bash',
        { command: 'npx vitest run' },
        tracker,
        cache,
        config,
        undefined,
        'FAIL tests/a.test.ts\nTests: 1 failed',
      );
      expect(result).not.toBeNull();
      expect(result?.level).toBe('advise');
    });
  });

  it('checks constitutional on stack test file edits', () => {
    const result = handlePostToolUse(
      'Edit',
      {
        file_path: 'tests/router/resolver.stack.test.ts',
        new_string: "jest.mock('../src/router/resolver.js');",
      },
      tracker,
      cache,
      config,
    );
    expect(result).not.toBeNull();
    expect(result?.message).toContain('no_mocks');
  });

  it('checks constitutional on stack test files written via Write (content, not new_string)', () => {
    // The Write tool delivers file content in `content`, not `new_string`.
    // Constitutional inspection must read `content` or the check is dormant for
    // every file created via Write.
    const result = handlePostToolUse(
      'Write',
      {
        file_path: 'tests/router/resolver.stack.test.ts',
        content: "jest.mock('../src/router/resolver.js');",
      },
      tracker,
      cache,
      config,
    );
    expect(result).not.toBeNull();
    expect(result?.message).toContain('no_mocks');
  });

  it('combines multiple violations into single output', () => {
    // Edit a stack test file with a mock
    const result = handlePostToolUse(
      'Edit',
      {
        file_path: 'tests/router/resolver.stack.test.ts',
        new_string: "vi.mock('../src/config.js');",
      },
      tracker,
      cache,
      config,
    );
    // Should contain the constitutional violation
    expect(result?.message).toContain('no_mocks');
  });

  it('returns null for clean operations', () => {
    const result = handlePostToolUse(
      'Edit',
      { file_path: 'src/router/resolver.ts' },
      tracker,
      cache,
      config,
    );
    expect(result).toBeNull();
  });

  it('captures external graphify stats on mcp__jcodemunch__index_folder', () => {
    const report = [
      '# Graph Report - /external/meridian',
      '',
      '## Summary',
      '- 420 nodes · 891 edges · 67 communities detected',
      '- Extraction: 91% EXTRACTED · 9% INFERRED · 0% AMBIGUOUS',
    ].join('\n');
    const exec = (cmd: string) => {
      if (cmd.includes('test -f')) throw new Error('not found');
      if (cmd.includes('graphify update')) return '';
      if (cmd.includes('GRAPH_REPORT.md')) return report;
      throw new Error(`unexpected: ${cmd}`);
    };

    handlePostToolUse(
      'mcp__jcodemunch__index_folder',
      { path: '/external/meridian' },
      tracker,
      cache,
      config,
      exec,
    );

    const stats = cache.getGraphifyStats('/external/meridian');
    expect(stats).toEqual({
      nodes: 420, edges: 891, communities: 67,
      extractedPct: 91, inferredPct: 9, ambiguousPct: 0,
    });
  });

  it('captures stats when an external graph is built via Bash graphify update', () => {
    const report = [
      '# Graph Report - /external/meridian',
      '',
      '## Summary',
      '- 420 nodes · 891 edges · 67 communities detected',
      '- Extraction: 91% EXTRACTED · 9% INFERRED · 0% AMBIGUOUS',
    ].join('\n');
    // Only the report read is expected: the graph was just built by the Bash
    // command itself, so no test -f / graphify update retry should run.
    const exec = (cmd: string) => {
      if (cmd.includes('GRAPH_REPORT.md')) return report;
      throw new Error(`unexpected: ${cmd}`);
    };

    handlePostToolUse(
      'Bash',
      { command: 'graphify update "/external/meridian"' },
      tracker,
      cache,
      config,
      exec,
    );

    expect(cache.getGraphifyStats('/external/meridian')).toEqual({
      nodes: 420, edges: 891, communities: 67,
      extractedPct: 91, inferredPct: 9, ambiguousPct: 0,
    });
  });

  it('captures stats for unquoted and graphifyy command variants', () => {
    const report = '- 10 nodes · 20 edges · 3 communities detected';
    const exec = (cmd: string) => {
      if (cmd.includes('GRAPH_REPORT.md')) return report;
      throw new Error(`unexpected: ${cmd}`);
    };

    handlePostToolUse(
      'Bash', { command: 'graphifyy update /external/alpha' }, tracker, cache, config, exec,
    );

    expect(cache.getGraphifyStats('/external/alpha')?.nodes).toBe(10);
  });

  it('does not capture stats for Bash graphify update on the CWD', () => {
    const exec = () => { throw new Error('should not be called'); };

    handlePostToolUse(
      'Bash',
      { command: `graphify update "${process.cwd()}"` },
      tracker,
      cache,
      config,
      exec,
    );

    expect(cache.getGraphifyStats(process.cwd())).toBeUndefined();
  });

  it('ignores Bash commands that merely mention graphify without update', () => {
    const exec = () => { throw new Error('should not be called'); };

    expect(() => handlePostToolUse(
      'Bash', { command: 'graphify benchmark "/external/x"' }, tracker, cache, config, exec,
    )).not.toThrow();
    expect(cache.getGraphifyStats('/external/x')).toBeUndefined();
  });

  it('does not capture stats for CWD directory on index_folder', () => {
    const exec = () => '';
    handlePostToolUse(
      'mcp__jcodemunch__index_folder',
      { path: '/home/user/claude-rig' },
      tracker,
      cache,
      config,
      exec,
    );

    // CWD stats are handled by session-start, not post-tool-use
    expect(cache.getGraphifyStats('/home/user/claude-rig')).toBeUndefined();
  });

  it('gracefully handles graphify capture failure on external dir', () => {
    const exec = () => { throw new Error('graphify not installed'); };

    // Should not throw
    handlePostToolUse(
      'mcp__jcodemunch__index_folder',
      { path: '/external/broken' },
      tracker,
      cache,
      config,
      exec,
    );

    expect(cache.getGraphifyStats('/external/broken')).toBeUndefined();
  });

  it('captures external graphify stats on mcp__jcodemunch__resolve_repo', () => {
    const report = [
      '# Graph Report - /home/user/meridian',
      '',
      '## Summary',
      '- 32000 nodes · 91000 edges · 440 communities detected',
      '- Extraction: 90% EXTRACTED · 10% INFERRED · 0% AMBIGUOUS',
    ].join('\n');
    const exec = (cmd: string) => {
      if (cmd.includes('test -f')) throw new Error('not found');
      if (cmd.includes('graphify update')) return '';
      if (cmd.includes('GRAPH_REPORT.md')) return report;
      throw new Error(`unexpected: ${cmd}`);
    };

    handlePostToolUse(
      'mcp__jcodemunch__resolve_repo',
      { path: '/home/user/meridian' },
      tracker,
      cache,
      config,
      exec,
    );

    const stats = cache.getGraphifyStats('/home/user/meridian');
    expect(stats).toEqual({
      nodes: 32000, edges: 91000, communities: 440,
      extractedPct: 90, inferredPct: 10, ambiguousPct: 0,
    });
  });

  it('does not capture stats for CWD on resolve_repo', () => {
    const exec = () => '';
    handlePostToolUse(
      'mcp__jcodemunch__resolve_repo',
      { path: '/home/user/claude-rig' },
      tracker,
      cache,
      config,
      exec,
    );

    expect(cache.getGraphifyStats('/home/user/claude-rig')).toBeUndefined();
  });

  it('gracefully handles graphify failure on resolve_repo', () => {
    const exec = () => { throw new Error('graphify not installed'); };

    handlePostToolUse(
      'mcp__jcodemunch__resolve_repo',
      { path: '/external/unreachable' },
      tracker,
      cache,
      config,
      exec,
    );

    expect(cache.getGraphifyStats('/external/unreachable')).toBeUndefined();
  });

  describe('stale-test detection across hook processes (turn model)', () => {
    // Hooks run as separate processes: every invocation builds a FRESH
    // FileTracker. A "turn" is one PostToolUse Edit/Write invocation, counted
    // in the session cache; the turn-stamped edit history is hydrated into
    // the fresh tracker so a source file edited in an earlier invocation
    // (and not covered by a test edit) fires on a later one.
    function freshInvocation(
      sharedCache: SessionCache,
      filePath: string,
    ): ReturnType<typeof handlePostToolUse> {
      // Fresh tracker per call simulates the separate hook process.
      return handlePostToolUse(
        'Edit',
        { file_path: filePath, old_string: 'a', new_string: 'b' },
        new FileTracker(),
        sharedCache,
        config,
      );
    }

    it('fires on the second consecutive edit of the same source file', () => {
      const first = freshInvocation(cache, 'src/feature/widget.ts');
      expect(first).toBeNull();

      const second = freshInvocation(cache, 'src/feature/widget.ts');
      expect(second).not.toBeNull();
      expect(second?.level).toBe('advise');
      expect(second?.message).toContain('STALE TEST');
      expect(second?.message).toContain('src/feature/widget.ts');
    });

    it('fires for an earlier uncovered source edit when a different file is edited', () => {
      freshInvocation(cache, 'src/feature/widget.ts');
      const result = freshInvocation(cache, 'src/feature/gadget.ts');
      expect(result).not.toBeNull();
      expect(result?.message).toContain('src/feature/widget.ts');
      // The current invocation's edit is exempt (creation turn).
      expect(result?.message).not.toContain('src/feature/gadget.ts');
    });

    it('does not fire once a covering test edit is recorded', () => {
      freshInvocation(cache, 'src/feature/widget.ts');
      freshInvocation(cache, 'tests/feature/widget.test.ts');
      const result = freshInvocation(cache, 'src/feature/widget.ts');
      expect(result).toBeNull();
    });

    it('respects grace_period across invocations', () => {
      config.rules.stale_tests = { enforcement: 'advise', grace_period: 1 };
      freshInvocation(cache, 'src/feature/widget.ts'); // turn 1
      expect(freshInvocation(cache, 'src/feature/widget.ts')).toBeNull(); // turn 2, within grace
      const third = freshInvocation(cache, 'src/feature/widget.ts'); // turn 3, past grace
      expect(third).not.toBeNull();
      expect(third?.message).toContain('STALE TEST');
    });

    it('suppresses a repeat advisory when the stale set is unchanged (dedup)', () => {
      expect(freshInvocation(cache, 'src/feature/widget.ts')).toBeNull();        // turn 1, exempt
      const fires = freshInvocation(cache, 'src/feature/widget.ts');             // turn 2, {widget} → fire
      expect(fires?.message).toContain('STALE TEST');
      // turn 3, identical stale set {widget} → no repeat advisory (advisory fatigue fix)
      expect(freshInvocation(cache, 'src/feature/widget.ts')).toBeNull();
    });

    it('re-fires when a new file joins the stale set', () => {
      freshInvocation(cache, 'src/feature/widget.ts');                           // turn 1, exempt
      expect(freshInvocation(cache, 'src/feature/widget.ts')?.message)           // turn 2, {widget} → fire
        .toContain('STALE TEST');
      // turn 3 edits gadget (its own creation turn is exempt); set still {widget} → suppressed
      expect(freshInvocation(cache, 'src/feature/gadget.ts')).toBeNull();
      // turn 4: gadget is now past its creation turn → set {widget, gadget} changed → re-fire
      const grew = freshInvocation(cache, 'src/feature/gadget.ts');
      expect(grew?.message).toContain('src/feature/gadget.ts');
      expect(grew?.message).toContain('src/feature/widget.ts');
    });
  });

  describe('session cache persistence of edits', () => {
    it('persists source file edits to the session cache', () => {
      handlePostToolUse('Edit', { file_path: 'src/router/resolver.ts' }, tracker, cache, config);
      expect(cache.getEditedFiles('source')).toEqual(['src/router/resolver.ts']);
    });

    it('persists test file edits to the session cache', () => {
      handlePostToolUse('Write', { file_path: 'tests/router/resolver.test.ts' }, tracker, cache, config);
      expect(cache.getEditedFiles('test')).toEqual(['tests/router/resolver.test.ts']);
      expect(cache.getEditedFiles('source')).toEqual([]);
    });

    it('does not persist non-source/non-test files', () => {
      handlePostToolUse('Edit', { file_path: 'docs/architecture.md' }, tracker, cache, config);
      expect(cache.getEditedFiles('source')).toEqual([]);
      expect(cache.getEditedFiles('test')).toEqual([]);
    });
  });

  describe('structured severity', () => {
    it('returns level advise for an advise-level constitutional violation', () => {
      const result = handlePostToolUse(
        'Edit',
        {
          file_path: 'tests/router/resolver.stack.test.ts',
          new_string: "vi.mock('../src/config.js');",
        },
        tracker,
        cache,
        config,
      );
      expect(result).not.toBeNull();
      expect(result?.level).toBe('advise');
      expect(result?.message).toContain('no_mocks');
    });

    it('returns level block for a block-level constitutional violation', () => {
      const result = handlePostToolUse(
        'Edit',
        { file_path: 'src/notes.ts', new_string: '// all tests pass' },
        tracker,
        cache,
        config,
      );
      expect(result).not.toBeNull();
      expect(result?.level).toBe('block');
      expect(result?.message).toContain('evidence_only');
    });

    it('does not escalate an advise-level zero-defect result whose output embeds the literal [BLOCK]', () => {
      config.rules.zero_defect = { tolerance: 'permissive' };
      const testOutput = [
        "FAIL tests/hooks.test.ts > emits the '[BLOCK]' prefix for block-level rules",
        'Tests: 1 failed',
      ].join('\n');

      const result = handlePostToolUse(
        'Bash',
        { command: 'npx vitest run', output: testOutput },
        tracker,
        cache,
        config,
      );
      expect(result).not.toBeNull();
      expect(result?.level).toBe('advise');
      // The message legitimately contains the literal string '[BLOCK]' from
      // the embedded test output — the level must come from the check, not
      // from sniffing the message text.
      expect(result?.message).toContain('[BLOCK]');
    });

    it('combines to level block when any violation is block-level', () => {
      // Stale-test advisory (advise-level) + evidence_only (block-level)
      // fire in the same call: combined level must be block.
      tracker.recordEdit('src/other.ts');
      tracker.nextTurn();
      const result = handlePostToolUse(
        'Edit',
        { file_path: 'src/notes.ts', new_string: '// all tests pass' },
        tracker,
        cache,
        config,
      );
      expect(result).not.toBeNull();
      expect(result?.message).toContain('STALE TEST');
      expect(result?.message).toContain('evidence_only');
      expect(result?.level).toBe('block');
    });
  });

  describe('skill phase tracking', () => {
    it('sets tdd+ phase when the tdd-plus skill is invoked', () => {
      const result = handlePostToolUse('Skill', { skill: 'tdd-plus' }, tracker, cache, config);
      expect(cache.getCurrentPhase()).toBe('tdd+');
      expect(result).toBeNull();
    });

    it('sets sdd+ phase when the sdd-plus skill is invoked', () => {
      handlePostToolUse('Skill', { skill: 'sdd-plus' }, tracker, cache, config);
      expect(cache.getCurrentPhase()).toBe('sdd+');
    });

    it('sets verify+ phase when verify-plus is invoked (exits scoped-test phases)', () => {
      handlePostToolUse('Skill', { skill: 'tdd-plus' }, tracker, cache, config);
      handlePostToolUse('Skill', { skill: 'verify-plus' }, tracker, cache, config);
      expect(cache.getCurrentPhase()).toBe('verify+');
    });

    it('maps investigate to debug+ phase', () => {
      handlePostToolUse('Skill', { skill: 'investigate' }, tracker, cache, config);
      expect(cache.getCurrentPhase()).toBe('debug+');
    });

    it('strips plugin namespaces from skill names', () => {
      handlePostToolUse('Skill', { skill: 'my-plugin:tdd-plus' }, tracker, cache, config);
      expect(cache.getCurrentPhase()).toBe('tdd+');
    });

    it('ignores skills that are not chain phases', () => {
      handlePostToolUse('Skill', { skill: 'tdd-plus' }, tracker, cache, config);
      handlePostToolUse('Skill', { skill: 'savings' }, tracker, cache, config);
      expect(cache.getCurrentPhase()).toBe('tdd+');
    });

    it('clears edited-file history when entering tdd+ from no phase', () => {
      cache.addEditedFile('src/old-feature.ts', 'source');
      cache.addEditedFile('tests/old-feature.test.ts', 'test');
      handlePostToolUse('Skill', { skill: 'tdd-plus' }, tracker, cache, config);
      expect(cache.getEditedFiles('source')).toEqual([]);
      expect(cache.getEditedFiles('test')).toEqual([]);
    });

    it('clears edited-file history when entering a scoped phase from a different phase', () => {
      handlePostToolUse('Skill', { skill: 'verify-plus' }, tracker, cache, config);
      cache.addEditedFile('src/feature-one.ts', 'source');
      handlePostToolUse('Skill', { skill: 'sdd-plus' }, tracker, cache, config);
      expect(cache.getEditedFiles('source')).toEqual([]);
    });

    it('does not clear edited-file history when re-entering the same scoped phase', () => {
      handlePostToolUse('Skill', { skill: 'tdd-plus' }, tracker, cache, config);
      handlePostToolUse('Edit', { file_path: 'src/feature.ts' }, tracker, cache, config);
      handlePostToolUse('Skill', { skill: 'tdd-plus' }, tracker, cache, config);
      expect(cache.getEditedFiles('source')).toEqual(['src/feature.ts']);
    });

    it('does not clear edited-file history when entering a non-scoped phase', () => {
      handlePostToolUse('Skill', { skill: 'tdd-plus' }, tracker, cache, config);
      handlePostToolUse('Edit', { file_path: 'src/feature.ts' }, tracker, cache, config);
      handlePostToolUse('Skill', { skill: 'verify-plus' }, tracker, cache, config);
      expect(cache.getEditedFiles('source')).toEqual(['src/feature.ts']);
    });

    it('covers every phase-tracker phase in SKILL_PHASE_MAP', () => {
      // If a future chain skill adds a phase to PHASE_ORDER without a skill
      // name mapping here, phase tracking silently misses it.
      const reachablePhases = new Set(Object.values(SKILL_PHASE_MAP));
      for (const phase of new SkillPhaseTracker().getAllPhases()) {
        expect(reachablePhases).toContain(phase);
      }
    });

    it('maps every SKILL_PHASE_MAP value to a valid tracker phase', () => {
      const trackerPhases = new Set<string>(new SkillPhaseTracker().getAllPhases());
      for (const phase of Object.values(SKILL_PHASE_MAP)) {
        expect(trackerPhases).toContain(phase);
      }
    });
  });
});

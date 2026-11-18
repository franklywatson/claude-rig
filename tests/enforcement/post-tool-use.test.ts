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

    it.each(['not ok 1 - adds', '    not ok 2 - a nested test', '# fail 1'])(
      'reads the TAP line %j as a failing test run',
      (tapLine) => {
        const output = ['Exit code 1', '$ node --test', '# ERROR: total came back as text', tapLine].join('\n');
        expect(
          handlePostToolUseFailure('Bash', { command: 'pnpm run build && pnpm test' }, output, cache, config)?.level,
        ).toBe('block');
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

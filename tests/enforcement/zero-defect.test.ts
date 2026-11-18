import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkZeroDefect,
  classifyFailures,
  comparable,
  readsAsFailure,
  showsFailedTestRun,
  type ClassifiedFailure,
} from '../../src/enforcement/zero-defect.js';
import type { HarnessConfig } from '../../src/types.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

describe('checkZeroDefect', () => {
  let config: HarnessConfig;

  beforeEach(() => {
    config = structuredClone(DEFAULT_CONFIG);
  });

  it('returns null for clean test output', () => {
    const output = [
      '✓ tests/router/resolver.test.ts (3 tests)',
      '✓ tests/router/rules.test.ts (5 tests)',
      '',
      'Tests: 8 passed',
      'Time: 1.2s',
    ].join('\n');

    const result = checkZeroDefect(output, config);
    expect(result).toBeNull();
  });

  it('detects FAIL in test output', () => {
    const output = [
      'FAIL tests/router/resolver.test.ts',
      '  resolve() with empty rules',
      '  AssertionError: expected "allow" received "block"',
      '',
      'Tests: 1 failed, 7 passed',
    ].join('\n');

    const result = checkZeroDefect(output, config);
    expect(result).not.toBeNull();
    expect(result?.message).toContain('ZERO-DEFECT');
    expect(result?.message).toContain('FAIL');
  });

  it('detects ERROR in test output', () => {
    const output = [
      'ERROR tests/setup.ts',
      '  Cannot find module ../src/types',
    ].join('\n');

    const result = checkZeroDefect(output, config);
    expect(result).not.toBeNull();
    expect(result?.message).toContain('ERROR');
  });

  it('detects TypeScript compilation errors', () => {
    const output = [
      'src/router/resolver.ts(42,5): error TS2322: Type "string" is not assignable to type "Resolution"',
    ].join('\n');

    const result = checkZeroDefect(output, config);
    expect(result).not.toBeNull();
    expect(result?.message).toContain('TS2322');
  });

  it('detects Python test failures', () => {
    const output = [
      'FAILED tests/test_config.py::test_load_config - AssertionError',
      '=== 1 failed, 12 passed in 2.1s ===',
    ].join('\n');

    const result = checkZeroDefect(output, config);
    expect(result).not.toBeNull();
    expect(result?.message).toContain('FAILED');
  });

  it('extracts failure summary lines', () => {
    const output = [
      'FAIL tests/router/resolver.test.ts > resolve with empty rules',
      'FAIL tests/router/rules.test.ts > findMatchingRule returns undefined',
      '',
      'Tests: 2 failed, 6 passed',
    ].join('\n');

    const result = checkZeroDefect(output, config);
    expect(result?.message).toContain('2 failure(s) found');
    expect(result?.message).toContain('resolver.test.ts');
    expect(result?.message).toContain('rules.test.ts');
  });

  it('respects permissive tolerance mode', () => {
    config.rules.zero_defect = { tolerance: 'permissive' };
    const output = 'FAIL tests/a.test.ts\nTests: 1 failed';
    const result = checkZeroDefect(output, config);
    // Permissive mode still flags but as advise
    expect(result?.message).toContain('[ADVISE]');
    expect(result?.level).toBe('advise');
  });

  it('uses block in strict mode', () => {
    config.rules.zero_defect = { tolerance: 'strict' };
    const output = 'FAIL tests/a.test.ts\nTests: 1 failed';
    const result = checkZeroDefect(output, config);
    expect(result?.message).toContain('[BLOCK]');
    expect(result?.level).toBe('block');
  });

  it('returns null for warning-only output in permissive mode', () => {
    config.rules.zero_defect = { tolerance: 'permissive' };
    const output = [
      'WARN tests/deprecated.test.ts',
      '  This test uses deprecated API',
      '',
      'Tests: 10 passed',
    ].join('\n');
    const result = checkZeroDefect(output, config);
    expect(result).toBeNull();
  });
});

describe('classifyFailures', () => {
  it('classifies all failures as pre-existing when no files changed', () => {
    const output = [
      'FAIL tests/router/resolver.test.ts',
      'FAIL tests/router/rules.test.ts',
      '',
      'Tests: 2 failed',
    ].join('\n');

    const result = classifyFailures(output, []);
    expect(result.regressions).toHaveLength(0);
    expect(result.preExisting).toHaveLength(2);
    expect(result.preExisting[0]).toContain('resolver.test.ts');
    expect(result.preExisting[1]).toContain('rules.test.ts');
  });

  it('classifies failures in changed files as regressions', () => {
    const output = [
      'FAIL tests/router/resolver.test.ts',
      'FAIL tests/router/rules.test.ts',
    ].join('\n');

    const result = classifyFailures(output, ['tests/router/resolver.test.ts']);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]).toContain('resolver.test.ts');
    expect(result.preExisting).toHaveLength(1);
    expect(result.preExisting[0]).toContain('rules.test.ts');
  });

  it('classifies all failures as regressions when all files changed', () => {
    const output = [
      'FAIL tests/router/resolver.test.ts',
      'FAIL tests/router/rules.test.ts',
    ].join('\n');

    const result = classifyFailures(output, [
      'tests/router/resolver.test.ts',
      'tests/router/rules.test.ts',
    ]);
    expect(result.regressions).toHaveLength(2);
    expect(result.preExisting).toHaveLength(0);
  });

  it('returns empty classification for clean output', () => {
    const output = 'Tests: 8 passed\nTime: 1.2s';
    const result = classifyFailures(output, ['src/foo.ts']);
    expect(result.regressions).toHaveLength(0);
    expect(result.preExisting).toHaveLength(0);
  });

  it('handles pytest FAILED format', () => {
    const output = 'FAILED tests/test_config.py::test_load_config - AssertionError';
    const result = classifyFailures(output, []);
    expect(result.preExisting).toHaveLength(1);
    expect(result.preExisting[0]).toContain('test_config.py');
  });

  it('handles ERROR format', () => {
    const output = 'ERROR tests/setup.ts\n  Cannot find module';
    const result = classifyFailures(output, ['tests/setup.ts']);
    expect(result.regressions).toHaveLength(1);
    expect(result.preExisting).toHaveLength(0);
  });

  it('matches source files to test files (src/foo.ts -> tests/foo.test.ts)', () => {
    const output = [
      'FAIL tests/router/resolver.test.ts',
      'FAIL tests/enforcement/zero-defect.test.ts',
    ].join('\n');

    // Changed source file should match corresponding test file
    const result = classifyFailures(output, ['src/router/resolver.ts']);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]).toContain('resolver.test.ts');
    expect(result.preExisting).toHaveLength(1);
    expect(result.preExisting[0]).toContain('zero-defect.test.ts');
  });
});

describe('checkZeroDefect with changedFiles', () => {
  let config: HarnessConfig;

  beforeEach(() => {
    config = structuredClone(DEFAULT_CONFIG);
  });

  it('blocks on regressions, advises on pre-existing by default', () => {
    config.rules.zero_defect = { tolerance: 'strict', unrelated_errors: 'advise' };
    const output = [
      'FAIL tests/router/resolver.test.ts',
      'FAIL tests/router/rules.test.ts',
    ].join('\n');

    const result = checkZeroDefect(output, config, ['tests/router/resolver.test.ts']);
    expect(result).not.toBeNull();
    expect(result?.message).toContain('[BLOCK]');
    expect(result?.message).toContain('regression');
    expect(result?.message).toContain('[ADVISE]');
    expect(result?.message).toContain('pre-existing');
    expect(result?.level).toBe('block'); // regressions present → block wins
  });

  it('reports pre-existing-only failures as advise-level', () => {
    config.rules.zero_defect = { tolerance: 'strict', unrelated_errors: 'advise' };
    const output = 'FAIL tests/old.test.ts';

    const result = checkZeroDefect(output, config, []);
    expect(result).not.toBeNull();
    expect(result?.level).toBe('advise');
    expect(result?.message).toContain('pre-existing');
  });

  it('blocks everything when unrelated_errors is block', () => {
    config.rules.zero_defect = { tolerance: 'strict', unrelated_errors: 'block' };
    const output = 'FAIL tests/old.test.ts';

    const result = checkZeroDefect(output, config, []);
    expect(result?.message).toContain('[BLOCK]');
    expect(result?.message).not.toContain('pre-existing');
  });

  it('suppresses pre-existing when unrelated_errors is silent', () => {
    config.rules.zero_defect = { tolerance: 'strict', unrelated_errors: 'silent' };
    const output = 'FAIL tests/old.test.ts';

    const result = checkZeroDefect(output, config, []);
    // All failures are pre-existing, silent mode = null (suppress)
    expect(result).toBeNull();
  });

  it('still blocks regressions when unrelated_errors is silent', () => {
    config.rules.zero_defect = { tolerance: 'strict', unrelated_errors: 'silent' };
    const output = 'FAIL tests/router/resolver.test.ts';

    const result = checkZeroDefect(output, config, ['tests/router/resolver.test.ts']);
    expect(result).not.toBeNull();
    expect(result?.message).toContain('[BLOCK]');
  });

  it('falls back to original behavior when changedFiles is undefined', () => {
    config.rules.zero_defect = { tolerance: 'strict' };
    const output = 'FAIL tests/a.test.ts';

    const result = checkZeroDefect(output, config);
    expect(result?.message).toContain('[BLOCK]');
    expect(result?.message).not.toContain('regression');
    expect(result?.message).not.toContain('pre-existing');
  });

  it('handles mixed regressions and pre-existing with silent', () => {
    config.rules.zero_defect = { tolerance: 'strict', unrelated_errors: 'silent' };
    const output = [
      'FAIL tests/new.test.ts',
      'FAIL tests/old.test.ts',
    ].join('\n');

    const result = checkZeroDefect(output, config, ['tests/new.test.ts']);
    expect(result).not.toBeNull();
    expect(result?.message).toContain('[BLOCK]');
    expect(result?.message).toContain('new.test.ts');
    expect(result?.message).not.toContain('old.test.ts');
  });
});

describe('checkZeroDefect phase awareness (tdd+/sdd+ RED exemption)', () => {
  let config: HarnessConfig;

  beforeEach(() => {
    config = structuredClone(DEFAULT_CONFIG);
    config.rules.zero_defect = { tolerance: 'strict', unrelated_errors: 'block' };
  });

  const failing = 'FAIL tests/widget.test.ts\nTests: 1 failed, 0 passed';

  it('downgrades a strict block to advisory during tdd+ (the expected RED step)', () => {
    const result = checkZeroDefect(failing, config, undefined, 'tdd+');
    expect(result).not.toBeNull();
    expect(result?.level).toBe('advise');
  });

  it('downgrades during sdd+ as well', () => {
    expect(checkZeroDefect(failing, config, undefined, 'sdd+')?.level).toBe('advise');
  });

  it('still blocks during verify+ (final verification is where green is mandatory)', () => {
    expect(checkZeroDefect(failing, config, undefined, 'verify+')?.level).toBe('block');
  });

  it('still blocks when no phase is set — default behavior unchanged', () => {
    expect(checkZeroDefect(failing, config, undefined, null)?.level).toBe('block');
    expect(checkZeroDefect(failing, config)?.level).toBe('block');
  });

  it('downgrades a regression block to advisory during tdd+ (changed-files path)', () => {
    const output = 'FAIL tests/router/resolver.test.ts\nTests: 1 failed';
    // resolver.test.ts is a changed file → normally a blocking regression
    const result = checkZeroDefect(output, config, ['tests/router/resolver.test.ts'], 'tdd+');
    expect(result?.level).toBe('advise');
  });
});

// A failing node:test run prints none of the words the check has always
// looked for (FAIL, ERROR, "N failed"). For the output of a package test
// script (the last argument of checkZeroDefect) the check reads what only a
// failed test run prints. A command that names a runner is read as it always
// was. The fixtures are what Node 22.23.5 really printed for
// `assert.equal(2 + 2, 5)` with the default message, first as TAP and then
// through the spec reporter (the stack is left out).
describe('checkZeroDefect on the output of a package test script', () => {
  let config: HarnessConfig;
  const check = (output: string, changedFiles?: string[], phase?: string) =>
    checkZeroDefect(output, config, changedFiles, phase, true);

  beforeEach(() => {
    config = structuredClone(DEFAULT_CONFIG);
  });

  const tapFailed = [
    'TAP version 13',
    '# Subtest: adds',
    'not ok 1 - adds',
    '  ---',
    '  duration_ms: 0.98525',
    "  type: 'test'",
    "  location: '/tmp/demo/calc.cjs:4:1'",
    "  failureType: 'testCodeFailure'",
    "  error: '4 == 5'",
    "  code: 'ERR_ASSERTION'",
    "  name: 'AssertionError'",
    '  expected: 5',
    '  actual: 4',
    "  operator: '=='",
    '  ...',
    '1..1',
    '# tests 1',
    '# suites 0',
    '# pass 0',
    '# fail 1',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
    '# duration_ms 40.258178',
  ].join('\n');
  const specFailed = [
    '✖ adds (0.99643ms)',
    'ℹ tests 1',
    'ℹ suites 0',
    'ℹ pass 0',
    'ℹ fail 1',
    'ℹ cancelled 0',
    'ℹ skipped 0',
    'ℹ todo 0',
    'ℹ duration_ms 36.459353',
    '',
    '✖ failing tests:',
    '',
    'test at calc.cjs:4:1',
    '✖ adds (0.99643ms)',
    '  AssertionError [ERR_ASSERTION]: 4 == 5',
    '      at TestContext.<anonymous> (/tmp/demo/calc.cjs:5:10) {',
    '    generatedMessage: true,',
    "    code: 'ERR_ASSERTION',",
    '    actual: 4,',
    '    expected: 5,',
    "    operator: '==',",
    '  }',
  ].join('\n');
  // One passing test, one failing test marked TODO, one skipped test: exit 0.
  const tapGreenWithTodoAndSkip = [
    'TAP version 13',
    '# Subtest: adds',
    'ok 1 - adds',
    '# Subtest: rounds',
    'not ok 2 - rounds # TODO not written yet',
    '  ---',
    "  failureType: 'testCodeFailure'",
    "  error: '3 == 2'",
    "  code: 'ERR_ASSERTION'",
    '  ...',
    '# Subtest: divides',
    'ok 3 - divides # SKIP waiting for the parser',
    '1..3',
    '# tests 3',
    '# pass 1',
    '# fail 0',
    '# skipped 1',
    '# todo 1',
  ].join('\n');

  it('blocks on a failing TAP result and names the test', () => {
    const result = check(tapFailed);
    expect(result?.level).toBe('block');
    expect(result?.message).toContain('1 failure(s) found');
    expect(result?.message).toContain('  not ok 1 - adds');
  });

  it('advises during tdd+', () => {
    expect(check(tapFailed, undefined, 'tdd+')?.level).toBe('advise');
  });

  it('still reports when changed files are known, whatever they are', () => {
    // A TAP result carries no file path, so it cannot be set aside as a
    // failure in an untouched file.
    for (const changed of [['calc.cjs', 'src/other.ts'], ['src/unrelated.ts']]) {
      const result = check(tapFailed, changed);
      expect(result?.level).toBe('block');
      expect(result?.message).toContain('not ok 1 - adds');
    }
  });

  it('lists each failed test once in spec reporter output, which names it twice', () => {
    const result = check(specFailed);
    expect(result?.level).toBe('block');
    expect(result?.message).toContain('1 failure(s) found');
    expect(result?.message).toContain('  ✖ adds (0.99643ms)');
    expect(result?.message).not.toContain('failing tests:');
  });

  it('does not list a TODO test the spec reporter marks with ✖', () => {
    // What Node 22.23.5 printed for one failing test and one failing TODO test.
    const result = check(['✖ adds (0.89ms)', '✖ rounds (0.27ms) # not written yet', 'ℹ pass 0', 'ℹ fail 1', 'ℹ todo 1'].join('\n'));
    expect(result?.message).toContain('1 failure(s) found');
    expect(result?.message).not.toContain('rounds');
  });

  it('treats checked test titles as passing even when they quote a real diagnostic', () => {
    const green = "   \x1b[32m✓\x1b[0m reports error TS2322 and FAIL 324ms";
    expect(check(green)).toBeNull();
    const mixed = check(green + '\n FAIL  tests/sum.test.ts > adds');
    expect(mixed?.message).toContain('1 failure(s) found');
    expect(mixed?.message).not.toContain('TS2322');
  });

  it('respects TODO results whose titles quote errors in either Node reporter', () => {
    expect(check('not ok 1 - handles ERROR output # TODO\n# fail 0')).toBeNull();
    expect(check('✖ handles ERROR output (0.51ms) # TODO\nℹ fail 0')).toBeNull();
  });

  it.each([
    ['✖ waits for message (1.2ms)\nℹ fail 0\nℹ cancelled 1', '✖ waits for message (1.2ms)'],
    ['✖ adds (1ms)', '✖ adds (1ms)'],
    ['ℹ fail 0\nℹ cancelled 1', 'ℹ cancelled 1'],
  ])('reports a cancelled or filtered spec run: %j', (output, expected) => {
    expect(check(output)?.message).toContain(expected);
  });

  it('does not list what another tool marks with ✖', () => {
    // eslint closes with such a line. A test script can run it before its tests.
    const result = check(`✖ 1 problem (1 error, 0 warnings)\n${tapFailed}`);
    expect(result?.message).toContain('1 failure(s) found');
    expect(result?.message).not.toContain('problem');
  });

  it('lists nested TAP results, and every test in a run with several failures', () => {
    const result = check(['not ok 1 - adds', '    not ok 1 - carries', 'not ok 2 - rounds', '# fail 2'].join('\n'));
    expect(result?.message).toContain('3 failure(s) found');
    expect(result?.message).toContain('  not ok 1 - carries');
  });

  it('takes a TAP result with a description and no number', () => {
    expect(check('ok 1 - adds\nnot ok - rounds')?.message).toContain('  not ok - rounds');
  });

  // The start of the output can be cut off (`| tail -3`), or the test script
  // can fail without printing anything of its own. The line the run closed
  // with is then all there is to list.
  it.each([
    ['# pass 0\n# fail 1\n# cancelled 0', '# fail 1'],
    ['ℹ pass 0\nℹ fail 2\nℹ cancelled 0', 'ℹ fail 2'],
    [
      '$ node mark-test.cjs && node -e "process.exit(1)"\n[ELIFECYCLE] Test failed. See above for more details.',
      '[ELIFECYCLE] Test failed. See above for more details.',
    ],
    // What vitest 5.1.0 really printed last for a failing test.
    ['      Tests  1 failed (1)\n   Start at  13:48:21\n   Duration  124ms', 'Tests  1 failed (1)'],
    // Both summary lines are there: one line is listed, not one failure each.
    [' Test Files  1 failed (1)\n      Tests  1 failed (1)\n   Start at  13:48:21', 'Tests  1 failed (1)'],
  ])('falls back to the line the run closed with when no failure is named: %j', (output, line) => {
    const result = check(output);
    expect(result?.level).toBe('block');
    expect(result?.message).toContain('1 failure(s) found');
    expect(result?.message).toContain(`  ${line}`);
    // With changed files known, a result with no failure line used to be
    // dropped as "nothing in the files you changed".
    expect(check(output, ['src/unrelated.ts'])?.level).toBe('block');
  });

  it('lists the named failures and not the closing lines when both are there', () => {
    const tap = check(`${tapFailed}\n[ELIFECYCLE] Test failed. See above for more details.`);
    expect(tap?.message).toContain('1 failure(s) found');
    expect(tap?.message).not.toContain('  # fail 1');
    expect(tap?.message).not.toContain('ELIFECYCLE');
    const vitest = check(' FAIL  tests/sum.test.ts > adds\n Test Files  1 failed (1)\n      Tests  1 failed (1)');
    expect(vitest?.message).toContain('1 failure(s) found');
    expect(vitest?.message).not.toContain('Tests  1 failed');
  });

  // What the tools really printed with FORCE_COLOR=1: pnpm 11.25.0's closing
  // line, and vitest 5.1.0's FAIL and summary lines.
  const coloredPnpmLine =
    '\x1b[41m\x1b[31m[\x1b[39m\x1b[49m\x1b[41m\x1b[30mELIFECYCLE\x1b[39m\x1b[49m\x1b[41m\x1b[31m]\x1b[39m\x1b[49m \x1b[31mTest failed. See above for more details.\x1b[39m';
  const coloredVitestFail = '\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m tests/sum.test.ts\x1b[2m > \x1b[22madds';
  const coloredVitestSummary = [
    '\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m\x1b[90m (1)\x1b[39m',
    '\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m\x1b[90m (1)\x1b[39m',
  ].join('\n');

  it('reads the closing line pnpm prints in color', () => {
    expect(showsFailedTestRun(coloredPnpmLine)).toBe(true);
    const result = check(coloredPnpmLine);
    expect(result?.level).toBe('block');
    expect(result?.message).toContain('  [ELIFECYCLE] Test failed. See above for more details.');
  });

  it('reads a failing vitest run printed in color, and lists its FAIL line', () => {
    const result = check(`${coloredVitestFail}\nAssertionError: expected 3 to be 4\n${coloredVitestSummary}`);
    expect(result?.level).toBe('block');
    expect(result?.message).toContain('1 failure(s) found');
    expect(result?.message).toContain('  FAIL  tests/sum.test.ts > adds');
  });

  it('reads a colored vitest summary whose failure lines were cut off', () => {
    expect(showsFailedTestRun(coloredVitestSummary)).toBe(true);
    expect(check(coloredVitestSummary)?.level).toBe('block');
    expect(check(coloredVitestSummary, ['src/sum.ts'])?.level).toBe('block');
  });

  it('says nothing about a passing run with a TODO failure and a skipped test', () => {
    expect(check(tapGreenWithTodoAndSkip)).toBeNull();
    expect(check(tapGreenWithTodoAndSkip, ['calc.cjs'])).toBeNull();
    expect(showsFailedTestRun(tapGreenWithTodoAndSkip)).toBe(false);
  });

  it.each([
    'not ok 2 - rounds # TODO not written yet',
    'not ok 2 - rounds # todo',
    'not ok 3 - divides # SKIP waiting for the parser',
    '# fail 0',
    'ℹ fail 0',
    'notes: not ok 1 of the checks ran',
    'ok 1 - not ok 2 is the next test',
    'not ok to merge yet',
    'not ok',
    'Not OK 3 - shouting',
  ])('does not take %j for a failed test', (line) => {
    expect(check(`ok 1 - adds\n${line}\n# pass 1`)).toBeNull();
    expect(showsFailedTestRun(line)).toBe(false);
  });

  // The output of a command that names a runner is read as on master: with
  // the words the check has always looked for, in the output as it arrived.
  it('leaves the output of a command that names a runner as it was', () => {
    expect(checkZeroDefect(tapFailed, config)).toBeNull();
    expect(checkZeroDefect("console.log: 'not ok 1 - sample line'\nnot ok 1 - sample line\n Tests  1 passed (1)", config)).toBeNull();
    expect(checkZeroDefect(coloredPnpmLine, config)).toBeNull();
    expect(checkZeroDefect('\x1b[31mERROR\x1b[39m in the test setup', config)).toBeNull();
    expect(checkZeroDefect('      Tests  1 failed (1)\n   Duration  124ms', config, ['src/sum.ts'])).toBeNull();
    const plain = checkZeroDefect(' FAIL  tests/sum.test.ts > adds\n Tests  1 failed (1)\n✖ 1 problem (1 error, 0 warnings)', config);
    expect(plain?.message).toContain('1 failure(s) found');
    // The lines listed are the old ones too: a TAP result is not among them.
    expect(checkZeroDefect('ERROR in the test setup\nnot ok 1 - adds', config)?.message).toContain('1 failure(s) found');
  });

  it('reads the old words in the output as it arrived, for a package script too', () => {
    expect(check('\x1b[31mERROR\x1b[39m in the test setup')).toBeNull();
    expect(check('ERROR in the test setup')?.level).toBe('block');
  });
});

// `npm run build && npm test || echo "FAILED - see build.log"` prints the
// words of a sign itself, whether or not the tests ran. The second argument
// is what the command says, made comparable.
describe('showsFailedTestRun for a sign the command spells out', () => {
  it.each([
    ['FAILED - see build.log', 'echo "FAILED - see build.log"'],
    ['FAILED\tbuild/test', 'printf FAILED build/test'],
    ['FAILED see /home/me/build.log', 'echo FAILED see ~/build.log'],
    ['\x1b[31mFAILED\x1b[0m - see build.log', 'echo -e "FAILED - see build.log"'],
    ['FAILED - SEE BUILD.LOG', 'echo "failed - see build.log" | tr a-z A-Z'],
    ['not ok 1 - build or tests', '{ echo "not ok 1 - build or tests"; exit 1; }'],
    ['not ok 7 - build or tests', 'echo "not" "ok 0 - build or tests"'],
    ['Tests: 1 failed, 0 passed', 'printf "Tests: 1 failed, 0 passed"'],
    ['# fail 1', 'echo "# fail 1"'],
    ['ℹ fail 1', 'echo "ℹ fail 1"'],
    ['[ELIFECYCLE] Test failed. See above for more details.', 'echo "[ELIFECYCLE] Test failed. See above for more details."'],
  ])('does not count %j', (line, said) => {
    expect(showsFailedTestRun(line)).toBe(true);
    expect(showsFailedTestRun(line, comparable(said))).toBe(false);
  });

  // The words alone do not switch a sign off: a filter, a test name or a
  // commit message can hold them and print nothing.
  it.each([
    [' FAIL  tests/sum.test.ts > adds', 'npm test 2>&1 | grep -E "FAIL|failed"'],
    [' Test Files  1 failed (1)', 'npm test 2>&1 | grep -E "FAIL|failed"'],
    ['Tests:       1 failed, 1 total', 'npm test -- -t "failed login" 2>&1 | tail -2'],
    ['FAILED tests/test_sum.py::test_adds - assert 3 == 4', 'npm test || echo "FAILED 0"'],
    ['not ok 1 - adds', 'npm test | grep "not ok"'],
    ['# fail 1', 'set -e; npm test # fail fast'],
    [' FAIL  tests/sum.test.ts > adds', 'npm test; git commit -m "fix: FAILED state no longer reported as failed"'],
  ])('still counts %j when the command says %j', (line, said) => {
    expect(showsFailedTestRun(line, comparable(said))).toBe(true);
  });
});

describe('comparable', () => {
  it.each([
    ['FAILED=$?', 'failed=0'],
    ['"FAILED=$code"', 'failed=0'],
    ['FAILED: ${PIPESTATUS[0]}', 'failed: 0'],
    ["'FAILED=%d' 12", 'failed=0 0'],
    ['\x1b[31mFAILED\x1b[0m\t  build/test ', 'failed build/test'],
    ['"FA""ILED" - see build.log', 'failed - see build.log'],
    // As a command writes them, and as a plain `echo` prints them.
    ['FAILED=$?\\n', 'failed=0'],
    ['\\033[31mFAILED\\033[0m\\tbuild/test', 'failed build/test'],
    ['FAILED \\"build/test\\"', 'failed build/test'],
  ])('reads %j as %j', (text, expected) => {
    expect(comparable(text)).toBe(expected);
  });

  // A stretch of text that could be matched in more than one way.
  it.each([
    ['unclosed braces', '${'.repeat(50_000)],
    ['zeros after a percent sign', `%${'0'.repeat(100_000)}`],
    ['color codes that never end', '\x1b['.repeat(50_000)],
    ['backslashes', '\\'.repeat(100_000)],
  ])('reads a long line of %s quickly', (_name, line) => {
    const started = performance.now();
    comparable(line);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('readsAsFailure', () => {
  it.each([
    'FAILED=0',
    'no ERROR here',
    "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    '0 failed',
    'not ok 1 - adds',
    '# fail 1',
    '\x1b[31m FAIL \x1b[0m tests/sum.test.ts > adds',
  ])('is true for %j', (line) => {
    expect(readsAsFailure(line)).toBe(true);
  });

  it.each(['', 'ok 1 - adds', '> demo@1.0.0 lint', '> lint', 'build ok', '# fail 0', 'nothing failed'])('is false for %j', (line) => {
    expect(readsAsFailure(line)).toBe(false);
  });
});

describe('the test-run patterns on long output', () => {
  // Each of these took seconds with a pattern that could match one stretch of
  // text in many ways. They are far from any real output, but a hook that
  // hangs is worse than one that misses.
  it.each([
    ['carriage returns', '\r'.repeat(50_000)],
    ['lines of spaces with carriage returns', '\r'.padEnd(80, ' ').repeat(1_250)],
    ['empty lines', '\n'.repeat(100_000)],
    ['one long line that starts like a result', `not ok ${'9'.repeat(50_000)}`],
    ['a FAIL line with a long run of spaces', `FAIL${' '.repeat(100_000)}`],
  ])('reads %s quickly', (_name, output) => {
    const started = performance.now();
    showsFailedTestRun(output);
    checkZeroDefect(output, structuredClone(DEFAULT_CONFIG), undefined, undefined, true);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('showsFailedTestRun', () => {
  it.each([
    ' FAIL  tests/sum.test.ts > adds',
    // vitest with a project name, and jest with a Windows path.
    ' FAIL  |unit| tests/sum.test.ts > adds',
    'FAIL  src\\sum.test.js',
    'FAILED tests/test_sum.py::test_adds - assert 3 == 4',
    ' Test Files  1 failed (1)',
    '      Tests  1 failed | 2 passed (3)',
    'Tests:       1 failed, 4 passed, 5 total',
    'Test Suites: 12 failed, 1 total',
    'not ok 1 - adds',
    '    not ok 2 - a nested test',
    'not ok - a result with no number',
    '# fail 1',
    'ℹ fail 3',
    '[ELIFECYCLE] Test failed. See above for more details.',
    // pnpm before 11 pads the code instead of bracketing it
    ' ELIFECYCLE  Test failed. See above for more details.',
    'build ok\r\n[ELIFECYCLE] Test failed. See above for more details.\r\n',
  ])('takes %j for a failed test run', (line) => {
    expect(showsFailedTestRun(`build ok\n${line}\ndone`)).toBe(true);
  });

  it.each([
    // What a closing `|| echo ...` prints. A runner's FAIL line goes on to
    // name a file, and its summary line puts the count first.
    'FAILED',
    'FAIL',
    'FAILED: the build or the tests',
    ' FAIL  ',
    'FAILED 1',
    'FAILED - see the output above',
    'FAIL build or tests',
    'FAILED after 1.5s',
    'Build FAILED for src/app.ts',
    'Tests: 1 failed step',
    'Tests\n  2 failed',
    'Asset compilation: 1 failed',
    'BUILD FAILED in 3s',
    'ERROR: missing build configuration',
    "src/total.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    'Tests:       0 failed, 5 passed, 5 total',
    // What pnpm prints when a script other than `test` fails.
    '[ELIFECYCLE] Command failed with exit code 2.',
    // A compiler diagnostic that quotes pnpm's line (tsc really printed this).
    `hint.ts(1,7): error TS2322: Type '"[ELIFECYCLE] Test failed. See above for more details."' is not assignable to type '"ready"'.`,
    'echo [ELIFECYCLE] Test failed. See above for more details. >> notes.txt',
    'pnpm said: [ELIFECYCLE] Test failed. See above for more details.',
    '[ELIFECYCLE] Test failed. See above for more details. (quoted in a log line)',
  ])('does not take %j for a failed test run', (line) => {
    expect(showsFailedTestRun(`build ok\n${line}\ndone`)).toBe(false);
  });
});

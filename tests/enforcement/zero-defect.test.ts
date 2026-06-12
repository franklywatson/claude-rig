import { describe, it, expect, beforeEach } from 'vitest';
import { checkZeroDefect, classifyFailures, type ClassifiedFailure } from '../../src/enforcement/zero-defect.js';
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

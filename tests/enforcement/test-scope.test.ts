import { describe, it, expect, beforeEach } from 'vitest';
import { checkTestScope } from '../../src/enforcement/test-scope.js';
import { FileTracker } from '../../src/enforcement/file-tracker.js';
import type { HarnessConfig } from '../../src/types.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

describe('checkTestScope', () => {
  let tracker: FileTracker;
  let config: HarnessConfig;

  beforeEach(() => {
    tracker = new FileTracker();
    config = structuredClone(DEFAULT_CONFIG);
  });

  it('returns null for scoped test command', () => {
    const result = checkTestScope(
      'npx vitest run tests/router/resolver.test.ts',
      'tdd+',
      tracker,
      config,
    );
    expect(result).toBeNull();
  });

  it('returns null for watch mode commands', () => {
    config.rules.test_scope = { enforcement: 'block', allowed_unscoped: ['vitest watch', 'jest --watch'] };
    const result = checkTestScope('npx vitest watch', 'tdd+', tracker, config);
    expect(result).toBeNull();
  });

  it('redirects unscoped test during tdd+ phase', () => {
    tracker.recordEdit('src/router/resolver.ts');
    tracker.recordEdit('src/enforcement/zero-defect.ts');
    config.rules.test_scope = { enforcement: 'advise', allowed_unscoped: ['vitest watch'] };

    const result = checkTestScope('npx vitest run', 'tdd+', tracker, config);
    expect(result).not.toBeNull();
    expect(result).toContain('TEST SCOPE');
    expect(result).toContain('resolver.test.ts');
    expect(result).toContain('zero-defect.test.ts');
  });

  it('returns null for unscoped test during verify+ phase', () => {
    const result = checkTestScope('npx vitest run', 'verify+', tracker, config);
    expect(result).toBeNull();
  });

  it('returns null for unscoped test when no phase set', () => {
    const result = checkTestScope('npx vitest run', null, tracker, config);
    expect(result).toBeNull();
  });

  it('detects pytest unscoped run', () => {
    tracker.recordEdit('src/config.py');
    config.rules.test_scope = { enforcement: 'advise', allowed_unscoped: [] };

    const result = checkTestScope('pytest', 'tdd+', tracker, config);
    expect(result).not.toBeNull();
    expect(result).toContain('TEST SCOPE');
  });

  it('returns null for scoped pytest run', () => {
    const result = checkTestScope('pytest tests/test_config.py', 'tdd+', tracker, config);
    expect(result).toBeNull();
  });

  it('includes enforcement level from config', () => {
    tracker.recordEdit('src/router/resolver.ts');
    config.rules.test_scope = { enforcement: 'block', allowed_unscoped: [] };

    const result = checkTestScope('npx vitest run', 'tdd+', tracker, config);
    expect(result).toContain('[BLOCK]');
  });

  it('shows advise by default', () => {
    tracker.recordEdit('src/router/resolver.ts');
    const result = checkTestScope('npx vitest run', 'tdd+', tracker, config);
    expect(result).toContain('[ADVISE]');
  });

  it('generates correct scoped command suggestion', () => {
    tracker.recordEdit('src/router/resolver.ts');
    tracker.recordEdit('src/router/rules.ts');

    const result = checkTestScope('npx vitest run', 'tdd+', tracker, config);
    expect(result).toContain('npx vitest run tests/router/resolver.test.ts tests/router/rules.test.ts');
  });

  it('redirects unscoped test during sdd+ phase', () => {
    tracker.recordEdit('src/router/resolver.ts');

    const result = checkTestScope('npx vitest run', 'sdd+', tracker, config);
    expect(result).not.toBeNull();
    expect(result).toContain('TEST SCOPE');
    expect(result).toContain('tests/router/resolver.test.ts');
  });

  it('returns null when enforcement is silent', () => {
    tracker.recordEdit('src/router/resolver.ts');
    config.rules.test_scope = { enforcement: 'silent', allowed_unscoped: [] };

    const result = checkTestScope('npx vitest run', 'tdd+', tracker, config);
    expect(result).toBeNull();
  });

  it('detects npm test as an unscoped full-suite run', () => {
    tracker.recordEdit('src/router/resolver.ts');

    const result = checkTestScope('npm test', 'tdd+', tracker, config);
    expect(result).not.toBeNull();
    expect(result).toContain('TEST SCOPE');
    expect(result).toContain('npm test -- tests/router/resolver.test.ts');
  });

  it('detects npm run test as an unscoped full-suite run', () => {
    tracker.recordEdit('src/router/resolver.ts');

    const result = checkTestScope('npm run test', 'sdd+', tracker, config);
    expect(result).not.toBeNull();
    expect(result).toContain('npm test -- tests/router/resolver.test.ts');
  });
});

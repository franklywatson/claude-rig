import { describe, it, expect, beforeEach } from 'vitest';
import { checkTestScope } from '../../src/enforcement/test-scope.js';
import type { HarnessConfig } from '../../src/types.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

describe('checkTestScope', () => {
  let sourceEdits: string[];
  let config: HarnessConfig;

  beforeEach(() => {
    sourceEdits = [];
    config = structuredClone(DEFAULT_CONFIG);
  });

  it('returns null for scoped test command', () => {
    const result = checkTestScope(
      'npx vitest run tests/router/resolver.test.ts',
      'tdd+',
      sourceEdits,
      config,
    );
    expect(result).toBeNull();
  });

  it('returns null for watch mode commands', () => {
    config.rules.test_scope = { enforcement: 'block', allowed_unscoped: ['vitest watch', 'jest --watch'] };
    const result = checkTestScope('npx vitest watch', 'tdd+', sourceEdits, config);
    expect(result).toBeNull();
  });

  it('redirects unscoped test during tdd+ phase', () => {
    sourceEdits.push('src/router/resolver.ts');
    sourceEdits.push('src/enforcement/zero-defect.ts');
    config.rules.test_scope = { enforcement: 'advise', allowed_unscoped: ['vitest watch'] };

    const result = checkTestScope('npx vitest run', 'tdd+', sourceEdits, config);
    expect(result).not.toBeNull();
    expect(result?.message).toContain('TEST SCOPE');
    expect(result?.message).toContain('resolver.test.ts');
    expect(result?.message).toContain('zero-defect.test.ts');
  });

  it('returns null for unscoped test during verify+ phase', () => {
    const result = checkTestScope('npx vitest run', 'verify+', sourceEdits, config);
    expect(result).toBeNull();
  });

  it('returns null for unscoped test when no phase set', () => {
    const result = checkTestScope('npx vitest run', null, sourceEdits, config);
    expect(result).toBeNull();
  });

  it('detects pytest unscoped run', () => {
    sourceEdits.push('src/config.py');
    config.rules.test_scope = { enforcement: 'advise', allowed_unscoped: [] };

    const result = checkTestScope('pytest', 'tdd+', sourceEdits, config);
    expect(result).not.toBeNull();
    expect(result?.message).toContain('TEST SCOPE');
  });

  it('returns null for scoped pytest run', () => {
    const result = checkTestScope('pytest tests/test_config.py', 'tdd+', sourceEdits, config);
    expect(result).toBeNull();
  });

  it('includes enforcement level from config', () => {
    sourceEdits.push('src/router/resolver.ts');
    config.rules.test_scope = { enforcement: 'block', allowed_unscoped: [] };

    const result = checkTestScope('npx vitest run', 'tdd+', sourceEdits, config);
    expect(result?.level).toBe('block');
    expect(result?.message).toContain('[BLOCK]');
  });

  it('shows advise by default', () => {
    sourceEdits.push('src/router/resolver.ts');
    const result = checkTestScope('npx vitest run', 'tdd+', sourceEdits, config);
    expect(result?.level).toBe('advise');
    expect(result?.message).toContain('[ADVISE]');
  });

  it('generates correct scoped command suggestion', () => {
    sourceEdits.push('src/router/resolver.ts');
    sourceEdits.push('src/router/rules.ts');

    const result = checkTestScope('npx vitest run', 'tdd+', sourceEdits, config);
    expect(result?.message).toContain('npx vitest run tests/router/resolver.test.ts tests/router/rules.test.ts');
  });

  it('redirects unscoped test during sdd+ phase', () => {
    sourceEdits.push('src/router/resolver.ts');

    const result = checkTestScope('npx vitest run', 'sdd+', sourceEdits, config);
    expect(result).not.toBeNull();
    expect(result?.message).toContain('TEST SCOPE');
    expect(result?.message).toContain('tests/router/resolver.test.ts');
  });

  it('returns null when enforcement is silent', () => {
    sourceEdits.push('src/router/resolver.ts');
    config.rules.test_scope = { enforcement: 'silent', allowed_unscoped: [] };

    const result = checkTestScope('npx vitest run', 'tdd+', sourceEdits, config);
    expect(result).toBeNull();
  });

  it('detects npm test as an unscoped full-suite run', () => {
    sourceEdits.push('src/router/resolver.ts');

    const result = checkTestScope('npm test', 'tdd+', sourceEdits, config);
    expect(result).not.toBeNull();
    expect(result?.message).toContain('TEST SCOPE');
    expect(result?.message).toContain('npm test -- tests/router/resolver.test.ts');
  });

  it('detects npm run test as an unscoped full-suite run', () => {
    sourceEdits.push('src/router/resolver.ts');

    const result = checkTestScope('npm run test', 'sdd+', sourceEdits, config);
    expect(result).not.toBeNull();
    expect(result?.message).toContain('npm test -- tests/router/resolver.test.ts');
  });
});

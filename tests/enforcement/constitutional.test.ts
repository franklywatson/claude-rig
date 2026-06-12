import { describe, it, expect, beforeEach } from 'vitest';
import { checkConstitutional, isStackOrE2ETest } from '../../src/enforcement/constitutional.js';
import type { HarnessConfig } from '../../src/types.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

describe('checkConstitutional', () => {
  let config: HarnessConfig;

  beforeEach(() => {
    config = structuredClone(DEFAULT_CONFIG);
  });

  describe('mock detection', () => {
    it('detects jest.mock in stack test file', () => {
      const result = checkConstitutional(
        'tests/router/resolver.stack.test.ts',
        `import { resolver } from '../src/router/resolver.js';
jest.mock('../src/router/resolver.js');`,
        config,
      );
      expect(result).not.toBeNull();
      expect(result?.message).toContain('mock');
    });

    it('detects vi.mock in e2e test file', () => {
      const result = checkConstitutional(
        'e2e/router.e2e.test.ts',
        `vi.mock('../src/config.js');`,
        config,
      );
      expect(result).not.toBeNull();
      expect(result?.message).toContain('mock');
    });

    it('allows mocks in regular unit test files', () => {
      const result = checkConstitutional(
        'tests/router/resolver.test.ts',
        `vi.mock('../src/config.js');`,
        config,
      );
      expect(result).toBeNull();
    });

    it('allows mock in non-test files', () => {
      const result = checkConstitutional(
        'src/router/resolver.ts',
        `jest.mock('some-dep');`,
        config,
      );
      expect(result).toBeNull();
    });

    it('returns null for stack test file without mocks', () => {
      const result = checkConstitutional(
        'tests/router/resolver.stack.test.ts',
        `import { resolve } from '../src/router/resolver.js';\nconst result = resolve(rule, env);\nexpect(result.action).toBe('allow');`,
        config,
      );
      expect(result).toBeNull();
    });
  });

  describe('enforcement level', () => {
    it('blocks when config says block', () => {
      config.rules.constitutional = { no_mocks: 'block' };
      const result = checkConstitutional(
        'tests/a.stack.test.ts',
        'jest.mock("foo")',
        config,
      );
      expect(result?.message).toContain('[BLOCK]');
      expect(result?.level).toBe('block');
    });

    it('advises when config says advise', () => {
      config.rules.constitutional = { no_mocks: 'advise' };
      const result = checkConstitutional(
        'e2e/a.e2e.test.ts',
        'jest.mock("foo")',
        config,
      );
      expect(result?.message).toContain('[ADVISE]');
      expect(result?.level).toBe('advise');
    });

    it('silent when config says silent', () => {
      config.rules.constitutional = { no_mocks: 'silent' };
      const result = checkConstitutional(
        'tests/a.stack.test.ts',
        'jest.mock("foo")',
        config,
      );
      expect(result).toBeNull();
    });
  });

  describe('evidence-only check', () => {
    it('detects "tests pass" claim without evidence', () => {
      config.rules.constitutional = { evidence_only: 'block' };
      const result = checkConstitutional(
        'COMMIT_MSG',
        'All tests pass. Ready to merge.',
        config,
      );
      expect(result).not.toBeNull();
      expect(result?.message).toContain('evidence');
    });

    it('allows "tests pass" when backed by output', () => {
      config.rules.constitutional = { evidence_only: 'block' };
      const result = checkConstitutional(
        'COMMIT_MSG',
        `Tests pass:\n\n\`\`\`\n✓ tests/router/resolver.test.ts (3 tests)\nTests: 3 passed\n\`\`\``,
        config,
      );
      expect(result).toBeNull();
    });
  });

  describe('isStackOrE2ETest', () => {
    it('matches .stack.test. files', () => {
      expect(isStackOrE2ETest('src/payment.stack.test.ts')).toBe(true);
    });

    it('matches .e2e.test. files', () => {
      expect(isStackOrE2ETest('tests/login.e2e.test.ts')).toBe(true);
    });

    it('matches .e2e.spec. files', () => {
      expect(isStackOrE2ETest('tests/api.e2e.spec.ts')).toBe(true);
    });

    it('matches stack-tests/ directory', () => {
      expect(isStackOrE2ETest('stack-tests/payment.test.ts')).toBe(true);
      expect(isStackOrE2ETest('stack-test/main.test.ts')).toBe(true);
    });

    it('matches e2e/ directory', () => {
      expect(isStackOrE2ETest('e2e/login.test.ts')).toBe(true);
    });

    it('does not match regular .test.ts files', () => {
      expect(isStackOrE2ETest('tests/a.test.ts')).toBe(false);
      expect(isStackOrE2ETest('src/resolver.test.ts')).toBe(false);
    });

    it('does not match .spec.ts files', () => {
      expect(isStackOrE2ETest('tests/a.spec.ts')).toBe(false);
    });

    it('does not match tests/ directory', () => {
      expect(isStackOrE2ETest('tests/foo.test.ts')).toBe(false);
    });
  });

  describe('stack/E2E scoping', () => {
    it('allows mocks in regular unit test files', () => {
      config.rules.constitutional = { no_mocks: 'block' };
      const result = checkConstitutional(
        'tests/router/resolver.test.ts',
        `vi.mock('../src/config.js');`,
        config,
      );
      expect(result).toBeNull();
    });

    it('allows mocks in non-test files', () => {
      const result = checkConstitutional(
        'src/router/resolver.ts',
        `jest.mock('some-dep');`,
        config,
      );
      expect(result).toBeNull();
    });

    it('blocks mocks in stack test files', () => {
      config.rules.constitutional = { no_mocks: 'block' };
      const result = checkConstitutional(
        'tests/payment.stack.test.ts',
        `vi.mock('../src/config.js');`,
        config,
      );
      expect(result).not.toBeNull();
      expect(result?.message).toContain('[BLOCK]');
      expect(result?.message).toContain('real dependencies');
    });

    it('advises on mocks in e2e test files', () => {
      config.rules.constitutional = { no_mocks: 'advise' };
      const result = checkConstitutional(
        'e2e/login.e2e.test.ts',
        `vi.mock('../src/api.js');`,
        config,
      );
      expect(result).not.toBeNull();
      expect(result?.message).toContain('[ADVISE]');
      expect(result?.message).toContain('real dependencies');
    });

    it('uses positive framing in violation message', () => {
      config.rules.constitutional = { no_mocks: 'block' };
      const result = checkConstitutional(
        'tests/app.stack.test.ts',
        `jest.mock('../src/db.js');`,
        config,
      );
      expect(result?.message).toContain('Use real dependencies in stack/E2E tests.');
      expect(result?.message).toContain('Mocks are appropriate in unit tests for isolation.');
    });
  });
});

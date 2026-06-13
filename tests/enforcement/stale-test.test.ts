import { describe, it, expect, beforeEach } from 'vitest';
import { checkStaleTests } from '../../src/enforcement/stale-test.js';
import { FileTracker } from '../../src/enforcement/file-tracker.js';
import type { HarnessConfig } from '../../src/types.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

describe('checkStaleTests', () => {
  let tracker: FileTracker;
  let config: HarnessConfig;

  beforeEach(() => {
    tracker = new FileTracker();
    config = structuredClone(DEFAULT_CONFIG);
  });

  it('returns null when no stale sources', () => {
    tracker.recordEdit('src/router/resolver.ts');
    tracker.recordEdit('tests/router/resolver.test.ts');
    const result = checkStaleTests(tracker, config);
    expect(result).toBeNull();
  });

  it('returns warning when source edited without test', () => {
    tracker.recordEdit('src/router/resolver.ts');
    tracker.recordEdit('src/router/rules.ts');
    tracker.recordEdit('tests/router/resolver.test.ts');
    tracker.nextTurn();
    const result = checkStaleTests(tracker, config);
    expect(result).not.toBeNull();
    expect(result?.message).toContain('STALE TEST WARNING');
    expect(result?.message).toContain('src/router/rules.ts');
    expect(result?.message).not.toContain('src/router/resolver.ts');
  });

  it('returns null at silent enforcement even when sources are stale', () => {
    config.rules.stale_tests = { enforcement: 'silent', grace_period: 0 };
    tracker.recordEdit('src/router/rules.ts');
    tracker.nextTurn();
    expect(checkStaleTests(tracker, config)).toBeNull();
  });

  it('includes enforcement level from config', () => {
    config.rules.stale_tests = { enforcement: 'block', grace_period: 0 };
    tracker.recordEdit('src/router/rules.ts');
    tracker.nextTurn();
    const result = checkStaleTests(tracker, config);
    expect(result?.message).toContain('[BLOCK]');
    expect(result?.level).toBe('block');
  });

  it('shows advise level by default', () => {
    tracker.recordEdit('src/router/rules.ts');
    tracker.nextTurn();
    const result = checkStaleTests(tracker, config);
    expect(result?.message).toContain('[ADVISE]');
    expect(result?.level).toBe('advise');
  });

  it('respects grace period from config', () => {
    config.rules.stale_tests = { enforcement: 'advise', grace_period: 2 };
    tracker.recordEdit('src/router/rules.ts');
    // Same turn — within grace
    const result = checkStaleTests(tracker, config);
    expect(result).toBeNull();
  });

  it('fires after grace period expires', () => {
    config.rules.stale_tests = { enforcement: 'advise', grace_period: 1 };
    tracker.recordEdit('src/router/rules.ts');
    tracker.nextTurn(); // turn 1 — still within grace (grace=1 means skip 1 turn)
    tracker.nextTurn(); // turn 2 — grace expired
    const result = checkStaleTests(tracker, config);
    expect(result).not.toBeNull();
    expect(result?.message).toContain('src/router/rules.ts');
  });

  it('includes turn count for each stale file', () => {
    tracker.recordEdit('src/router/rules.ts');
    tracker.nextTurn();
    tracker.recordEdit('src/enforcement/zero-defect.ts');
    tracker.nextTurn();
    const result = checkStaleTests(tracker, config);
    expect(result?.message).toContain('edited 2 turns ago');
    expect(result?.message).toContain('edited 1 turn ago');
  });
});

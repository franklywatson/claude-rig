import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { SCENARIOS } from '../../evals/scenarios.js';

describe('scenarios: v1 set', () => {
  it('defines the three v1 scenarios', () => {
    expect(SCENARIOS.map((s) => s.id).sort()).toEqual(
      ['loop-fit-negative', 'loop-fit-positive', 'loop-optin-sections'],
    );
  });
  it('each scenario resolves a brief file, a prompt, and >=1 invariant', () => {
    for (const s of SCENARIOS) {
      expect(existsSync(join(process.cwd(), s.briefFile)), s.briefFile).toBe(true);
      expect(s.prompt.length).toBeGreaterThan(20);
      expect(s.invariants.length).toBeGreaterThanOrEqual(1);
    }
  });
  it('the negative scenario asserts opt-in ABSENCE', () => {
    const neg = SCENARIOS.find((s) => s.id === 'loop-fit-negative')!;
    expect(neg.invariants.some((i) => i.kind === 'loop-optin-absent')).toBe(true);
  });
});

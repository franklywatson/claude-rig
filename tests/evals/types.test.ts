import { describe, it, expect } from 'vitest';
import { emptyReport, type EvalReport } from '../../evals/types.js';

describe('eval report shape', () => {
  it('builds an empty report stamped with the model', () => {
    const r: EvalReport = emptyReport('claude-opus-4-8');
    expect(r).toMatchObject({
      model: 'claude-opus-4-8',
      totalScenarios: 0,
      passCount: 0,
      scenarios: [],
      failures: [],
    });
  });
});

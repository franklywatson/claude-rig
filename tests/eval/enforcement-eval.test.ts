import { describe, it, expect } from 'vitest';
import { handlePostToolUse } from '../../src/enforcement/post-tool-use.js';
import { FileTracker } from '../../src/enforcement/file-tracker.js';
import { SessionCache } from '../../src/session/cache.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

const MIN_OVERALL_SCORE = 0.7;

interface EnforcementScenario {
  id: string;
  description: string;
  tool: string;
  args: Record<string, unknown>;
  setupTracker?: (tracker: FileTracker) => void;
  setupCache?: (cache: SessionCache) => void;
  configOverrides?: Record<string, unknown>;
  expectedViolation: boolean;
  expectedMatch?: string; // substring expected in violation output
}

const ENFORCEMENT_SCENARIOS: EnforcementScenario[] = [
  {
    id: 'enforce_source_no_test',
    description: 'edit source file without matching test edit → stale test violation',
    tool: 'Edit',
    args: { file_path: '/project/src/utils/helpers.ts', new_string: 'export function format() {}' },
    setupTracker: (tracker) => {
      // Turn 0: edit a different test file
      tracker.recordEdit('/project/tests/router/resolver.test.ts');
      tracker.nextTurn();
      // Turn 1: edit source file (no matching helpers.test.ts edit)
      tracker.recordEdit('/project/src/utils/helpers.ts');
      // Turn 2: advance — source edit from turn 1 is now stale
      tracker.nextTurn();
    },
    expectedViolation: true,
    expectedMatch: 'stale',
  },
  {
    id: 'enforce_source_with_test',
    description: 'edit source + test file in same turn → no stale violation',
    tool: 'Edit',
    args: { file_path: '/project/src/router/resolver.ts', new_string: 'export function foo() {}' },
    setupTracker: (tracker) => {
      tracker.recordEdit('/project/src/router/resolver.ts');
      tracker.recordEdit('/project/tests/router/resolver.test.ts');
    },
    expectedViolation: false,
  },
  {
    id: 'enforce_mock_in_stack_test',
    description: 'vi.mock in stack test file → constitutional violation',
    tool: 'Edit',
    args: {
      file_path: '/project/tests/stack/database.stack.test.ts',
      new_string: 'vi.mock("../src/database", () => ({ db: {} }))',
    },
    expectedViolation: true,
    expectedMatch: 'mock',
  },
  {
    id: 'enforce_mock_in_unit_test',
    description: 'vi.mock in unit test file → no constitutional violation',
    tool: 'Edit',
    args: {
      file_path: '/project/tests/unit/calculator.test.ts',
      new_string: 'vi.mock("../src/external-api", () => ({ fetch: vi.fn() }))',
    },
    expectedViolation: false,
  },
  {
    id: 'enforce_mock_in_stack_test_via_write',
    description: 'vi.mock in stack test file created via Write (content) → constitutional violation',
    tool: 'Write',
    args: {
      file_path: '/project/tests/stack/database.stack.test.ts',
      content: 'vi.mock("../src/database", () => ({ db: {} }))',
    },
    expectedViolation: true,
    expectedMatch: 'mock',
  },
  {
    id: 'enforce_mock_in_unit_test_via_write',
    description: 'vi.mock in unit test file created via Write (content) → no constitutional violation',
    tool: 'Write',
    args: {
      file_path: '/project/tests/unit/calculator.test.ts',
      content: 'vi.mock("../src/external-api", () => ({ fetch: vi.fn() }))',
    },
    expectedViolation: false,
  },
  {
    id: 'enforce_test_failure',
    description: 'test command with failure output → zero-defect violation',
    tool: 'Bash',
    args: {
      command: 'npx vitest run tests/router/resolver.test.ts',
      output: 'FAIL tests/router/resolver.test.ts (3 tests)\n  ✗ should resolve rtk first\n  expected true to be false',
    },
    expectedViolation: true,
    expectedMatch: 'fail',
  },
  {
    id: 'enforce_test_pass',
    description: 'test command with all pass output → no violation',
    tool: 'Bash',
    args: {
      command: 'npx vitest run tests/router/resolver.test.ts',
      output: 'PASS tests/router/resolver.test.ts (3 tests)\n  ✓ should resolve rtk first\n  ✓ should resolve jcodemunch second\n  ✓ should fallback to allow',
    },
    expectedViolation: false,
  },
  {
    id: 'enforce_no_test_no_violation',
    description: 'non-test Bash command → no violation regardless of output',
    tool: 'Bash',
    args: {
      command: 'docker compose build 2>&1',
      output: 'error: something failed',
    },
    expectedViolation: false,
  },
];

interface EnforcementResult {
  scenarioId: string;
  expectedViolation: boolean;
  actualViolation: boolean;
  matched: boolean; // expectedMatch found in output
  score: number;
  pass: boolean;
}

describe('Context Eval: enforcement pipeline', () => {
  const results: EnforcementResult[] = [];

  for (const scenario of ENFORCEMENT_SCENARIOS) {
    it(scenario.id, () => {
      const cache = new SessionCache();
      const config = structuredClone(DEFAULT_CONFIG);
      const tracker = new FileTracker();

      if (scenario.setupTracker) scenario.setupCache?.(cache);
      if (scenario.setupCache) scenario.setupCache(cache);
      scenario.setupTracker?.(tracker);

      if (scenario.configOverrides) {
        for (const [key, value] of Object.entries(scenario.configOverrides)) {
          (config.rules as Record<string, unknown>)[key] = value;
        }
      }

      const result = handlePostToolUse(scenario.tool, scenario.args, tracker, cache, config);

      const actualViolation = result !== null;
      const violationCorrect = actualViolation === scenario.expectedViolation;
      const matchCorrect = !scenario.expectedMatch || (result !== null && result.message.toLowerCase().includes(scenario.expectedMatch.toLowerCase()));
      const score = violationCorrect && matchCorrect ? 1.0 : violationCorrect ? 0.5 : 0.0;
      const pass = score >= 0.5;

      results.push({
        scenarioId: scenario.id,
        expectedViolation: scenario.expectedViolation,
        actualViolation,
        matched: matchCorrect,
        score,
        pass,
      });

      if (!pass) {
        expect.fail(
          `Enforcement mismatch:\n  Expected violation: ${scenario.expectedViolation}\n  Actual violation: ${actualViolation}\n  Output: ${result?.message ?? '(none)'}`,
        );
      }

      expect(pass).toBe(true);
    });
  }

  it('overall score meets minimum threshold', () => {
    const totalCases = results.length;
    const passCount = results.filter(r => r.pass).length;
    const overallScore = totalCases > 0 ? results.reduce((sum, r) => sum + r.score, 0) / totalCases : 0;
    expect(overallScore).toBeGreaterThanOrEqual(MIN_OVERALL_SCORE);
  });
});

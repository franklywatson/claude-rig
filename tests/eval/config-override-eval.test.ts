import { describe, it, expect } from 'vitest';
import { handlePreToolUse } from '../../src/router/hook.js';
import { SessionCache } from '../../src/session/cache.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { scoreResult, buildReport, parseResult, type EvalResult } from './score.js';
import type { Environment, HarnessConfig } from '../../src/types.js';

const MIN_OVERALL_SCORE = 0.7;

const FULL_ENV: Environment = {
  rtkAvailable: true,
  rtkPath: '/usr/bin/rtk',
  jcodemunchAvailable: true,
  jcodemunchCwdIndexed: true,
  jcodemunchCwdRepo: 'local/test',
  jcodemunchKnownRepos: ['local/test'],
    graphifyAvailable: false,
    graphifyGraphPath: null,
  detectedAt: Date.now(),
};

interface ConfigScenario {
  id: string;
  description: string;
  toolCall: { tool: string; args: Record<string, unknown> };
  cwd?: string;
  configOverrides: Partial<HarnessConfig['rules']>;
  expected: { action: string; tool?: string };
}

const CONFIG_SCENARIOS: ConfigScenario[] = [
  {
    id: 'config_native_read_block',
    description: 'Read code file with native_read: block → block instead of advise',
    toolCall: { tool: 'Read', args: { file_path: '/project/src/router/resolver.ts' } },
    configOverrides: { tool_routing: { native_read: 'block' } },
    expected: { action: 'block' },
  },
  {
    id: 'config_native_read_silent',
    description: 'Read code file with native_read: silent → allow (suppressed)',
    toolCall: { tool: 'Read', args: { file_path: '/project/src/router/resolver.ts' } },
    configOverrides: { tool_routing: { native_read: 'silent' } },
    expected: { action: 'allow' },
  },
  {
    id: 'config_native_grep_block',
    description: 'Grep with native_grep: block → block instead of advise',
    toolCall: { tool: 'Grep', args: { pattern: 'function resolve' } },
    configOverrides: { tool_routing: { native_grep: 'block' } },
    expected: { action: 'block' },
  },
  {
    id: 'config_grep_block',
    description: 'Bash grep with grep: block → block instead of rtk rewrite',
    toolCall: { tool: 'Bash', args: { command: 'grep -r "TODO" src/' } },
    configOverrides: { tool_routing: { grep: 'block' } },
    expected: { action: 'block' },
  },
];

describe('Context Eval: config override routing', () => {
  const results: EvalResult[] = [];

  for (const scenario of CONFIG_SCENARIOS) {
    it(scenario.id, () => {
      const cache = new SessionCache();
      const config = structuredClone(DEFAULT_CONFIG);
      cache.setEnvironment(FULL_ENV);

      // Apply config overrides
      for (const [key, value] of Object.entries(scenario.configOverrides)) {
        (config.rules as Record<string, unknown>)[key] = value;
      }

      const actual = handlePreToolUse(
        scenario.toolCall.tool,
        scenario.toolCall.args,
        cache,
        config,
        scenario.cwd,
      );

      const parsed = parseResult(actual);
      const score = scoreResult(scenario.expected as any, actual);
      const pass = score >= 0.5;

      results.push({
        scenarioId: scenario.id,
        environment: 'full',
        category: 'config_override',
        expected: scenario.expected as any,
        actual: parsed.action === 'allow' ? null : { action: parsed.action, tool: parsed.tool },
        score,
        pass,
      });

      if (!pass) {
        const expectedStr = `${scenario.expected.action}${scenario.expected.tool ? ` → ${scenario.expected.tool}` : ''}`;
        const actualStr = `${parsed.action}${parsed.tool ? ` → ${parsed.tool}` : ''}`;
        expect.fail(
          `Config override mismatch:\n  Expected: ${expectedStr}\n  Actual:   ${actualStr}\n  Hook output: ${JSON.stringify(actual)}`,
        );
      }

      expect(pass).toBe(true);
    });
  }

  it('overall score meets minimum threshold', () => {
    const report = buildReport(results);
    expect(report.overallScore).toBeGreaterThanOrEqual(MIN_OVERALL_SCORE);
  });
});

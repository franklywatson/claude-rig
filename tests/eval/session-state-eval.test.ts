import { describe, it, expect } from 'vitest';
import { handlePreToolUse } from '../../src/router/hook.js';
import { SessionCache } from '../../src/session/cache.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { scoreResult, buildReport, parseResult, type EvalResult } from './score.js';
import type { Environment } from '../../src/types.js';

const MIN_OVERALL_SCORE = 0.7;

const NO_TOOLS_ENV: Environment = {
  rtkAvailable: false,
  rtkPath: null,
  jcodemunchAvailable: false,
  jcodemunchCwdIndexed: false,
  jcodemunchCwdRepo: null,
  jcodemunchKnownRepos: [],
    graphifyAvailable: false,
    graphifyGraphPath: null,
  detectedAt: Date.now(),
};

interface SessionStateScenario {
  id: string;
  description: string;
  toolCall: { tool: string; args: Record<string, unknown> };
  cwd?: string;
  setupCache: (cache: SessionCache) => void;
  expected: { action: string; tool?: string };
}

const SESSION_STATE_SCENARIOS: SessionStateScenario[] = [
  {
    id: 'state_python_cached',
    description: 'pytest .py with Python env cached → rewrite to .venv',
    toolCall: { tool: 'Bash', args: { command: 'pytest tests/test_foo.py -v' } },
    cwd: '/project',
    setupCache: (cache) => {
      cache.setPythonEnv({ venvPath: '/project/.venv', uvAvailable: false, uvPath: null, detectedAt: Date.now() });
    },
    expected: { action: 'rewrite', tool: '.venv/bin/pytest' },
  },
  {
    id: 'state_python_empty',
    description: 'pytest .py with no Python env cached → allow',
    toolCall: { tool: 'Bash', args: { command: 'pytest tests/test_foo.py -v' } },
    cwd: '/project',
    setupCache: () => { /* no python env */ },
    expected: { action: 'allow' },
  },
  {
    id: 'state_stale_env',
    description: 'cat with stale environment (5h old, no tools) → advise (stale env retained as last-known-good)',
    toolCall: { tool: 'Bash', args: { command: 'cat src/main.py' } },
    setupCache: (cache) => {
      cache.setEnvironment({
        rtkAvailable: false,
        rtkPath: null,
        jcodemunchAvailable: false,
        jcodemunchCwdIndexed: false,
        jcodemunchCwdRepo: null,
        jcodemunchKnownRepos: [],
    graphifyAvailable: false,
    graphifyGraphPath: null,
        detectedAt: Date.now() - 5 * 60 * 60 * 1000,
      });
    },
    expected: { action: 'advise', tool: 'Read' },
  },
  {
    id: 'state_phase_tdd',
    description: 'pytest .py in tdd+ phase with Python env → still rewrites',
    toolCall: { tool: 'Bash', args: { command: 'pytest tests/test_foo.py -v' } },
    cwd: '/project',
    setupCache: (cache) => {
      cache.setPhase('tdd+');
      cache.setPythonEnv({ venvPath: '/project/.venv', uvAvailable: false, uvPath: null, detectedAt: Date.now() });
    },
    expected: { action: 'rewrite', tool: '.venv/bin/pytest' },
  },
  {
    id: 'state_edited_files',
    description: 'cat with edited files tracked → still routes normally (advise)',
    toolCall: { tool: 'Bash', args: { command: 'cat src/router/resolver.ts' } },
    setupCache: (cache) => {
      cache.addEditedFile('src/router/resolver.ts', 'source');
    },
    expected: { action: 'advise', tool: 'Read' },
  },
  {
    id: 'state_graphify_available',
    description: 'graphify available in cache → cat routing unchanged (rtk still wins)',
    toolCall: { tool: 'Bash', args: { command: 'cat src/main.ts' } },
    setupCache: (cache) => {
      cache.setEnvironment({
        rtkAvailable: true,
        rtkPath: '/usr/bin/rtk',
        jcodemunchAvailable: true,
        jcodemunchCwdIndexed: true,
        jcodemunchCwdRepo: 'local/test',
        jcodemunchKnownRepos: ['local/test'],
        graphifyAvailable: true,
        graphifyGraphPath: 'graphify-out/graph.json',
        detectedAt: Date.now(),
      });
      cache.setMetricsBaseline({
        totalSaved: 0,
        capturedAt: Date.now(),
        graphifyStats: { nodes: 10, edges: 20, communities: 3, extractedPct: 90, inferredPct: 8, ambiguousPct: 2 },
      });
    },
    expected: { action: 'advise', tool: 'rtk cat' },
  },
  {
    id: 'state_graphify_with_python',
    description: 'graphify + Python env both cached → Python rewrite still works',
    toolCall: { tool: 'Bash', args: { command: 'pytest tests/test_foo.py -v' } },
    cwd: '/project',
    setupCache: (cache) => {
      cache.setEnvironment({
        rtkAvailable: false,
        rtkPath: null,
        jcodemunchAvailable: true,
        jcodemunchCwdIndexed: true,
        jcodemunchCwdRepo: 'local/test',
        jcodemunchKnownRepos: ['local/test'],
        graphifyAvailable: true,
        graphifyGraphPath: 'graphify-out/graph.json',
        detectedAt: Date.now(),
      });
      cache.setPythonEnv({ venvPath: '/project/.venv', uvAvailable: false, uvPath: null, detectedAt: Date.now() });
    },
    expected: { action: 'rewrite', tool: '.venv/bin/pytest' },
  },
];

describe('Context Eval: session state routing', () => {
  const results: EvalResult[] = [];

  for (const scenario of SESSION_STATE_SCENARIOS) {
    it(scenario.id, () => {
      const cache = new SessionCache();
      const config = structuredClone(DEFAULT_CONFIG);
      cache.setEnvironment(NO_TOOLS_ENV);
      scenario.setupCache(cache);

      const actual = handlePreToolUse(
        scenario.toolCall.tool,
        scenario.toolCall.args,
        cache,
        config,
        scenario.cwd,
        // Declining execRewrite mock: keeps rtk-enabled scenarios off the
        // real binary (no /tmp diag pollution, no host dependence).
        { existsCheck: (p) => p.startsWith('/project/.venv/bin/'), execRewrite: () => null },
      );

      const parsed = parseResult(actual);
      const score = scoreResult(scenario.expected as any, actual);
      const pass = score >= 0.5;

      results.push({
        scenarioId: scenario.id,
        environment: 'session_state',
        category: 'session_state',
        expected: scenario.expected as any,
        actual: parsed.action === 'allow' ? null : { action: parsed.action, tool: parsed.tool },
        score,
        pass,
      });

      if (!pass) {
        const expectedStr = `${scenario.expected.action}${scenario.expected.tool ? ` → ${scenario.expected.tool}` : ''}`;
        const actualStr = `${parsed.action}${parsed.tool ? ` → ${parsed.tool}` : ''}`;
        expect.fail(
          `Session state mismatch:\n  Expected: ${expectedStr}\n  Actual:   ${actualStr}\n  Hook output: ${JSON.stringify(actual)}`,
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

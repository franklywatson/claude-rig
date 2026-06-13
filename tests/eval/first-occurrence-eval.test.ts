import { describe, it, expect } from 'vitest';
import { handlePreToolUse } from '../../src/router/hook.js';
import { SessionCache } from '../../src/session/cache.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import type { HarnessConfig, Environment } from '../../src/types.js';

function makeEnv(overrides: Partial<Environment> = {}): Environment {
  return {
    rtkAvailable: false,
    rtkPath: null,
    jcodemunchAvailable: true,
    jcodemunchCwdIndexed: true,
    jcodemunchCwdRepo: 'local/test',
    jcodemunchKnownRepos: ['local/test'],
    graphifyAvailable: false,
    graphifyGraphPath: null,
    detectedAt: Date.now(),
    ...overrides,
  };
}

interface FirstOccScenario {
  id: string;
  description: string;
  firstCall: { tool: string; args: Record<string, unknown> };
  secondCall: { tool: string; args: Record<string, unknown> };
  expectedFirst: 'advise' | 'block';
  expectedSecond: 'allow' | 'advise' | 'block';
}

const SCENARIOS: FirstOccScenario[] = [
  {
    id: 'native_read',
    description: 'Read code file — advises on first call, suppresses on second',
    firstCall: { tool: 'Read', args: { file_path: '/project/src/router/resolver.ts' } },
    secondCall: { tool: 'Read', args: { file_path: '/project/src/router/hook.ts' } },
    expectedFirst: 'advise',
    expectedSecond: 'allow',
  },
  {
    id: 'native_grep',
    description: 'Grep — advises on first call, suppresses on second',
    firstCall: { tool: 'Grep', args: { pattern: 'function resolve' } },
    secondCall: { tool: 'Grep', args: { pattern: 'class Router' } },
    expectedFirst: 'advise',
    expectedSecond: 'allow',
  },
  {
    id: 'native_glob',
    description: 'Glob code pattern — advises on first call, suppresses on second',
    firstCall: { tool: 'Glob', args: { pattern: '**/*.ts' } },
    secondCall: { tool: 'Glob', args: { pattern: '**/*.py' } },
    expectedFirst: 'advise',
    expectedSecond: 'allow',
  },
  {
    id: 'scout_explore',
    description: 'Agent Explore — advises scout on first call, suppresses on second',
    firstCall: { tool: 'Agent', args: { subagent_type: 'Explore', prompt: 'find auth' } },
    secondCall: { tool: 'Agent', args: { subagent_type: 'Explore', prompt: 'find config' } },
    expectedFirst: 'advise',
    expectedSecond: 'allow',
  },
  {
    id: 'different_intents',
    description: 'Read advises, then Glob advises independently (separate intents)',
    firstCall: { tool: 'Read', args: { file_path: '/project/src/router/resolver.ts' } },
    secondCall: { tool: 'Glob', args: { pattern: '**/*.ts' } },
    expectedFirst: 'advise',
    expectedSecond: 'advise',
  },
];

describe('Context Eval: first-occurrence advisory suppression', () => {
  for (const scenario of SCENARIOS) {
    it(scenario.id, () => {
      const cache = new SessionCache();
      const config: HarnessConfig = structuredClone(DEFAULT_CONFIG);
      cache.setEnvironment(makeEnv());

      // First call
      const first = handlePreToolUse(
        scenario.firstCall.tool,
        scenario.firstCall.args,
        cache,
        config,
      );

      if (scenario.expectedFirst === 'advise') {
        expect(first).not.toBeNull();
        expect(first).toMatchObject({ level: 'advise' });
      } else {
        expect(first).toMatchObject({ level: 'block' });
      }

      // Second call
      const second = handlePreToolUse(
        scenario.secondCall.tool,
        scenario.secondCall.args,
        cache,
        config,
      );

      if (scenario.expectedSecond === 'allow') {
        expect(second).toBeNull();
      } else if (scenario.expectedSecond === 'advise') {
        expect(second).not.toBeNull();
        expect(second).toMatchObject({ level: 'advise' });
      } else {
        expect(second).toMatchObject({ level: 'block' });
      }
    });
  }
});

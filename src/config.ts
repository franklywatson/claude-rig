import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type {
  HarnessConfig,
  EnforcementLevel,
  StaleTestRules,
  TestScopeRules,
  ZeroDefectRules,
} from './types.js';

export const DEFAULT_CONFIG: HarnessConfig = {
  rules: {
    tool_routing: {
      grep: 'advise',
      find: 'advise',
      glob: 'advise',
      sed_i: 'block',
      cat: 'advise',
      broad_scan: 'block',
      native_read: 'advise',
      native_grep: 'advise',
      native_glob: 'advise',
      rtk_cat_code: 'block',
      scout_explore: 'advise',
      read_line_threshold: 100,
    },
    constitutional: {
      no_mocks: 'advise',
      evidence_only: 'block',
      full_accounting: 'advise',
    },
    test_integrity: {
      conditional_assert: 'block',
      skip_without_reason: 'advise',
      empty_test: 'block',
    },
    stale_tests: {
      enforcement: 'advise',
      grace_period: 0,
    },
    test_scope: {
      enforcement: 'advise',
      allowed_unscoped: ['vitest watch', 'jest --watch'],
    },
    zero_defect: {
      tolerance: 'strict',
      unrelated_errors: 'block',
    },
    enforcement: {
      default_level: 'advise',
    },
  },
};

export async function loadConfig(configPath: string): Promise<HarnessConfig> {
  try {
    const raw = await readFile(configPath, 'utf-8');
    const parsed = parseYaml(raw) as HarnessConfig | null;
    if (!parsed || typeof parsed !== 'object') {
      return structuredClone(DEFAULT_CONFIG);
    }
    return mergeConfigs(structuredClone(DEFAULT_CONFIG), parsed);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function mergeConfigs(base: HarnessConfig, override: HarnessConfig): HarnessConfig {
  return {
    rules: {
      tool_routing: { ...base.rules.tool_routing, ...override.rules.tool_routing },
      constitutional: { ...base.rules.constitutional, ...override.rules.constitutional },
      test_integrity: { ...base.rules.test_integrity, ...override.rules.test_integrity },
      stale_tests: { ...(base.rules.stale_tests ?? {}), ...override.rules.stale_tests } as StaleTestRules,
      test_scope: { ...(base.rules.test_scope ?? {}), ...override.rules.test_scope } as TestScopeRules,
      zero_defect: { ...(base.rules.zero_defect ?? {}), ...override.rules.zero_defect } as ZeroDefectRules,
      enforcement: { ...(base.rules.enforcement ?? {}), ...override.rules.enforcement } as { default_level: EnforcementLevel },
    },
  };
}

export function getEnforcementLevel(
  config: HarnessConfig,
  category: string,
  rule: string,
): EnforcementLevel {
  const rules = config.rules as Record<string, Record<string, unknown>>;
  const categoryRules = rules[category];
  if (categoryRules && typeof categoryRules[rule] === 'string') {
    return categoryRules[rule] as EnforcementLevel;
  }
  return config.rules.enforcement?.default_level ?? 'advise';
}

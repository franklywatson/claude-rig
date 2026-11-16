import { describe, it, expect } from 'vitest';
import { loadConfig, mergeConfigs, DEFAULT_CONFIG } from '../src/config.js';
import { resolve } from 'node:path';
import { HarnessConfig } from '../src/types.js';

const FIXTURES = resolve(import.meta.dirname, '..', 'fixtures');

describe('config', () => {
  describe('DEFAULT_CONFIG', () => {
    it('has all rule categories with sensible defaults', () => {
      expect(DEFAULT_CONFIG.rules.enforcement).toBeDefined();
      expect(DEFAULT_CONFIG.rules.enforcement.default_level).toBe('advise');
      expect(DEFAULT_CONFIG.rules.constitutional.no_mocks).toBe('advise');
      expect(DEFAULT_CONFIG.rules.tool_routing).toBeDefined();
      expect(DEFAULT_CONFIG.rules.tool_routing.grep).toBe('advise');
      expect(DEFAULT_CONFIG.rules.tool_routing.sed_i).toBe('block');
      expect(DEFAULT_CONFIG.rules.stale_tests).toBeDefined();
      expect(DEFAULT_CONFIG.rules.stale_tests.enforcement).toBe('advise');
      expect(DEFAULT_CONFIG.rules.test_scope).toBeDefined();
      expect(DEFAULT_CONFIG.rules.test_scope.enforcement).toBe('advise');
    });

    it('has native tool advisory config keys', () => {
      expect(DEFAULT_CONFIG.rules.tool_routing.native_read).toBe('advise');
      expect(DEFAULT_CONFIG.rules.tool_routing.native_grep).toBe('advise');
      expect(DEFAULT_CONFIG.rules.tool_routing.native_glob).toBe('advise');
      expect(DEFAULT_CONFIG.rules.tool_routing.rtk_cat_code).toBe('block');
      expect(DEFAULT_CONFIG.rules.tool_routing.read_line_threshold).toBe(100);
    });

    it('has jcodemunch divert config keys', () => {
      expect(DEFAULT_CONFIG.rules.tool_routing.jcodemunch_divert).toBe('advise');
      expect(DEFAULT_CONFIG.rules.tool_routing.jcodemunch_divert_outline_bytes).toBe(8192);
    });
  });

  it('mergeConfigs preserves unspecified tool_routing keys (jcodemunch_divert)', () => {
    const base = structuredClone(DEFAULT_CONFIG);
    const override = structuredClone(DEFAULT_CONFIG);
    override.rules.tool_routing.jcodemunch_divert = 'block';
    const merged = mergeConfigs(base, override);
    expect(merged.rules.tool_routing.jcodemunch_divert).toBe('block');
    expect(merged.rules.tool_routing.jcodemunch_divert_outline_bytes).toBe(8192);
  });

  describe('loadConfig', () => {
    it('returns default config when file does not exist', async () => {
      const config = await loadConfig('/nonexistent/path/.harness.yaml');
      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it('loads a minimal config and merges with defaults', async () => {
      const config = await loadConfig(resolve(FIXTURES, 'minimal-config.yaml'));
      expect(config.rules.enforcement).toBeDefined();
      expect(config.rules.enforcement.default_level).toBe('advise');
      // Defaults still present for unspecified rules
      expect(config.rules.tool_routing).toBeDefined();
      expect(config.rules.tool_routing.grep).toBe('advise');
    });

    it('loads a full config with all rules', async () => {
      const config = await loadConfig(resolve(FIXTURES, 'full-config.yaml'));
      expect(config.rules.tool_routing).toBeDefined();
      expect(config.rules.tool_routing.grep).toBe('advise');
      expect(config.rules.constitutional).toBeDefined();
      expect(config.rules.constitutional.no_mocks).toBe('block');
      expect(config.rules.test_integrity).toBeDefined();
      expect(config.rules.test_integrity.empty_test).toBe('block');
      expect(config.rules.stale_tests).toBeDefined();
      expect(config.rules.stale_tests.grace_period).toBe(0);
      expect(config.rules.test_scope).toBeDefined();
      expect(config.rules.test_scope.allowed_unscoped).toContain('vitest watch');
      expect(config.rules.zero_defect).toBeDefined();
      expect(config.rules.zero_defect.tolerance).toBe('strict');
    });

    it('returns default config for broken YAML', async () => {
      const config = await loadConfig(resolve(FIXTURES, 'broken-config.yaml'));
      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it('defaults workflow rules: advise, master/main, auto strategy', async () => {
      const config = await loadConfig('/nonexistent/.harness.yaml');
      expect(config.rules.workflow?.branch_discipline).toBe('advise');
      expect(config.rules.workflow?.protected_branches).toEqual(['master', 'main']);
      expect(config.rules.workflow?.isolation_strategy).toBe('auto');
    });

    it('defaults team_execution to offer', async () => {
      const config = await loadConfig('/nonexistent/.harness.yaml');
      expect(config.rules.workflow?.team_execution).toBe('offer');
    });
  });

  describe('loadConfig local override layer (.harness.yaml.local)', () => {
    it('applies the local file over the project config and defaults', async () => {
      const config = await loadConfig(resolve(FIXTURES, 'local-override-main.yaml'));
      // local wins over the main file
      expect(config.rules.stale_tests.enforcement).toBe('block');
      // main-file values not overridden by local are preserved
      expect(config.rules.stale_tests.grace_period).toBe(3);
      expect(config.rules.constitutional.no_mocks).toBe('silent');
      // untouched categories keep their defaults
      expect(config.rules.tool_routing.grep).toBe('advise');
    });

    it('leaves the merged config unchanged when no local file exists', async () => {
      const config = await loadConfig(resolve(FIXTURES, 'local-override.yaml'));
      expect(config.rules.tool_routing.grep).toBe('advise');
      expect(config.rules.stale_tests.enforcement).toBe('block');
    });

    it('ignores a broken local file and keeps the main config', async () => {
      const config = await loadConfig(resolve(FIXTURES, 'broken-local-main.yaml'));
      expect(config.rules.constitutional.no_mocks).toBe('silent');
      expect(config.rules.stale_tests.enforcement).toBe('advise');
    });

    it('applies the local file even when the main config is absent', async () => {
      const config = await loadConfig(resolve(FIXTURES, 'only-local.yaml'));
      expect(config.rules.tool_routing.grep).toBe('silent');
      expect(config.rules.tool_routing.sed_i).toBe('block');
    });

    it.each([
      ['rules: with nothing under it', 'degenerate-local-main.yaml'],
      ['a top-level list', 'list-local-main.yaml'],
      ['an empty document', 'empty-local-main.yaml'],
    ])('treats a degenerate local file (%s) as inert', async (_shape, fixture) => {
      const config = await loadConfig(resolve(FIXTURES, fixture));
      // main-file values apply, defaults untouched — never a rejection
      expect(config.rules.constitutional.no_mocks).toBe('silent');
      expect(config.rules.stale_tests.enforcement).toBe('advise');
    });

    it('returns defaults for a main config that is an empty object', async () => {
      const config = await loadConfig(resolve(FIXTURES, 'empty-object-main.yaml'));
      expect(config).toEqual(DEFAULT_CONFIG);
    });
  });

  describe('mergeConfigs', () => {
    it('overrides base with local values', () => {
      const base: HarnessConfig = {
        rules: {
          tool_routing: { grep: 'block', find: 'advise' },
          stale_tests: { enforcement: 'advise', grace_period: 0 },
        },
      };
      const local: HarnessConfig = {
        rules: {
          tool_routing: { grep: 'advise' },
          stale_tests: { enforcement: 'block' },
        },
      };
      const merged = mergeConfigs(base, local);
      expect(merged.rules.tool_routing).toBeDefined();
      expect(merged.rules.tool_routing.grep).toBe('advise');
      expect(merged.rules.tool_routing.find).toBe('advise');
      expect(merged.rules.stale_tests).toBeDefined();
      expect(merged.rules.stale_tests.enforcement).toBe('block');
      expect(merged.rules.stale_tests.grace_period).toBe(0);
    });

    it('preserves base values when local does not override', () => {
      const base: HarnessConfig = {
        rules: { tool_routing: { grep: 'block', sed_i: 'block' } },
      };
      const local: HarnessConfig = {
        rules: { tool_routing: { grep: 'advise' } },
      };
      const merged = mergeConfigs(base, local);
      expect(merged.rules.tool_routing).toBeDefined();
      expect(merged.rules.tool_routing.grep).toBe('advise');
      expect(merged.rules.tool_routing.sed_i).toBe('block');
    });

    it('merges partial workflow overrides onto defaults', () => {
      const merged = mergeConfigs(structuredClone(DEFAULT_CONFIG), {
        rules: { workflow: { branch_discipline: 'block' } },
      } as HarnessConfig);
      expect(merged.rules.workflow?.branch_discipline).toBe('block');
      expect(merged.rules.workflow?.protected_branches).toEqual(['master', 'main']);
    });

    it('merges team_execution override while keeping other workflow defaults', () => {
      const merged = mergeConfigs(structuredClone(DEFAULT_CONFIG), {
        rules: { workflow: { team_execution: 'never' } },
      } as HarnessConfig);
      expect(merged.rules.workflow?.team_execution).toBe('never');
      expect(merged.rules.workflow?.branch_discipline).toBe('advise');
    });
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { handlePostToolUse } from '../../src/enforcement/post-tool-use.js';
import { FileTracker } from '../../src/enforcement/file-tracker.js';
import { SessionCache } from '../../src/session/cache.js';
import type { HarnessConfig } from '../../src/types.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

describe('handlePostToolUse', () => {
  let tracker: FileTracker;
  let cache: SessionCache;
  let config: HarnessConfig;

  beforeEach(() => {
    tracker = new FileTracker();
    cache = new SessionCache();
    config = structuredClone(DEFAULT_CONFIG);
  });

  it('tracks source file edits via Edit tool', () => {
    const result = handlePostToolUse('Edit', { file_path: 'src/router/resolver.ts' }, tracker, cache, config);
    expect(tracker.getSourceEdits()).toHaveLength(1);
    expect(tracker.getSourceEdits()[0].file).toBe('src/router/resolver.ts');
    expect(result).toBeNull(); // no violation yet
  });

  it('tracks test file edits via Edit tool', () => {
    handlePostToolUse('Edit', { file_path: 'tests/router/resolver.test.ts' }, tracker, cache, config);
    expect(tracker.getTestEdits()).toHaveLength(1);
  });

  it('tracks file edits via Write tool', () => {
    handlePostToolUse('Write', { file_path: 'src/router/rules.ts' }, tracker, cache, config);
    expect(tracker.getSourceEdits()).toHaveLength(1);
  });

  it('emits stale test warning after second source edit without test', () => {
    handlePostToolUse('Edit', { file_path: 'src/router/resolver.ts' }, tracker, cache, config);
    handlePostToolUse('Edit', { file_path: 'tests/router/resolver.test.ts' }, tracker, cache, config);
    // resolver.ts has a test, no stale warning
    handlePostToolUse('Edit', { file_path: 'src/router/rules.ts' }, tracker, cache, config);
    tracker.nextTurn();
    tracker.nextTurn();
    const result = handlePostToolUse('Edit', { file_path: 'src/router/hook.ts' }, tracker, cache, config);
    // rules.ts is stale (no test edit)
    // Note: result from this call is about hook.ts edit itself, but stale check runs
    expect(tracker.getStaleSources()).toEqual(
      expect.arrayContaining([expect.objectContaining({ file: 'src/router/rules.ts' })]),
    );
  });

  it('checks zero-defect on Bash test commands', () => {
    const testOutput = 'FAIL tests/a.test.ts\nTests: 1 failed';
    const result = handlePostToolUse('Bash', { command: 'npx vitest run', output: testOutput }, tracker, cache, config);
    expect(result).not.toBeNull();
    expect(result?.message).toContain('ZERO-DEFECT');
  });

  it('checks constitutional on stack test file edits', () => {
    const result = handlePostToolUse(
      'Edit',
      {
        file_path: 'tests/router/resolver.stack.test.ts',
        new_string: "jest.mock('../src/router/resolver.js');",
      },
      tracker,
      cache,
      config,
    );
    expect(result).not.toBeNull();
    expect(result?.message).toContain('no_mocks');
  });

  it('combines multiple violations into single output', () => {
    // Edit a stack test file with a mock
    const result = handlePostToolUse(
      'Edit',
      {
        file_path: 'tests/router/resolver.stack.test.ts',
        new_string: "vi.mock('../src/config.js');",
      },
      tracker,
      cache,
      config,
    );
    // Should contain the constitutional violation
    expect(result?.message).toContain('no_mocks');
  });

  it('returns null for clean operations', () => {
    const result = handlePostToolUse(
      'Edit',
      { file_path: 'src/router/resolver.ts' },
      tracker,
      cache,
      config,
    );
    expect(result).toBeNull();
  });

  it('captures external graphify stats on mcp__jcodemunch__index_folder', () => {
    const report = [
      '# Graph Report - /external/meridian',
      '',
      '## Summary',
      '- 420 nodes · 891 edges · 67 communities detected',
      '- Extraction: 91% EXTRACTED · 9% INFERRED · 0% AMBIGUOUS',
    ].join('\n');
    const exec = (cmd: string) => {
      if (cmd.includes('test -f')) throw new Error('not found');
      if (cmd.includes('graphify update')) return '';
      if (cmd.includes('GRAPH_REPORT.md')) return report;
      throw new Error(`unexpected: ${cmd}`);
    };

    handlePostToolUse(
      'mcp__jcodemunch__index_folder',
      { path: '/external/meridian' },
      tracker,
      cache,
      config,
      exec,
    );

    const stats = cache.getGraphifyStats('/external/meridian');
    expect(stats).toEqual({
      nodes: 420, edges: 891, communities: 67,
      extractedPct: 91, inferredPct: 9, ambiguousPct: 0,
    });
  });

  it('captures stats when an external graph is built via Bash graphify update', () => {
    const report = [
      '# Graph Report - /external/meridian',
      '',
      '## Summary',
      '- 420 nodes · 891 edges · 67 communities detected',
      '- Extraction: 91% EXTRACTED · 9% INFERRED · 0% AMBIGUOUS',
    ].join('\n');
    // Only the report read is expected: the graph was just built by the Bash
    // command itself, so no test -f / graphify update retry should run.
    const exec = (cmd: string) => {
      if (cmd.includes('GRAPH_REPORT.md')) return report;
      throw new Error(`unexpected: ${cmd}`);
    };

    handlePostToolUse(
      'Bash',
      { command: 'graphify update "/external/meridian"' },
      tracker,
      cache,
      config,
      exec,
    );

    expect(cache.getGraphifyStats('/external/meridian')).toEqual({
      nodes: 420, edges: 891, communities: 67,
      extractedPct: 91, inferredPct: 9, ambiguousPct: 0,
    });
  });

  it('captures stats for unquoted and graphifyy command variants', () => {
    const report = '- 10 nodes · 20 edges · 3 communities detected';
    const exec = (cmd: string) => {
      if (cmd.includes('GRAPH_REPORT.md')) return report;
      throw new Error(`unexpected: ${cmd}`);
    };

    handlePostToolUse(
      'Bash', { command: 'graphifyy update /external/alpha' }, tracker, cache, config, exec,
    );

    expect(cache.getGraphifyStats('/external/alpha')?.nodes).toBe(10);
  });

  it('does not capture stats for Bash graphify update on the CWD', () => {
    const exec = () => { throw new Error('should not be called'); };

    handlePostToolUse(
      'Bash',
      { command: `graphify update "${process.cwd()}"` },
      tracker,
      cache,
      config,
      exec,
    );

    expect(cache.getGraphifyStats(process.cwd())).toBeUndefined();
  });

  it('ignores Bash commands that merely mention graphify without update', () => {
    const exec = () => { throw new Error('should not be called'); };

    expect(() => handlePostToolUse(
      'Bash', { command: 'graphify benchmark "/external/x"' }, tracker, cache, config, exec,
    )).not.toThrow();
    expect(cache.getGraphifyStats('/external/x')).toBeUndefined();
  });

  it('does not capture stats for CWD directory on index_folder', () => {
    const exec = () => '';
    handlePostToolUse(
      'mcp__jcodemunch__index_folder',
      { path: '/home/user/claude-rig' },
      tracker,
      cache,
      config,
      exec,
    );

    // CWD stats are handled by session-start, not post-tool-use
    expect(cache.getGraphifyStats('/home/user/claude-rig')).toBeUndefined();
  });

  it('gracefully handles graphify capture failure on external dir', () => {
    const exec = () => { throw new Error('graphify not installed'); };

    // Should not throw
    handlePostToolUse(
      'mcp__jcodemunch__index_folder',
      { path: '/external/broken' },
      tracker,
      cache,
      config,
      exec,
    );

    expect(cache.getGraphifyStats('/external/broken')).toBeUndefined();
  });

  it('captures external graphify stats on mcp__jcodemunch__resolve_repo', () => {
    const report = [
      '# Graph Report - /home/user/meridian',
      '',
      '## Summary',
      '- 32000 nodes · 91000 edges · 440 communities detected',
      '- Extraction: 90% EXTRACTED · 10% INFERRED · 0% AMBIGUOUS',
    ].join('\n');
    const exec = (cmd: string) => {
      if (cmd.includes('test -f')) throw new Error('not found');
      if (cmd.includes('graphify update')) return '';
      if (cmd.includes('GRAPH_REPORT.md')) return report;
      throw new Error(`unexpected: ${cmd}`);
    };

    handlePostToolUse(
      'mcp__jcodemunch__resolve_repo',
      { path: '/home/user/meridian' },
      tracker,
      cache,
      config,
      exec,
    );

    const stats = cache.getGraphifyStats('/home/user/meridian');
    expect(stats).toEqual({
      nodes: 32000, edges: 91000, communities: 440,
      extractedPct: 90, inferredPct: 10, ambiguousPct: 0,
    });
  });

  it('does not capture stats for CWD on resolve_repo', () => {
    const exec = () => '';
    handlePostToolUse(
      'mcp__jcodemunch__resolve_repo',
      { path: '/home/user/claude-rig' },
      tracker,
      cache,
      config,
      exec,
    );

    expect(cache.getGraphifyStats('/home/user/claude-rig')).toBeUndefined();
  });

  it('gracefully handles graphify failure on resolve_repo', () => {
    const exec = () => { throw new Error('graphify not installed'); };

    handlePostToolUse(
      'mcp__jcodemunch__resolve_repo',
      { path: '/external/unreachable' },
      tracker,
      cache,
      config,
      exec,
    );

    expect(cache.getGraphifyStats('/external/unreachable')).toBeUndefined();
  });

  describe('session cache persistence of edits', () => {
    it('persists source file edits to the session cache', () => {
      handlePostToolUse('Edit', { file_path: 'src/router/resolver.ts' }, tracker, cache, config);
      expect(cache.getEditedFiles('source')).toEqual(['src/router/resolver.ts']);
    });

    it('persists test file edits to the session cache', () => {
      handlePostToolUse('Write', { file_path: 'tests/router/resolver.test.ts' }, tracker, cache, config);
      expect(cache.getEditedFiles('test')).toEqual(['tests/router/resolver.test.ts']);
      expect(cache.getEditedFiles('source')).toEqual([]);
    });

    it('does not persist non-source/non-test files', () => {
      handlePostToolUse('Edit', { file_path: 'docs/architecture.md' }, tracker, cache, config);
      expect(cache.getEditedFiles('source')).toEqual([]);
      expect(cache.getEditedFiles('test')).toEqual([]);
    });
  });

  describe('structured severity', () => {
    it('returns level advise for an advise-level constitutional violation', () => {
      const result = handlePostToolUse(
        'Edit',
        {
          file_path: 'tests/router/resolver.stack.test.ts',
          new_string: "vi.mock('../src/config.js');",
        },
        tracker,
        cache,
        config,
      );
      expect(result).not.toBeNull();
      expect(result?.level).toBe('advise');
      expect(result?.message).toContain('no_mocks');
    });

    it('returns level block for a block-level constitutional violation', () => {
      const result = handlePostToolUse(
        'Edit',
        { file_path: 'src/notes.ts', new_string: '// all tests pass' },
        tracker,
        cache,
        config,
      );
      expect(result).not.toBeNull();
      expect(result?.level).toBe('block');
      expect(result?.message).toContain('evidence_only');
    });

    it('does not escalate an advise-level zero-defect result whose output embeds the literal [BLOCK]', () => {
      config.rules.zero_defect = { tolerance: 'permissive' };
      const testOutput = [
        "FAIL tests/hooks.test.ts > emits the '[BLOCK]' prefix for block-level rules",
        'Tests: 1 failed',
      ].join('\n');

      const result = handlePostToolUse(
        'Bash',
        { command: 'npx vitest run', output: testOutput },
        tracker,
        cache,
        config,
      );
      expect(result).not.toBeNull();
      expect(result?.level).toBe('advise');
      // The message legitimately contains the literal string '[BLOCK]' from
      // the embedded test output — the level must come from the check, not
      // from sniffing the message text.
      expect(result?.message).toContain('[BLOCK]');
    });

    it('combines to level block when any violation is block-level', () => {
      // Stale-test advisory (advise-level) + evidence_only (block-level)
      // fire in the same call: combined level must be block.
      tracker.recordEdit('src/other.ts');
      tracker.nextTurn();
      const result = handlePostToolUse(
        'Edit',
        { file_path: 'src/notes.ts', new_string: '// all tests pass' },
        tracker,
        cache,
        config,
      );
      expect(result).not.toBeNull();
      expect(result?.message).toContain('STALE TEST');
      expect(result?.message).toContain('evidence_only');
      expect(result?.level).toBe('block');
    });
  });

  describe('skill phase tracking', () => {
    it('sets tdd+ phase when the tdd-plus skill is invoked', () => {
      const result = handlePostToolUse('Skill', { skill: 'tdd-plus' }, tracker, cache, config);
      expect(cache.getCurrentPhase()).toBe('tdd+');
      expect(result).toBeNull();
    });

    it('sets sdd+ phase when the sdd-plus skill is invoked', () => {
      handlePostToolUse('Skill', { skill: 'sdd-plus' }, tracker, cache, config);
      expect(cache.getCurrentPhase()).toBe('sdd+');
    });

    it('sets verify+ phase when verify-plus is invoked (exits scoped-test phases)', () => {
      handlePostToolUse('Skill', { skill: 'tdd-plus' }, tracker, cache, config);
      handlePostToolUse('Skill', { skill: 'verify-plus' }, tracker, cache, config);
      expect(cache.getCurrentPhase()).toBe('verify+');
    });

    it('maps investigate to debug+ phase', () => {
      handlePostToolUse('Skill', { skill: 'investigate' }, tracker, cache, config);
      expect(cache.getCurrentPhase()).toBe('debug+');
    });

    it('strips plugin namespaces from skill names', () => {
      handlePostToolUse('Skill', { skill: 'my-plugin:tdd-plus' }, tracker, cache, config);
      expect(cache.getCurrentPhase()).toBe('tdd+');
    });

    it('ignores skills that are not chain phases', () => {
      handlePostToolUse('Skill', { skill: 'tdd-plus' }, tracker, cache, config);
      handlePostToolUse('Skill', { skill: 'savings' }, tracker, cache, config);
      expect(cache.getCurrentPhase()).toBe('tdd+');
    });
  });
});

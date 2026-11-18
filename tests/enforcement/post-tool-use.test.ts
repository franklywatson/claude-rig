import { describe, it, expect, beforeEach } from 'vitest';
import { handlePostToolUse, isShellQuotablePath, SKILL_PHASE_MAP } from '../../src/enforcement/post-tool-use.js';
import { SkillPhaseTracker } from '../../src/skills/phase-tracker.js';
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

  it('checks zero-defect on Bash test commands (legacy tool_input.output fallback)', () => {
    const testOutput = 'FAIL tests/a.test.ts\nTests: 1 failed';
    const result = handlePostToolUse('Bash', { command: 'npx vitest run', output: testOutput }, tracker, cache, config);
    expect(result).not.toBeNull();
    expect(result?.message).toContain('ZERO-DEFECT');
  });

  describe('zero-defect output extraction from the real hook payload (tool_response)', () => {
    // Claude Code's PostToolUse payload delivers command output in
    // `tool_response` (a string, or an object with stdout/stderr) — NOT in
    // `tool_input.output`. The handler must read the real field or the check
    // is dormant in every live session.
    const failingOutput = 'FAIL tests/a.test.ts\nTests: 1 failed';

    it('fires when output arrives as a tool_response string', () => {
      const result = handlePostToolUse(
        'Bash',
        { command: 'npx vitest run' },
        tracker,
        cache,
        config,
        undefined,
        failingOutput,
      );
      expect(result).not.toBeNull();
      expect(result?.message).toContain('ZERO-DEFECT');
    });

    it('fires when output arrives as tool_response { stdout }', () => {
      const result = handlePostToolUse(
        'Bash',
        { command: 'npx vitest run' },
        tracker,
        cache,
        config,
        undefined,
        { stdout: failingOutput },
      );
      expect(result).not.toBeNull();
      expect(result?.message).toContain('ZERO-DEFECT');
    });

    it('joins stdout and stderr when both present (failures often land on stderr)', () => {
      const result = handlePostToolUse(
        'Bash',
        { command: 'npx vitest run' },
        tracker,
        cache,
        config,
        undefined,
        { stdout: 'RUN v3.0.0', stderr: 'FAIL tests/a.test.ts\nTests: 1 failed' },
      );
      expect(result).not.toBeNull();
      expect(result?.message).toContain('ZERO-DEFECT');
    });

    it('prefers tool_response over the legacy tool_input.output when both present', () => {
      const result = handlePostToolUse(
        'Bash',
        { command: 'npx vitest run', output: 'Tests: 5 passed' },
        tracker,
        cache,
        config,
        undefined,
        failingOutput,
      );
      expect(result).not.toBeNull();
      expect(result?.message).toContain('ZERO-DEFECT');
    });

    it('passes cleanly when tool_response shows a passing run', () => {
      const result = handlePostToolUse(
        'Bash',
        { command: 'npx vitest run' },
        tracker,
        cache,
        config,
        undefined,
        'Test Files  1 passed (1)\nTests  5 passed (5)',
      );
      expect(result).toBeNull();
    });

    it('returns null when tool_response carries no string output', () => {
      const result = handlePostToolUse(
        'Bash',
        { command: 'npx vitest run' },
        tracker,
        cache,
        config,
        undefined,
        { interrupted: false },
      );
      expect(result).toBeNull();
    });

    it('threads the cache phase into zero-defect: a tdd+ RED run is advisory, not a block', () => {
      config.rules.zero_defect = { tolerance: 'strict', unrelated_errors: 'block' };
      cache.setPhase('tdd+');
      const result = handlePostToolUse(
        'Bash',
        { command: 'npx vitest run' },
        tracker,
        cache,
        config,
        undefined,
        'FAIL tests/a.test.ts\nTests: 1 failed',
      );
      expect(result).not.toBeNull();
      expect(result?.level).toBe('advise');
    });
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

  it('checks constitutional on stack test files written via Write (content, not new_string)', () => {
    // The Write tool delivers file content in `content`, not `new_string`.
    // Constitutional inspection must read `content` or the check is dormant for
    // every file created via Write.
    const result = handlePostToolUse(
      'Write',
      {
        file_path: 'tests/router/resolver.stack.test.ts',
        content: "jest.mock('../src/router/resolver.js');",
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

  it.each<[string, string, Record<string, unknown>]>([
    ['index_folder path', 'mcp__jcodemunch__index_folder', { path: '/external/a$b' }],
    ['index_folder folder_path', 'mcp__jcodemunch__index_folder', { folder_path: '/external/a%b' }],
    ['index_folder path that is not a string', 'mcp__jcodemunch__index_folder', { path: 42 }],
    ['index_folder path ending in a backslash', 'mcp__jcodemunch__index_folder', { path: 'C:\\external\\proj\\' }],
    ['index_folder path starting with a hyphen', 'mcp__jcodemunch__index_folder', { path: '-x/../external' }],
    ['resolve_repo path', 'mcp__jcodemunch__resolve_repo', { path: '/external/a"b' }],
    ['double-quoted Bash graphify update', 'Bash', { command: 'graphify update "/external/a$b"' }],
    ['single-quoted Bash graphify update', 'Bash', { command: "graphify update '/external/a\"b'" }],
    ['unquoted Bash graphify update', 'Bash', { command: 'graphify update /external/a%b' }],
    ['unquoted Bash operand that ends in a backslash', 'Bash', { command: 'graphify update /external/my\\ dir' }],
    ['index_folder path with an exclamation mark', 'mcp__jcodemunch__index_folder', { path: '/external/a!b' }],
  ])('runs no capture command when the path is not shell-quotable: %s', (_label, tool, args) => {
    const calls: string[] = [];
    const exec = (cmd: string) => { calls.push(cmd); return ''; };

    handlePostToolUse(tool, args, tracker, cache, config, exec);

    expect(calls).toEqual([]);
  });

  it('applies the doubled-backslash rule of the platform the hook runs on', () => {
    const calls: string[] = [];
    const exec = (cmd: string) => { calls.push(cmd); throw new Error('not found'); };

    handlePostToolUse('mcp__jcodemunch__index_folder', { path: '/external/a\\\\b' }, tracker, cache, config, exec);

    // Skipped where the hook's shell is /bin/sh, captured where it is cmd.exe.
    expect(calls.length === 0).toBe(process.platform !== 'win32');
  });

  it('still captures stats for a safe external path with a space and ampersand', () => {
    const report = '- 10 nodes · 20 edges · 3 communities detected';
    const calls: string[] = [];
    const exec = (cmd: string) => {
      calls.push(cmd);
      if (cmd.includes('test -f')) throw new Error('not found');
      if (cmd.includes('graphify update')) return '';
      if (cmd.includes('GRAPH_REPORT.md')) return report;
      throw new Error(`unexpected: ${cmd}`);
    };

    handlePostToolUse(
      'mcp__jcodemunch__index_folder',
      { path: '/external/R&D proj' },
      tracker,
      cache,
      config,
      exec,
    );

    expect(calls.some(c => c.includes('graphify update'))).toBe(true);
    expect(cache.getGraphifyStats('/external/R&D proj')?.nodes).toBe(10);
  });

  it.each<[string, string, Record<string, unknown>, string]>([
    ['index_folder folder_path', 'mcp__jcodemunch__index_folder', { folder_path: '/external/via folder' }, '/external/via folder'],
    ['a single-quoted Bash graphify update', 'Bash', { command: "graphify update '/external/quoted dir'" }, '/external/quoted dir'],
    ['a double-quoted Bash graphify update followed by a semicolon', 'Bash', { command: 'graphify update "/external/semi dir"; echo done' }, '/external/semi dir'],
  ])('still captures stats through %s', (_label, tool, args, dir) => {
    const report = '- 10 nodes · 20 edges · 3 communities detected';
    const exec = (cmd: string) => {
      if (cmd.includes('test -f')) throw new Error('not found');
      if (cmd.includes('graphify update')) return '';
      if (cmd.includes('GRAPH_REPORT.md')) return report;
      throw new Error(`unexpected: ${cmd}`);
    };

    handlePostToolUse(tool, args, tracker, cache, config, exec);

    expect(cache.getGraphifyStats(dir)?.nodes).toBe(10);
  });

  describe('stale-test detection across hook processes (turn model)', () => {
    // Hooks run as separate processes: every invocation builds a FRESH
    // FileTracker. A "turn" is one PostToolUse Edit/Write invocation, counted
    // in the session cache; the turn-stamped edit history is hydrated into
    // the fresh tracker so a source file edited in an earlier invocation
    // (and not covered by a test edit) fires on a later one.
    function freshInvocation(
      sharedCache: SessionCache,
      filePath: string,
    ): ReturnType<typeof handlePostToolUse> {
      // Fresh tracker per call simulates the separate hook process.
      return handlePostToolUse(
        'Edit',
        { file_path: filePath, old_string: 'a', new_string: 'b' },
        new FileTracker(),
        sharedCache,
        config,
      );
    }

    it('fires on the second consecutive edit of the same source file', () => {
      const first = freshInvocation(cache, 'src/feature/widget.ts');
      expect(first).toBeNull();

      const second = freshInvocation(cache, 'src/feature/widget.ts');
      expect(second).not.toBeNull();
      expect(second?.level).toBe('advise');
      expect(second?.message).toContain('STALE TEST');
      expect(second?.message).toContain('src/feature/widget.ts');
    });

    it('fires for an earlier uncovered source edit when a different file is edited', () => {
      freshInvocation(cache, 'src/feature/widget.ts');
      const result = freshInvocation(cache, 'src/feature/gadget.ts');
      expect(result).not.toBeNull();
      expect(result?.message).toContain('src/feature/widget.ts');
      // The current invocation's edit is exempt (creation turn).
      expect(result?.message).not.toContain('src/feature/gadget.ts');
    });

    it('does not fire once a covering test edit is recorded', () => {
      freshInvocation(cache, 'src/feature/widget.ts');
      freshInvocation(cache, 'tests/feature/widget.test.ts');
      const result = freshInvocation(cache, 'src/feature/widget.ts');
      expect(result).toBeNull();
    });

    it('respects grace_period across invocations', () => {
      config.rules.stale_tests = { enforcement: 'advise', grace_period: 1 };
      freshInvocation(cache, 'src/feature/widget.ts'); // turn 1
      expect(freshInvocation(cache, 'src/feature/widget.ts')).toBeNull(); // turn 2, within grace
      const third = freshInvocation(cache, 'src/feature/widget.ts'); // turn 3, past grace
      expect(third).not.toBeNull();
      expect(third?.message).toContain('STALE TEST');
    });

    it('suppresses a repeat advisory when the stale set is unchanged (dedup)', () => {
      expect(freshInvocation(cache, 'src/feature/widget.ts')).toBeNull();        // turn 1, exempt
      const fires = freshInvocation(cache, 'src/feature/widget.ts');             // turn 2, {widget} → fire
      expect(fires?.message).toContain('STALE TEST');
      // turn 3, identical stale set {widget} → no repeat advisory (advisory fatigue fix)
      expect(freshInvocation(cache, 'src/feature/widget.ts')).toBeNull();
    });

    it('re-fires when a new file joins the stale set', () => {
      freshInvocation(cache, 'src/feature/widget.ts');                           // turn 1, exempt
      expect(freshInvocation(cache, 'src/feature/widget.ts')?.message)           // turn 2, {widget} → fire
        .toContain('STALE TEST');
      // turn 3 edits gadget (its own creation turn is exempt); set still {widget} → suppressed
      expect(freshInvocation(cache, 'src/feature/gadget.ts')).toBeNull();
      // turn 4: gadget is now past its creation turn → set {widget, gadget} changed → re-fire
      const grew = freshInvocation(cache, 'src/feature/gadget.ts');
      expect(grew?.message).toContain('src/feature/gadget.ts');
      expect(grew?.message).toContain('src/feature/widget.ts');
    });
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

    it('clears edited-file history when entering tdd+ from no phase', () => {
      cache.addEditedFile('src/old-feature.ts', 'source');
      cache.addEditedFile('tests/old-feature.test.ts', 'test');
      handlePostToolUse('Skill', { skill: 'tdd-plus' }, tracker, cache, config);
      expect(cache.getEditedFiles('source')).toEqual([]);
      expect(cache.getEditedFiles('test')).toEqual([]);
    });

    it('clears edited-file history when entering a scoped phase from a different phase', () => {
      handlePostToolUse('Skill', { skill: 'verify-plus' }, tracker, cache, config);
      cache.addEditedFile('src/feature-one.ts', 'source');
      handlePostToolUse('Skill', { skill: 'sdd-plus' }, tracker, cache, config);
      expect(cache.getEditedFiles('source')).toEqual([]);
    });

    it('does not clear edited-file history when re-entering the same scoped phase', () => {
      handlePostToolUse('Skill', { skill: 'tdd-plus' }, tracker, cache, config);
      handlePostToolUse('Edit', { file_path: 'src/feature.ts' }, tracker, cache, config);
      handlePostToolUse('Skill', { skill: 'tdd-plus' }, tracker, cache, config);
      expect(cache.getEditedFiles('source')).toEqual(['src/feature.ts']);
    });

    it('does not clear edited-file history when entering a non-scoped phase', () => {
      handlePostToolUse('Skill', { skill: 'tdd-plus' }, tracker, cache, config);
      handlePostToolUse('Edit', { file_path: 'src/feature.ts' }, tracker, cache, config);
      handlePostToolUse('Skill', { skill: 'verify-plus' }, tracker, cache, config);
      expect(cache.getEditedFiles('source')).toEqual(['src/feature.ts']);
    });

    it('covers every phase-tracker phase in SKILL_PHASE_MAP', () => {
      // If a future chain skill adds a phase to PHASE_ORDER without a skill
      // name mapping here, phase tracking silently misses it.
      const reachablePhases = new Set(Object.values(SKILL_PHASE_MAP));
      for (const phase of new SkillPhaseTracker().getAllPhases()) {
        expect(reachablePhases).toContain(phase);
      }
    });

    it('maps every SKILL_PHASE_MAP value to a valid tracker phase', () => {
      const trackerPhases = new Set<string>(new SkillPhaseTracker().getAllPhases());
      for (const phase of Object.values(SKILL_PHASE_MAP)) {
        expect(trackerPhases).toContain(phase);
      }
    });
  });
});

// The guard decides whether a tool-supplied path may be placed inside the
// double-quoted stats-capture commands. Allowed characters must not change the
// command on either /bin/sh or cmd.exe.
describe('isShellQuotablePath', () => {
  it.each([
    ['a plain absolute path', '/ext/project'],
    ['a space', '/ext/my project'],
    ['an ampersand', '/ext/R&D'],
    ['a pipe', '/ext/a|b'],
    ['a semicolon', '/ext/a;b'],
    ['a single quote', "/ext/o'brien"],
    ['parentheses', '/ext/proj (1)'],
    ['a backslash that is not last', 'C:\\ext\\project'],
    ['a non-ASCII letter', '/ext/caf\u00e9'],
    ['a hyphen that is not leading', '/ext/-inner/-x'],
  ])('allows %s', (_label, path) => {
    expect(isShellQuotablePath(path)).toBe(true);
  });

  it.each([
    ['a double quote', '/ext/a"b'],
    ['a dollar sign', '/ext/a$b'],
    ['a backtick', '/ext/a`b'],
    ['a percent sign', '/ext/a%b'],
    ['an exclamation mark', '/ext/a!b'],
    ['a newline', '/ext/a\nb'],
    ['a carriage return', '/ext/a\rb'],
    ['a tab', '/ext/a\tb'],
    ['a NUL', '/ext/a\u0000b'],
    ['the last C0 control character', '/ext/a\u001fb'],
    ['a DEL', '/ext/a\u007fb'],
    ['a trailing backslash', 'C:\\ext\\project\\'],
    ['a trailing backslash without a drive letter', '/ext/project\\'],
    ['a leading hyphen', '-x/ext'],
    ['a leading hyphen behind ./', './-x/ext'],
    ['a leading hyphen behind a parent segment', 'a/../-x/ext'],
    ['a leading hyphen that normalizing removes', '-x/../ext'],
  ])('rejects %s', (_label, path) => {
    expect(isShellQuotablePath(path)).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(isShellQuotablePath(value)).toBe(false);
  });

  it('rejects every C0 control character and DEL', () => {
    const controls = [...Array.from({ length: 0x20 }, (_, code) => code), 0x7f];
    for (const code of controls) {
      expect(isShellQuotablePath(`/ext/a${String.fromCharCode(code)}b`)).toBe(false);
    }
  });

  // /bin/sh reads a doubled backslash inside double quotes as one, so the
  // command would name a different directory. cmd.exe keeps both.
  it.each(['linux', 'darwin'] as const)('rejects a doubled backslash on %s', (platform) => {
    expect(isShellQuotablePath('/ext/a\\\\b', platform)).toBe(false);
    expect(isShellQuotablePath('\\\\host\\share\\proj', platform)).toBe(false);
  });

  it('allows a doubled backslash on win32, where UNC paths start with one', () => {
    expect(isShellQuotablePath('\\\\host\\share\\proj', 'win32')).toBe(true);
    expect(isShellQuotablePath('C:\\ext\\\\proj', 'win32')).toBe(true);
  });
});

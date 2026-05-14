import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handlePreToolUse } from '../../src/router/hook.js';
import { SessionCache } from '../../src/session/cache.js';
import type { Environment, HarnessConfig, PythonEnv } from '../../src/types.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

function makeEnv(overrides: Partial<Environment> = {}): Environment {
  return {
    rtkAvailable: false,
    rtkPath: null,
    jcodemunchAvailable: false,
    jcodemunchCwdIndexed: false,
    jcodemunchCwdRepo: null,
    jcodemunchKnownRepos: [],
    graphifyAvailable: false,
    graphifyGraphPath: null,
    detectedAt: Date.now(),
    ...overrides,
  };
}

describe('handlePreToolUse', () => {
  let cache: SessionCache;
  let config: HarnessConfig;

  beforeEach(() => {
    cache = new SessionCache();
    config = structuredClone(DEFAULT_CONFIG);
  });

  it('allows Read tool without interception', () => {
    cache.setEnvironment(makeEnv());
    const result = handlePreToolUse('Read', { file_path: '/some/file.ts' }, cache, config);
    expect(result).toBeNull(); // null = allow, no output
  });

  it('advises jcodemunch for Grep when indexed (first call)', () => {
    cache.setEnvironment(makeEnv({ jcodemunchAvailable: true, jcodemunchCwdIndexed: true }));
    const result = handlePreToolUse('Grep', { pattern: 'function' }, cache, config);
    expect(result).not.toBeNull();
    expect(result).toContain('jcodemunch');
    expect(result).toContain('ADVISE');
  });

  it('blocks sed -i regardless of environment', () => {
    cache.setEnvironment(makeEnv({ rtkAvailable: true, jcodemunchAvailable: true, jcodemunchCwdIndexed: true }));
    const result = handlePreToolUse('Bash', { command: "sed -i 's/old/new/g' file.ts" }, cache, config);
    expect(result).not.toBeNull();
    expect(result).toContain('block');
    expect(result).toContain('Edit');
  });

  it('advises rtk for grep when rtk available', () => {
    cache.setEnvironment(makeEnv({ rtkAvailable: true, rtkPath: '/usr/bin/rtk' }));
    const result = handlePreToolUse('Bash', { command: 'grep -r pattern .' }, cache, config);
    expect(result).not.toBeNull();
    expect(result).toContain('rtk');
  });

  it('returns null for pass-through tools', () => {
    cache.setEnvironment(makeEnv());
    const result = handlePreToolUse('Bash', { command: 'ls -la' }, cache, config);
    expect(result).toBeNull();
  });

  it('returns null for Edit tool (allowed)', () => {
    cache.setEnvironment(makeEnv());
    const result = handlePreToolUse('Edit', { file_path: '/some/file.ts' }, cache, config);
    expect(result).toBeNull();
  });

  it('advises jcodemunch for native Grep on first call', () => {
    cache.setEnvironment(makeEnv({ jcodemunchAvailable: true, jcodemunchCwdIndexed: true }));
    const result = handlePreToolUse('Grep', { pattern: 'test' }, cache, config);
    expect(result).not.toBeNull();
    expect(result).toContain('jcodemunch');
    expect(result).toContain('ADVISE');
  });

  it('suppresses jcodemunch advisory for native Grep on second call (first-occurrence)', () => {
    cache.setEnvironment(makeEnv({ jcodemunchAvailable: true, jcodemunchCwdIndexed: true }));
    // First call — advises
    handlePreToolUse('Grep', { pattern: 'test' }, cache, config);
    // Second call — suppressed
    const result = handlePreToolUse('Grep', { pattern: 'another' }, cache, config);
    expect(result).toBeNull();
  });

  it('advises for native Read on code file when jcodemunch indexed (first call)', () => {
    cache.setEnvironment(makeEnv({ jcodemunchAvailable: true, jcodemunchCwdIndexed: true }));
    const result = handlePreToolUse('Read', { file_path: '/some/file.ts' }, cache, config);
    expect(result).not.toBeNull();
    expect(result).toContain('jcodemunch');
    expect(result).toContain('ADVISE');
  });

  it('suppresses native Read advisory on second call (first-occurrence)', () => {
    cache.setEnvironment(makeEnv({ jcodemunchAvailable: true, jcodemunchCwdIndexed: true }));
    handlePreToolUse('Read', { file_path: '/some/file.ts' }, cache, config);
    const result = handlePreToolUse('Read', { file_path: '/other/file.ts' }, cache, config);
    expect(result).toBeNull();
  });

  it('allows native Read on code file when jcodemunch not indexed', () => {
    cache.setEnvironment(makeEnv({ jcodemunchAvailable: false }));
    const result = handlePreToolUse('Read', { file_path: '/some/file.ts' }, cache, config);
    expect(result).toBeNull();
  });

  it('allows native Read on non-code file', () => {
    cache.setEnvironment(makeEnv({ jcodemunchAvailable: true, jcodemunchCwdIndexed: true }));
    const result = handlePreToolUse('Read', { file_path: '/some/readme.txt' }, cache, config);
    expect(result).toBeNull();
  });

  it('allows native Read with offset (targeted re-read)', () => {
    cache.setEnvironment(makeEnv({ jcodemunchAvailable: true, jcodemunchCwdIndexed: true }));
    const result = handlePreToolUse('Read', { file_path: '/some/file.ts', offset: 10 }, cache, config);
    expect(result).toBeNull();
  });

  it('advises for native Grep when jcodemunch indexed (first call)', () => {
    cache.setEnvironment(makeEnv({ jcodemunchAvailable: true, jcodemunchCwdIndexed: true }));
    const result = handlePreToolUse('Grep', { pattern: 'function' }, cache, config);
    expect(result).not.toBeNull();
    expect(result).toContain('jcodemunch');
    expect(result).toContain('ADVISE');
  });

  it('suppresses Grep advisory on second call (first-occurrence)', () => {
    cache.setEnvironment(makeEnv({ jcodemunchAvailable: true, jcodemunchCwdIndexed: true }));
    handlePreToolUse('Grep', { pattern: 'function' }, cache, config);
    const result = handlePreToolUse('Grep', { pattern: 'another' }, cache, config);
    expect(result).toBeNull();
  });

  it('allows native Grep when jcodemunch not indexed', () => {
    cache.setEnvironment(makeEnv({ jcodemunchAvailable: false }));
    const result = handlePreToolUse('Grep', { pattern: 'function' }, cache, config);
    expect(result).toBeNull();
  });

  it('advises for native Glob on code pattern when jcodemunch indexed (first call)', () => {
    cache.setEnvironment(makeEnv({ jcodemunchAvailable: true, jcodemunchCwdIndexed: true }));
    const result = handlePreToolUse('Glob', { pattern: '**/*.ts' }, cache, config);
    expect(result).not.toBeNull();
    expect(result).toContain('jcodemunch');
    expect(result).toContain('ADVISE');
  });

  it('suppresses Glob advisory on second call (first-occurrence)', () => {
    cache.setEnvironment(makeEnv({ jcodemunchAvailable: true, jcodemunchCwdIndexed: true }));
    handlePreToolUse('Glob', { pattern: '**/*.ts' }, cache, config);
    const result = handlePreToolUse('Glob', { pattern: '**/*.py' }, cache, config);
    expect(result).toBeNull();
  });

  it('allows native Glob when jcodemunch not indexed', () => {
    cache.setEnvironment(makeEnv({ jcodemunchAvailable: false }));
    const result = handlePreToolUse('Glob', { pattern: '**/*.ts' }, cache, config);
    expect(result).toBeNull();
  });

  it('blocks rtk cat on code files', () => {
    cache.setEnvironment(makeEnv());
    const result = handlePreToolUse('Bash', { command: 'rtk cat /some/file.ts' }, cache, config);
    expect(result).not.toBeNull();
    expect(result).toContain('BLOCK');
    expect(result).toContain('jcodemunch');
  });

  it('allows rtk cat on non-code files', () => {
    cache.setEnvironment(makeEnv());
    const result = handlePreToolUse('Bash', { command: 'rtk cat /some/readme.txt' }, cache, config);
    expect(result).toBeNull();
  });

  it('config override suppresses native_read advice', () => {
    config.rules.tool_routing!.native_read = 'silent';
    cache.setEnvironment(makeEnv({ jcodemunchAvailable: true, jcodemunchCwdIndexed: true }));
    const result = handlePreToolUse('Read', { file_path: '/some/file.ts' }, cache, config);
    // silent enforcement still returns null (no output)
    expect(result).toBeNull();
  });

  it('config override blocks native_read advice', () => {
    config.rules.tool_routing!.native_read = 'block';
    cache.setEnvironment(makeEnv({ jcodemunchAvailable: true, jcodemunchCwdIndexed: true }));
    const result = handlePreToolUse('Read', { file_path: '/some/file.ts' }, cache, config);
    expect(result).not.toBeNull();
    expect(result).toContain('BLOCK');
  });

  // cwd_path_expand tests
  it('advises when Bash command starts with fully-qualified CWD path', () => {
    cache.setEnvironment(makeEnv());
    const result = handlePreToolUse('Bash', { command: '/home/user/projects/my-app/bin/pip install pytest' }, cache, config, '/home/user/projects/my-app');
    expect(result).not.toBeNull();
    expect(result).toContain('ADVISE');
    expect(result).toContain('./bin/pip');
  });

  it('cwd_path_expand does not fire on .venv/bin paths', () => {
    cache.setEnvironment(makeEnv());
    const result = handlePreToolUse('Bash', { command: '/home/user/projects/my-app/.venv/bin/pip install pytest' }, cache, config, '/home/user/projects/my-app');
    expect(result).toBeNull();
  });

  it('advises with correct relative path when cwd has a space (backslash-escaped form)', () => {
    cache.setEnvironment(makeEnv());
    const result = handlePreToolUse(
      'Bash',
      { command: '/Users/bob/Documents/Some\\ Project/app/scripts/foo --flag' },
      cache,
      config,
      '/Users/bob/Documents/Some Project/app',
    );
    expect(result).not.toBeNull();
    expect(result).toContain('ADVISE');
    expect(result).toContain('./scripts/foo');
  });

  it('advises with correct relative path when cwd has a space (double-quoted form)', () => {
    cache.setEnvironment(makeEnv());
    const result = handlePreToolUse(
      'Bash',
      { command: '"/Users/bob/Documents/Some Project/app/scripts/foo" --flag' },
      cache,
      config,
      '/Users/bob/Documents/Some Project/app',
    );
    expect(result).not.toBeNull();
    expect(result).toContain('ADVISE');
    expect(result).toContain('./scripts/foo');
  });

  it('cwd_path_expand respects block enforcement', () => {
    config.rules.tool_routing!.cwd_path_expand = 'block';
    cache.setEnvironment(makeEnv());
    const result = handlePreToolUse('Bash', { command: '/home/user/projects/my-app/bin/pip install pytest' }, cache, config, '/home/user/projects/my-app');
    expect(result).not.toBeNull();
    expect(result).toContain('BLOCK');
  });

  // Python environment rewrite tests
  it('rewrites pytest command when venv available and .py file in args', () => {
    cache.setEnvironment(makeEnv());
    cache.setPythonEnv({ venvPath: '/project/.venv', uvAvailable: false, uvPath: null, detectedAt: Date.now() });
    const result = handlePreToolUse(
      'Bash',
      { command: 'pytest tests/test_foo.py -v' },
      cache,
      config,
      '/project',
      { existsCheck: (p) => p === '/project/.venv/bin/pytest' },
    );
    expect(result).not.toBeNull();
    expect(result).toEqual({ type: 'rewrite', command: '.venv/bin/pytest tests/test_foo.py -v', original: 'pytest tests/test_foo.py -v' });
  });

  it('rewrites to uv run when no venv but uv available and .py file in args', () => {
    cache.setEnvironment(makeEnv());
    cache.setPythonEnv({ venvPath: null, uvAvailable: true, uvPath: '/usr/bin/uv', detectedAt: Date.now() });
    const result = handlePreToolUse(
      'Bash',
      { command: 'pytest tests/test_foo.py -v' },
      cache,
      config,
      '/project',
      { existsCheck: () => false },
    );
    expect(result).not.toBeNull();
    expect(result).toEqual({ type: 'rewrite', command: 'uv run pytest tests/test_foo.py -v', original: 'pytest tests/test_foo.py -v' });
  });

  it('does not rewrite when no .py file in command', () => {
    cache.setEnvironment(makeEnv());
    cache.setPythonEnv({ venvPath: '/project/.venv', uvAvailable: false, uvPath: null, detectedAt: Date.now() });
    const result = handlePreToolUse(
      'Bash',
      { command: 'git add src/store.py' },
      cache,
      config,
      '/project',
      { existsCheck: () => true },
    );
    expect(result).toBeNull();
  });

  it('does not rewrite compound commands', () => {
    cache.setEnvironment(makeEnv());
    cache.setPythonEnv({ venvPath: null, uvAvailable: true, uvPath: '/usr/bin/uv', detectedAt: Date.now() });
    const result = handlePreToolUse(
      'Bash',
      { command: 'pytest tests/test_foo.py && git add src/store.py' },
      cache,
      config,
      '/project',
      { existsCheck: () => false },
    );
    expect(result).toBeNull();
  });

  it('does not rewrite when no python env cached', () => {
    cache.setEnvironment(makeEnv());
    const result = handlePreToolUse(
      'Bash',
      { command: 'pytest tests/test_foo.py -v' },
      cache,
      config,
      '/project',
    );
    expect(result).toBeNull();
  });
});

describe('scout_explore advisory', () => {
  let cache: SessionCache;
  let config: HarnessConfig;

  beforeEach(() => {
    cache = new SessionCache();
    config = structuredClone(DEFAULT_CONFIG);
  });

  it('advises scout for Agent Explore when jcodemunch available and indexed (first call)', () => {
    cache.setEnvironment(makeEnv({ jcodemunchAvailable: true, jcodemunchCwdIndexed: true }));
    const result = handlePreToolUse('Agent', { subagent_type: 'Explore', prompt: 'find auth files' }, cache, config);
    expect(result).not.toBeNull();
    expect(result).toContain('scout');
    expect(result).toContain('ADVISE');
  });

  it('suppresses scout advisory for Agent Explore on second call (first-occurrence)', () => {
    cache.setEnvironment(makeEnv({ jcodemunchAvailable: true, jcodemunchCwdIndexed: true }));
    handlePreToolUse('Agent', { subagent_type: 'Explore', prompt: 'find auth files' }, cache, config);
    const result = handlePreToolUse('Agent', { subagent_type: 'Explore', prompt: 'find config files' }, cache, config);
    expect(result).toBeNull();
  });

  it('advises scout for Agent Explore when jcodemunch available but NOT indexed (first call)', () => {
    cache.setEnvironment(makeEnv({ jcodemunchAvailable: true, jcodemunchCwdIndexed: false }));
    const result = handlePreToolUse('Agent', { subagent_type: 'Explore', prompt: 'map the codebase' }, cache, config);
    expect(result).not.toBeNull();
    expect(result).toContain('scout');
    expect(result).toContain('ADVISE');
  });

  it('falls through to file_discovery advisory when jcodemunch not available but rtk available', () => {
    cache.setEnvironment(makeEnv({ jcodemunchAvailable: false, rtkAvailable: true, rtkPath: '/usr/bin/rtk' }));
    const result = handlePreToolUse('Agent', { subagent_type: 'Explore', prompt: 'find tests' }, cache, config);
    expect(result).not.toBeNull();
    expect(result).toContain('rtk find');
    expect(result).not.toContain('scout');
  });

  it('falls through to file_discovery advisory when neither available', () => {
    cache.setEnvironment(makeEnv({ jcodemunchAvailable: false, rtkAvailable: false }));
    const result = handlePreToolUse('Agent', { subagent_type: 'Explore', prompt: 'find config' }, cache, config);
    expect(result).not.toBeNull();
    expect(result).toContain('Glob');
    expect(result).not.toContain('scout');
  });

  it('allows Agent with general-purpose subagent (pass through)', () => {
    cache.setEnvironment(makeEnv({ jcodemunchAvailable: true, jcodemunchCwdIndexed: true }));
    const result = handlePreToolUse('Agent', { subagent_type: 'general-purpose', prompt: 'fix the bug' }, cache, config);
    expect(result).toBeNull();
  });

  it('respects block enforcement for scout_explore', () => {
    config.rules.tool_routing!.scout_explore = 'block';
    cache.setEnvironment(makeEnv({ jcodemunchAvailable: true, jcodemunchCwdIndexed: true }));
    const result = handlePreToolUse('Agent', { subagent_type: 'Explore', prompt: 'find auth' }, cache, config);
    expect(result).not.toBeNull();
    expect(result).toContain('BLOCK');
    expect(result).toContain('scout');
  });
});

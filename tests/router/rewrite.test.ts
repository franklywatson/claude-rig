import { describe, it, expect } from 'vitest';
import { handlePreToolUse, tryRtkRewrite, type ExecRewriteFn } from '../../src/router/hook.js';
import { SessionCache } from '../../src/session/cache.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import type { RewriteResult } from '../../src/types.js';

// ── Mock exec functions ──

const mockRewriteSuccess: ExecRewriteFn = (_rtkPath, args) => {
  const command = args[1];
  if (/^(cat|head|tail)\s+/.test(command)) return command.replace(/^(cat|head|tail)\s+/, 'rtk read ');
  if (/^grep\s+/.test(command)) return command.replace(/^grep\s+/, 'rtk grep ');
  if (/^rg\s+/.test(command)) return command.replace(/^rg\s+/, 'rtk grep ');
  if (/^find\s+/.test(command)) return command.replace(/^find\s+/, 'rtk find ');
  if (/^git\s+/.test(command)) return command.replace(/^git\s+/, 'rtk git ');
  if (/^ls(\s|$)/.test(command)) return command.replace(/^ls\s*/, 'rtk ls ');
  if (/^gh\s+/.test(command)) return command.replace(/^gh\s+/, 'rtk gh ');
  return null;
};

const mockRewriteNone: ExecRewriteFn = () => null;

const mockRewriteIdentical: ExecRewriteFn = (_rtkPath, args) => args[1];

// ── tryRtkRewrite unit tests ──

describe('tryRtkRewrite', () => {
  it('returns rewritten command when exec returns a different string', () => {
    const result = tryRtkRewrite('cat file.ts', '/usr/bin/rtk', mockRewriteSuccess);
    expect(result).toBe('rtk read file.ts');
  });

  it('returns null when exec returns null (no rewrite)', () => {
    const result = tryRtkRewrite('npm test', '/usr/bin/rtk', mockRewriteNone);
    expect(result).toBeNull();
  });

  it('returns null when exec returns identical command', () => {
    const result = tryRtkRewrite('git status', '/usr/bin/rtk', mockRewriteIdentical);
    expect(result).toBeNull();
  });

  it('returns null when exec returns empty string', () => {
    const result = tryRtkRewrite('git status', '/usr/bin/rtk', () => '');
    expect(result).toBeNull();
  });

  it('rewrites grep to rtk grep', () => {
    const result = tryRtkRewrite('grep -r "TODO" src/', '/usr/bin/rtk', mockRewriteSuccess);
    expect(result).toBe('rtk grep -r "TODO" src/');
  });

  it('rewrites find to rtk find', () => {
    const result = tryRtkRewrite('find . -name "*.ts"', '/usr/bin/rtk', mockRewriteSuccess);
    expect(result).toBe('rtk find . -name "*.ts"');
  });

  it('rewrites git to rtk git', () => {
    const result = tryRtkRewrite('git status', '/usr/bin/rtk', mockRewriteSuccess);
    expect(result).toBe('rtk git status');
  });

  it('does not rewrite sed -i', () => {
    const result = tryRtkRewrite("sed -i 's/foo/bar/' file.ts", '/usr/bin/rtk', mockRewriteSuccess);
    expect(result).toBeNull();
  });

  it('does not rewrite npm', () => {
    const result = tryRtkRewrite('npm test', '/usr/bin/rtk', mockRewriteSuccess);
    expect(result).toBeNull();
  });

  it('does not rewrite python commands', () => {
    const result = tryRtkRewrite('python -m pytest tests/ -m integration --tb=short', '/usr/bin/rtk', mockRewriteSuccess);
    expect(result).toBeNull();
  });
});

// ── handlePreToolUse with rtk rewrite ──

describe('handlePreToolUse: transparent rewriting', () => {
  function makeEnv(overrides: Partial<typeof DEFAULT_ENV> = {}) {
    return { ...DEFAULT_ENV, ...overrides };
  }

  const DEFAULT_ENV = {
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

  it('transparently rewrites cat to rtk read when rtk available', () => {
    const cache = new SessionCache();
    cache.setEnvironment(makeEnv());
    const result = handlePreToolUse(
      'Bash', { command: 'cat src/router/resolver.ts' }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    expect(result).not.toBeNull();
    expect(typeof result).toBe('object');
    expect((result as RewriteResult).type).toBe('rewrite');
    expect((result as RewriteResult).command).toBe('rtk read src/router/resolver.ts');
    expect((result as RewriteResult).original).toBe('cat src/router/resolver.ts');
  });

  it('transparently rewrites grep to rtk grep when rtk available', () => {
    const cache = new SessionCache();
    cache.setEnvironment(makeEnv());
    const result = handlePreToolUse(
      'Bash', { command: 'grep -r "TODO" src/' }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    expect(result).not.toBeNull();
    expect((result as RewriteResult).type).toBe('rewrite');
    expect((result as RewriteResult).command).toBe('rtk grep -r "TODO" src/');
  });

  it('transparently rewrites find to rtk find when rtk available', () => {
    const cache = new SessionCache();
    cache.setEnvironment(makeEnv());
    const result = handlePreToolUse(
      'Bash', { command: 'find . -name "*.ts"' }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    expect(result).not.toBeNull();
    expect((result as RewriteResult).type).toBe('rewrite');
    expect((result as RewriteResult).command).toBe('rtk find . -name "*.ts"');
  });

  it('transparently rewrites git to rtk git when rtk available', () => {
    const cache = new SessionCache();
    cache.setEnvironment(makeEnv());
    const result = handlePreToolUse(
      'Bash', { command: 'git status' }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    expect(result).not.toBeNull();
    expect((result as RewriteResult).type).toBe('rewrite');
    expect((result as RewriteResult).command).toBe('rtk git status');
  });

  it('transparently rewrites rg to rtk grep when rtk available', () => {
    const cache = new SessionCache();
    cache.setEnvironment(makeEnv());
    const result = handlePreToolUse(
      'Bash', { command: 'rg "export.*function" .' }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    expect(result).not.toBeNull();
    expect((result as RewriteResult).type).toBe('rewrite');
    expect((result as RewriteResult).command).toBe('rtk grep "export.*function" .');
  });

  it('transparently rewrites head to rtk read when rtk available', () => {
    const cache = new SessionCache();
    cache.setEnvironment(makeEnv());
    const result = handlePreToolUse(
      'Bash', { command: 'head -20 package.json' }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    expect(result).not.toBeNull();
    expect((result as RewriteResult).type).toBe('rewrite');
    expect((result as RewriteResult).command).toBe('rtk read -20 package.json');
  });

  it('transparently rewrites ls to rtk ls when rtk available', () => {
    const cache = new SessionCache();
    cache.setEnvironment(makeEnv());
    const result = handlePreToolUse(
      'Bash', { command: 'ls src/' }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    expect(result).not.toBeNull();
    expect((result as RewriteResult).type).toBe('rewrite');
    expect((result as RewriteResult).command).toBe('rtk ls src/');
  });
});

// ── Block rules fire BEFORE rewrite attempt ──

describe('handlePreToolUse: block rules take priority', () => {
  const ENV_WITH_RTK = {
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

  it('blocks sed -i even when rtk could rewrite', () => {
    const cache = new SessionCache();
    cache.setEnvironment(ENV_WITH_RTK);
    // Even though mockRewriteSuccess can't rewrite sed -i, verify block fires first
    const result = handlePreToolUse(
      'Bash', { command: "sed -i 's/foo/bar/' file.ts" }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('[BLOCK]');
  });

  it('blocks rtk cat on code files even when rtk available', () => {
    const cache = new SessionCache();
    cache.setEnvironment(ENV_WITH_RTK);
    const result = handlePreToolUse(
      'Bash', { command: 'rtk cat src/types.ts' }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('[BLOCK]');
  });
});

// ── Non-Bash tools never trigger rewrite ──

describe('handlePreToolUse: non-Bash tools', () => {
  const ENV_WITH_RTK = {
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

  it('Read tool returns string (advise), never RewriteResult', () => {
    const cache = new SessionCache();
    cache.setEnvironment(ENV_WITH_RTK);
    const result = handlePreToolUse(
      'Read', { file_path: '/project/src/types.ts' }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    // Should be string (advise about jcodemunch) or null (allow), never a RewriteResult
    if (result !== null) {
      expect(typeof result).toBe('string');
    }
  });

  it('Grep tool returns string (advise), never RewriteResult', () => {
    const cache = new SessionCache();
    cache.setEnvironment(ENV_WITH_RTK);
    const result = handlePreToolUse(
      'Grep', { pattern: 'function resolve' }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    if (result !== null) {
      expect(typeof result).toBe('string');
    }
  });

  it('Glob tool returns string (advise), never RewriteResult', () => {
    const cache = new SessionCache();
    cache.setEnvironment(ENV_WITH_RTK);
    const result = handlePreToolUse(
      'Glob', { pattern: '**/*.ts' }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    if (result !== null) {
      expect(typeof result).toBe('string');
    }
  });

  it('Agent tool returns null (allow), never RewriteResult', () => {
    const cache = new SessionCache();
    cache.setEnvironment(ENV_WITH_RTK);
    const result = handlePreToolUse(
      'Agent', { subagent_type: 'general-purpose', prompt: 'fix the bug' }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    // general-purpose is pass_through, should return null
    expect(result).toBeNull();
  });
});

// ── rtk not available: falls through to advise/block ──

describe('handlePreToolUse: rtk unavailable', () => {
  const ENV_NO_RTK = {
    rtkAvailable: false,
    rtkPath: null,
    jcodemunchAvailable: true,
    jcodemunchCwdIndexed: true,
    jcodemunchCwdRepo: 'local/test',
    jcodemunchKnownRepos: ['local/test'],
    graphifyAvailable: false,
    graphifyGraphPath: null,
    detectedAt: Date.now(),
  };

  it('grep falls through to advise jcodemunch when rtk unavailable', () => {
    const cache = new SessionCache();
    cache.setEnvironment(ENV_NO_RTK);
    const result = handlePreToolUse(
      'Bash', { command: 'grep -r "TODO" src/' }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    // rtk not available, so mockRewriteSuccess is never called
    // Falls through to advise about jcodemunch (default config has grep: 'advise')
    expect(typeof result).toBe('string');
    expect(result).toContain('jcodemunch');
  });

  it('cat falls through to advise jcodemunch when rtk unavailable', () => {
    const cache = new SessionCache();
    cache.setEnvironment(ENV_NO_RTK);
    const result = handlePreToolUse(
      'Bash', { command: 'cat src/file.ts' }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('[ADVISE]');
  });

  it('find falls through to advise jcodemunch when rtk unavailable', () => {
    const cache = new SessionCache();
    cache.setEnvironment(ENV_NO_RTK);
    const result = handlePreToolUse(
      'Bash', { command: 'find . -name "*.ts"' }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('[ADVISE]');
  });
});

// ── Neither rtk nor jcodemunch: falls through to native tool advises ──

describe('handlePreToolUse: neither rtk nor jcodemunch', () => {
  const ENV_NEITHER = {
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

  it('cat falls through to advise Read', () => {
    const cache = new SessionCache();
    cache.setEnvironment(ENV_NEITHER);
    const result = handlePreToolUse(
      'Bash', { command: 'cat src/file.ts' }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('Read');
  });

  it('grep falls through to advise Grep', () => {
    const cache = new SessionCache();
    cache.setEnvironment(ENV_NEITHER);
    const result = handlePreToolUse(
      'Bash', { command: 'grep -r "TODO" src/' }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('Grep');
  });

  it('find falls through to advise Glob', () => {
    const cache = new SessionCache();
    cache.setEnvironment(ENV_NEITHER);
    const result = handlePreToolUse(
      'Bash', { command: 'find . -name "*.ts"' }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('Glob');
  });

  it('git status is allowed (no routing needed)', () => {
    const cache = new SessionCache();
    cache.setEnvironment(ENV_NEITHER);
    const result = handlePreToolUse(
      'Bash', { command: 'git status' }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    expect(result).toBeNull();
  });

  it('npm test is allowed (no rewrite rule)', () => {
    const cache = new SessionCache();
    cache.setEnvironment(ENV_NEITHER);
    const result = handlePreToolUse(
      'Bash', { command: 'npm test' }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    expect(result).toBeNull();
  });
});

// ── Pipe and compound commands ──

describe('handlePreToolUse: pipe handling', () => {
  const ENV_WITH_RTK = {
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

  it('piped command skips rtk rewrite and passes through', () => {
    const cache = new SessionCache();
    cache.setEnvironment(ENV_WITH_RTK);
    const result = handlePreToolUse(
      'Bash', { command: 'cat file | grep pattern' }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    // Compound commands (with |) pass through without rewrite or advise
    expect(result).toBeNull();
  });

  it('pipelines that rtk skips fall through to allow', () => {
    const cache = new SessionCache();
    cache.setEnvironment(ENV_WITH_RTK);
    const result = handlePreToolUse(
      'Bash', { command: 'docker compose build 2>&1 | grep -E "error|Error"' }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    // rtk can't rewrite docker compose, falls through
    // The pipe means intent classifier sees "docker" which doesn't match any rule
    // So it should be null (allow) or a string advise — but NOT a rewrite
    if (result !== null && typeof result !== 'string') {
      // If it's a RewriteResult, that's wrong for docker compose
      expect((result as RewriteResult).type).not.toBe('rewrite');
    }
  });

  it('compound command with sed -i is always blocked', () => {
    const cache = new SessionCache();
    cache.setEnvironment(ENV_WITH_RTK);
    const result = handlePreToolUse(
      'Bash', { command: "rg pattern . ; sed -i 's/a/b/g' f" }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('[BLOCK]');
  });

  it('chained ls; diff passes through without rtk rewrite', () => {
    const cache = new SessionCache();
    cache.setEnvironment(ENV_WITH_RTK);
    const result = handlePreToolUse(
      'Bash', { command: 'ls -la /path/file 2>/dev/null; diff /path/file -' }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    expect(result).toBeNull();
  });

  it('piped cat | grep passes through without rtk rewrite', () => {
    const cache = new SessionCache();
    cache.setEnvironment(ENV_WITH_RTK);
    const result = handlePreToolUse(
      'Bash', { command: 'cat file | grep pattern' }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    expect(result).toBeNull();
  });

  it('chained git status && git diff passes through without rtk rewrite', () => {
    const cache = new SessionCache();
    cache.setEnvironment(ENV_WITH_RTK);
    const result = handlePreToolUse(
      'Bash', { command: 'git status && git diff' }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    expect(result).toBeNull();
  });

  it('or-chained command passes through without rtk rewrite', () => {
    const cache = new SessionCache();
    cache.setEnvironment(ENV_WITH_RTK);
    const result = handlePreToolUse(
      'Bash', { command: 'grep "TODO" src/ 2>/dev/null || echo "none"' }, cache, DEFAULT_CONFIG, undefined, mockRewriteSuccess,
    );
    expect(result).toBeNull();
  });
});


// ── Edge: rtk rewrite returns same command ──

describe('handlePreToolUse: rtk returns identical command', () => {
  const ENV_WITH_RTK = {
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

  it('identical rewrite falls through to advise', () => {
    const cache = new SessionCache();
    cache.setEnvironment(ENV_WITH_RTK);
    const result = handlePreToolUse(
      'Bash', { command: 'cat src/file.ts' }, cache, DEFAULT_CONFIG, undefined, mockRewriteIdentical,
    );
    // tryRtkRewrite returns null for identical, so falls through to advise
    expect(result).not.toBeNull();
    // Should be an advise string, not a RewriteResult
    expect(typeof result).toBe('string');
  });
});

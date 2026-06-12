import { describe, it, expect, beforeEach } from 'vitest';
import { checkBranchDisciplineCommand } from '../../src/router/branch-discipline.js';
import { handlePreToolUse } from '../../src/router/hook.js';
import { SessionCache } from '../../src/session/cache.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import type { Environment, HarnessConfig } from '../../src/types.js';

function makeExec(responses: Record<string, string | Error>, calls?: string[]) {
  return (cmd: string): string => {
    calls?.push(cmd);
    const response = responses[cmd];
    if (response === undefined) throw new Error(`unexpected command: ${cmd}`);
    if (response instanceof Error) throw response;
    return response;
  };
}

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

function cfg(
  level: string,
  strategy = 'auto',
  branches = ['master', 'main'],
): HarnessConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.rules.workflow = {
    branch_discipline: level as never,
    protected_branches: branches,
    isolation_strategy: strategy as never,
  };
  return config;
}

describe('checkBranchDisciplineCommand', () => {
  let cache: SessionCache;

  beforeEach(() => {
    cache = new SessionCache();
  });

  it('advises on git commit on master and suppresses the second call', () => {
    const exec = makeExec({
      'git branch --show-current': 'master',
      'git status --porcelain': '',
    });
    const result = checkBranchDisciplineCommand('git commit -m "x"', cfg('advise'), cache, exec);
    expect(result).not.toBeNull();
    expect(result?.level).toBe('advise');
    expect(result?.message).toContain('master');
    expect(result?.message).toContain('Branch discipline');
    expect(result?.message).toContain('a feature branch');
    expect(result?.message).toContain('rules.workflow.branch_discipline');

    const second = checkBranchDisciplineCommand('git commit -m "y"', cfg('advise'), cache, exec);
    expect(second).toBeNull();
  });

  it('detects git commit in a compound segment', () => {
    const exec = makeExec({
      'git branch --show-current': 'master',
      'git status --porcelain': '',
    });
    const result = checkBranchDisciplineCommand('cd /tmp && git commit -m "x"', cfg('advise'), cache, exec);
    expect(result).not.toBeNull();
    expect(result?.level).toBe('advise');
    expect(result?.message).toContain('master');
  });

  it('blocks git push on main when level is block, with remediation text', () => {
    const exec = makeExec({ 'git branch --show-current': 'main' });
    const result = checkBranchDisciplineCommand('git push', cfg('block'), cache, exec);
    expect(result).not.toBeNull();
    expect(result?.level).toBe('block');
    expect(result?.message).toContain('[BLOCK]');
    expect(result?.message).toContain('main');
    expect(result?.message).toContain('feature branch');
    expect(result?.message).toContain('PR');
    expect(result?.message).toContain('rules.workflow.branch_discipline: block');
  });

  it('returns null for git commit on a feature branch', () => {
    const exec = makeExec({ 'git branch --show-current': 'feat/x' });
    const result = checkBranchDisciplineCommand('git commit -m "x"', cfg('advise'), cache, exec);
    expect(result).toBeNull();
  });

  it('returns null when "git commit" appears only inside quotes', () => {
    const calls: string[] = [];
    const exec = makeExec({ 'git branch --show-current': 'master' }, calls);
    const result = checkBranchDisciplineCommand('echo "git commit"', cfg('advise'), cache, exec);
    expect(result).toBeNull();
    expect(calls).toEqual([]); // never resolves the branch for a quoted mention
  });

  it('returns null for read-only git commands (status, diff)', () => {
    const calls: string[] = [];
    const exec = makeExec({ 'git branch --show-current': 'master' }, calls);
    expect(checkBranchDisciplineCommand('git status', cfg('advise'), cache, exec)).toBeNull();
    expect(checkBranchDisciplineCommand('git diff', cfg('advise'), cache, exec)).toBeNull();
    expect(calls).toEqual([]); // pattern gate rejects before branch resolution
  });

  it('returns null when level is silent', () => {
    const calls: string[] = [];
    const exec = makeExec({ 'git branch --show-current': 'master' }, calls);
    const result = checkBranchDisciplineCommand('git commit -m "x"', cfg('silent'), cache, exec);
    expect(result).toBeNull();
    expect(calls).toEqual([]); // silent short-circuits before branch resolution
  });

  it('returns null when not a git repo (exec throws)', () => {
    const exec = makeExec({ 'git branch --show-current': new Error('not a repo') });
    const result = checkBranchDisciplineCommand('git commit -m "x"', cfg('advise'), cache, exec);
    expect(result).toBeNull();
  });

  it('uses worktree wording when auto strategy sees a dirty tree', () => {
    const exec = makeExec({
      'git branch --show-current': 'master',
      'git status --porcelain': ' M src/a.ts\n',
    });
    const result = checkBranchDisciplineCommand('git commit -m "x"', cfg('advise'), cache, exec);
    expect(result).not.toBeNull();
    expect(result?.message).toContain('using-git-worktrees');
  });
});

describe('handlePreToolUse branch discipline wiring', () => {
  let cache: SessionCache;
  let config: HarnessConfig;

  beforeEach(() => {
    cache = new SessionCache();
    cache.setEnvironment(makeEnv());
  });

  it('returns the [ADVISE] message for git commit on master at advise level', () => {
    config = cfg('advise');
    const exec = makeExec({
      'git branch --show-current': 'master',
      'git status --porcelain': '',
    });
    const result = handlePreToolUse(
      'Bash',
      { command: 'git commit -m "x"' },
      cache,
      config,
      undefined,
      { branchExec: exec },
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('[ADVISE]');
    expect(result).toContain('Branch discipline');
    expect(result).toContain('master');
  });

  it('returns the [BLOCK] message for git push on master at block level', () => {
    config = cfg('block');
    const exec = makeExec({ 'git branch --show-current': 'master' });
    const result = handlePreToolUse(
      'Bash',
      { command: 'git push origin master' },
      cache,
      config,
      undefined,
      { branchExec: exec },
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('[BLOCK]');
    expect(result).toContain('Branch discipline');
  });

  it('passes git commit through on a feature branch', () => {
    config = cfg('advise');
    const exec = makeExec({ 'git branch --show-current': 'feat/x' });
    const result = handlePreToolUse(
      'Bash',
      { command: 'git commit -m "x"' },
      cache,
      config,
      undefined,
      { branchExec: exec },
    );
    expect(result).toBeNull();
  });
});

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

  it('consumed advisory costs zero subprocesses on subsequent calls', () => {
    const exec = makeExec({
      'git branch --show-current': 'master',
      'git status --porcelain': '',
    });
    const first = checkBranchDisciplineCommand('git commit -m "x"', cfg('advise'), cache, exec);
    expect(first).not.toBeNull();

    const calls: string[] = [];
    const exec2 = makeExec({}, calls);
    const second = checkBranchDisciplineCommand('git commit -m "y"', cfg('advise'), cache, exec2);
    expect(second).toBeNull();
    expect(calls).toEqual([]);
  });

  it('re-advises on the 11th protected-branch call after ten suppressed occurrences', () => {
    const exec = makeExec({
      'git branch --show-current': 'master',
      'git status --porcelain': '',
    });
    // Call 1: first advisory for the session.
    const first = checkBranchDisciplineCommand('git commit -m "1"', cfg('advise'), cache, exec);
    expect(first).not.toBeNull();
    expect(first?.level).toBe('advise');

    // Calls 2-10: suppressed (and cost zero subprocesses — empty exec map).
    const silentExec = makeExec({});
    for (let call = 2; call <= 10; call++) {
      expect(
        checkBranchDisciplineCommand(`git commit -m "${call}"`, cfg('advise'), cache, silentExec),
      ).toBeNull();
    }

    // Call 11: re-advisory with the full advisory content.
    const eleventh = checkBranchDisciplineCommand('git commit -m "11"', cfg('advise'), cache, exec);
    expect(eleventh).not.toBeNull();
    expect(eleventh?.level).toBe('advise');
    expect(eleventh?.message).toContain('Branch discipline');
    expect(eleventh?.message).toContain('master');
    expect(eleventh?.message).toContain('rules.workflow.branch_discipline');

    // The re-advisory must not double-mark / double-count: the cycle restarts
    // cleanly, so calls 12-20 are suppressed and call 21 re-advises again.
    for (let call = 12; call <= 20; call++) {
      expect(
        checkBranchDisciplineCommand(`git commit -m "${call}"`, cfg('advise'), cache, silentExec),
      ).toBeNull();
    }
    const twentyFirst = checkBranchDisciplineCommand('git commit -m "21"', cfg('advise'), cache, exec);
    expect(twentyFirst).not.toBeNull();
    expect(twentyFirst?.level).toBe('advise');
  });

  it('consumes the re-advisory slot silently when the 11th call is on a non-protected branch', () => {
    const exec = makeExec({
      'git branch --show-current': 'master',
      'git status --porcelain': '',
    });
    // Call 1 advises on master; calls 2-10 are suppressed without a git probe.
    expect(checkBranchDisciplineCommand('git commit -m "1"', cfg('advise'), cache, exec)).not.toBeNull();
    const silentExec = makeExec({});
    for (let call = 2; call <= 10; call++) {
      expect(
        checkBranchDisciplineCommand(`git commit -m "${call}"`, cfg('advise'), cache, silentExec),
      ).toBeNull();
    }

    // Call 11 lands on a feature branch: the re-advisory slot is consumed by
    // the shouldAdvise call, but the branch probe finds nothing to advise on.
    const featureExec = makeExec({ 'git branch --show-current': 'feat/x' });
    expect(
      checkBranchDisciplineCommand('git commit -m "11"', cfg('advise'), cache, featureExec),
    ).toBeNull();

    // The next protected-branch call starts a fresh suppression cycle: it is
    // suppressed (null), not advised — the consumed slot is gone.
    expect(
      checkBranchDisciplineCommand('git commit -m "12"', cfg('advise'), cache, silentExec),
    ).toBeNull();
  });

  it('advise message names both committing and pushing', () => {
    const exec = makeExec({
      'git branch --show-current': 'master',
      'git status --porcelain': '',
    });
    const result = checkBranchDisciplineCommand('git push', cfg('advise'), cache, exec);
    expect(result?.message).toContain('committing or pushing on master');
  });

  it('block message names both commits and pushes', () => {
    const exec = makeExec({ 'git branch --show-current': 'master' });
    const result = checkBranchDisciplineCommand('git push', cfg('block'), cache, exec);
    expect(result?.message).toContain('direct master commits/pushes are blocked');
  });

  it('catches git commit behind a -c key=value global option', () => {
    const exec = makeExec({
      'git branch --show-current': 'master',
      'git status --porcelain': '',
    });
    const result = checkBranchDisciplineCommand('git -c user.email=x commit -m "x"', cfg('advise'), cache, exec);
    expect(result).not.toBeNull();
    expect(result?.level).toBe('advise');
    expect(result?.message).toContain('master');
  });

  it('catches git push behind a -C <path> global option', () => {
    const exec = makeExec({ 'git branch --show-current': 'main' });
    const result = checkBranchDisciplineCommand('git -C /path push', cfg('block'), cache, exec);
    expect(result).not.toBeNull();
    expect(result?.level).toBe('block');
  });

  it('catches git commit behind a --no-pager global option', () => {
    const exec = makeExec({
      'git branch --show-current': 'master',
      'git status --porcelain': '',
    });
    const result = checkBranchDisciplineCommand('git --no-pager commit -m "x"', cfg('advise'), cache, exec);
    expect(result).not.toBeNull();
    expect(result?.level).toBe('advise');
  });

  it('catches git commit behind multiple global options', () => {
    const exec = makeExec({
      'git branch --show-current': 'master',
      'git status --porcelain': '',
    });
    const result = checkBranchDisciplineCommand(
      'git -c user.email=x -c user.name=y commit -m "x"',
      cfg('advise'),
      cache,
      exec,
    );
    expect(result).not.toBeNull();
  });

  it('does not match git commitfoo (word boundary)', () => {
    const calls: string[] = [];
    const exec = makeExec({ 'git branch --show-current': 'master' }, calls);
    const result = checkBranchDisciplineCommand('git commitfoo', cfg('advise'), cache, exec);
    expect(result).toBeNull();
    expect(calls).toEqual([]); // pattern gate rejects before branch resolution
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

  it('branch-discipline block wins for a compound command during tdd+ phase', () => {
    // Regression guard for check ordering: a pre-rewrite advisory (test
    // scope) must never preempt a pre-rewrite block (branch discipline).
    config = cfg('block');
    cache.setPhase('tdd+');
    cache.addEditedFile('src/router/resolver.ts', 'source');
    const exec = makeExec({ 'git branch --show-current': 'master' });
    const result = handlePreToolUse(
      'Bash',
      { command: 'npm test && git commit -m "x"' },
      cache,
      config,
      undefined,
      { branchExec: exec },
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('[BLOCK]');
    expect(result).toContain('Branch discipline');
  });

  it('test-scope block wins over a branch-discipline advisory on the same command', () => {
    config = cfg('advise');
    config.rules.test_scope = { enforcement: 'block', allowed_unscoped: [] };
    cache.setPhase('tdd+');
    cache.addEditedFile('src/router/resolver.ts', 'source');
    const exec = makeExec({
      'git branch --show-current': 'master',
      'git status --porcelain': '',
    });
    const result = handlePreToolUse(
      'Bash',
      { command: 'npm test' },
      cache,
      config,
      undefined,
      { branchExec: exec },
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('[BLOCK]');
    expect(result).toContain('TEST SCOPE');
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

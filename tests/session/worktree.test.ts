import { describe, it, expect } from 'vitest';
import { checkWorktreeSuggestion, checkBranchDiscipline } from '../../src/session/worktree.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

function makeExec(results: Record<string, string | Error>) {
  return (cmd: string): string => {
    const result = results[cmd];
    if (result instanceof Error) throw result;
    return result;
  };
}

function cfg(level: string, strategy = 'auto', branches = ['master', 'main']) {
  const c = structuredClone(DEFAULT_CONFIG);
  c.rules.workflow = { branch_discipline: level as never, protected_branches: branches, isolation_strategy: strategy as never };
  return c;
}

describe('checkWorktreeSuggestion', () => {
  it('returns branch-discipline hint when on master with a dirty tree (worktree wording)', () => {
    const exec = makeExec({ 'git branch --show-current': 'master', 'git status --porcelain': ' M src/a.ts\n' });
    const result = checkWorktreeSuggestion('/some/project', exec);
    expect(result).toContain('master');
    expect(result).toContain('using-git-worktrees');
  });

  it('returns branch-discipline hint when on main with a dirty tree (worktree wording)', () => {
    const exec = makeExec({ 'git branch --show-current': 'main', 'git status --porcelain': ' M src/a.ts\n' });
    const result = checkWorktreeSuggestion('/some/project', exec);
    expect(result).toContain('main');
    expect(result).toContain('using-git-worktrees');
  });

  it('returns empty string for feature branch', () => {
    const exec = makeExec({ 'git branch --show-current': 'feat/my-feature' });
    const result = checkWorktreeSuggestion('/some/project', exec);
    expect(result).toBe('');
  });

  it('returns empty string when not a git repo', () => {
    const exec = makeExec({ 'git branch --show-current': new Error('not a git repo') });
    const result = checkWorktreeSuggestion('/some/project', exec);
    expect(result).toBe('');
  });
});

describe('checkBranchDiscipline', () => {
  it('silent level suppresses the hint entirely', () => {
    const exec = makeExec({ 'git branch --show-current': 'master', 'git status --porcelain': '' });
    expect(checkBranchDiscipline('/p', exec, cfg('silent'))).toBe('');
  });

  it('advise on protected branch with clean tree recommends a feature branch', () => {
    const exec = makeExec({ 'git branch --show-current': 'master', 'git status --porcelain': '' });
    const out = checkBranchDiscipline('/p', exec, cfg('advise'));
    expect(out).toContain('master');
    expect(out).toContain('branch discipline');
    expect(out).toContain('feature branch');
    expect(out).toContain('PR');
  });

  it('auto strategy recommends worktree when tree is dirty', () => {
    const exec = makeExec({ 'git branch --show-current': 'main', 'git status --porcelain': ' M src/a.ts\n' });
    const out = checkBranchDiscipline('/p', exec, cfg('advise'));
    expect(out).toContain('using-git-worktrees');
  });

  it('worktree strategy always recommends worktree', () => {
    const exec = makeExec({ 'git branch --show-current': 'master', 'git status --porcelain': '' });
    expect(checkBranchDiscipline('/p', exec, cfg('advise', 'worktree'))).toContain('using-git-worktrees');
  });

  it('respects custom protected_branches', () => {
    const exec = makeExec({ 'git branch --show-current': 'develop', 'git status --porcelain': '' });
    expect(checkBranchDiscipline('/p', exec, cfg('advise', 'auto', ['develop']))).toContain('develop');
  });

  it('returns empty on feature branch and outside git repos', () => {
    const exec = makeExec({ 'git branch --show-current': 'feat/x', 'git status --porcelain': '' });
    expect(checkBranchDiscipline('/p', exec, cfg('advise'))).toBe('');
    const noGit = makeExec({ 'git branch --show-current': new Error('not a repo') });
    expect(checkBranchDiscipline('/p', noGit, cfg('advise'))).toBe('');
  });
});

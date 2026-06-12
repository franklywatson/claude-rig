import type { HarnessConfig } from '../types.js';
import { DEFAULT_CONFIG } from '../config.js';

export type ExecFn = (cmd: string) => string;

export function checkBranchDiscipline(cwd: string, exec: ExecFn, config: HarnessConfig): string {
  const wf = config.rules.workflow ?? DEFAULT_CONFIG.rules.workflow!;
  const level = wf.branch_discipline ?? 'advise';
  if (level === 'silent') return '';
  const protectedBranches = wf.protected_branches ?? ['master', 'main'];
  try {
    const branch = exec('git branch --show-current').trim();
    if (!protectedBranches.includes(branch)) return '';
    const strategy = resolveIsolationStrategy(wf.isolation_strategy ?? 'auto', exec);
    const isolation = strategy === 'worktree'
      ? 'a worktree (/using-git-worktrees) — keeps in-flight work untangled'
      : 'a feature branch';
    return `[rig] On ${branch} — branch discipline active (${level}): start feature work on ${isolation}, finish with a PR.`;
  } catch {
    return ''; // Not a git repo or git not available
  }
}

function resolveIsolationStrategy(strategy: 'auto' | 'branch' | 'worktree', exec: ExecFn): 'branch' | 'worktree' {
  if (strategy !== 'auto') return strategy;
  try {
    return exec('git status --porcelain').trim() ? 'worktree' : 'branch';
  } catch {
    return 'branch';
  }
}

/** @deprecated use checkBranchDiscipline — kept for compatibility */
export function checkWorktreeSuggestion(cwd: string, exec: ExecFn): string {
  return checkBranchDiscipline(cwd, exec, DEFAULT_CONFIG);
}

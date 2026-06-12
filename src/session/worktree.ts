import type { HarnessConfig, WorkflowRules } from '../types.js';
import { DEFAULT_CONFIG } from '../config.js';

/** Injectable exec for branch-discipline git probes (shared by the session-start hint and the tool router's commit-time check). */
export type ExecFn = (cmd: string) => string;

/**
 * Canonical workflow defaults. DEFAULT_CONFIG remains the single source for
 * the protected-branch list, enforcement level, and isolation strategy —
 * consumers read from here instead of re-declaring the literals.
 */
export const WORKFLOW_DEFAULTS = DEFAULT_CONFIG.rules.workflow as Required<WorkflowRules>;

/**
 * Resolve the recommended isolation strategy. `worktree` and `branch` force
 * the answer; `auto` recommends a worktree when the working tree is dirty
 * (keeps in-flight work untangled), a plain feature branch otherwise. Any
 * git failure falls back to `branch`.
 */
export function resolveIsolationStrategy(strategy: 'auto' | 'branch' | 'worktree', exec: ExecFn): 'branch' | 'worktree' {
  if (strategy !== 'auto') return strategy;
  try {
    return exec('git status --porcelain').trim() ? 'worktree' : 'branch';
  } catch {
    return 'branch';
  }
}

export function checkBranchDiscipline(exec: ExecFn, config: HarnessConfig): string {
  const wf = config.rules.workflow ?? WORKFLOW_DEFAULTS;
  const level = wf.branch_discipline ?? WORKFLOW_DEFAULTS.branch_discipline;
  if (level === 'silent') return '';
  const protectedBranches = wf.protected_branches ?? WORKFLOW_DEFAULTS.protected_branches;
  try {
    const branch = exec('git branch --show-current').trim();
    if (!protectedBranches.includes(branch)) return '';
    const strategy = resolveIsolationStrategy(wf.isolation_strategy ?? WORKFLOW_DEFAULTS.isolation_strategy, exec);
    const isolation = strategy === 'worktree'
      ? 'a worktree (/using-git-worktrees) — keeps in-flight work untangled'
      : 'a feature branch';
    return `[rig] On ${branch} — branch discipline active (${level}): start feature work on ${isolation}, finish with a PR.`;
  } catch {
    return ''; // Not a git repo or git not available
  }
}

/** @deprecated use checkBranchDiscipline — kept for compatibility */
export function checkWorktreeSuggestion(_cwd: string, exec: ExecFn): string {
  return checkBranchDiscipline(exec, DEFAULT_CONFIG);
}

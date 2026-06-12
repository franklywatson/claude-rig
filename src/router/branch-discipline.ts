import { splitCompoundSegments } from './intent.js';
import type { HarnessConfig } from '../types.js';
import type { SessionCache } from '../session/cache.js';

export type ExecFn = (cmd: string) => string;

const GIT_WRITE_PATTERN = /^\s*git\s+(commit|push)\b/;

export interface BranchDisciplineResult {
  level: 'advise' | 'block';
  message: string;
}

/**
 * Commit-time branch discipline check (PreToolUse). Scans every quote-aware
 * compound segment of a Bash command for `git commit` / `git push`, resolves
 * the live branch via the injectable ExecFn, and — when on a protected
 * branch — advises once per session (or blocks, per
 * `rules.workflow.branch_discipline`).
 */
export function checkBranchDisciplineCommand(
  command: string,
  config: HarnessConfig,
  cache: SessionCache,
  exec: ExecFn,
): BranchDisciplineResult | null {
  const wf = config.rules.workflow;
  const level = wf?.branch_discipline ?? 'advise';
  if (level === 'silent') return null;
  if (!splitCompoundSegments(command).some(s => GIT_WRITE_PATTERN.test(s.trim()))) return null;

  let branch: string;
  try {
    branch = exec('git branch --show-current').trim();
  } catch {
    return null; // Not a git repo or git not available
  }
  const protectedBranches = wf?.protected_branches ?? ['master', 'main'];
  if (!protectedBranches.includes(branch)) return null;

  if (level === 'advise') {
    if (cache.hasAdvised('branch_discipline')) return null;
    cache.markAdvised('branch_discipline');
    const strategy = resolveStrategy(wf?.isolation_strategy ?? 'auto', exec);
    const isolation = strategy === 'worktree'
      ? 'a worktree (/using-git-worktrees)'
      : 'a feature branch';
    return {
      level: 'advise',
      message:
        `[ADVISE] Branch discipline: committing on ${branch}. ` +
        `Consider ${isolation} and finishing with a PR. ` +
        `(rules.workflow.branch_discipline — set to silent to disable)`,
    };
  }

  return {
    level: 'block',
    message:
      `[BLOCK] Branch discipline: direct ${branch} commits are blocked by config. ` +
      `Create a feature branch (or worktree via /using-git-worktrees) and open a PR. ` +
      `(rules.workflow.branch_discipline: block — set to advise/silent to relax)`,
  };
}

function resolveStrategy(strategy: 'auto' | 'branch' | 'worktree', exec: ExecFn): 'branch' | 'worktree' {
  if (strategy !== 'auto') return strategy;
  try {
    return exec('git status --porcelain').trim() ? 'worktree' : 'branch';
  } catch {
    return 'branch';
  }
}

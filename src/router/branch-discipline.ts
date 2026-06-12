import { splitCompoundSegments } from './intent.js';
import type { HarnessConfig } from '../types.js';
import type { SessionCache } from '../session/cache.js';
import { resolveIsolationStrategy, WORKFLOW_DEFAULTS, type ExecFn } from '../session/worktree.js';

// Tolerates git global options before the subcommand (`git -c user.email=x
// commit`, `git -C /path push`, `git --no-pager commit`): each option is a
// flag token optionally followed by an `=value` or a separate value argument.
const GIT_WRITE_PATTERN = /^\s*git\s+(?:-[-\w]+(?:[= ]\S+)?\s+)*(commit|push)\b/;

export interface BranchDisciplineResult {
  level: 'advise' | 'block';
  message: string;
}

/**
 * Commit-time branch discipline check (PreToolUse). Scans every quote-aware
 * compound segment of a Bash command for `git commit` / `git push`, resolves
 * the live branch via the injectable ExecFn, and — when on a protected
 * branch — advises on the first occurrence and every
 * ADVISORY_READVISE_PERIOD-th (10th) suppressed occurrence thereafter (or
 * blocks, per `rules.workflow.branch_discipline`).
 */
export function checkBranchDisciplineCommand(
  command: string,
  config: HarnessConfig,
  cache: SessionCache,
  exec: ExecFn,
): BranchDisciplineResult | null {
  const wf = config.rules.workflow;
  const level = wf?.branch_discipline ?? WORKFLOW_DEFAULTS.branch_discipline;
  if (level === 'silent') return null;
  if (!splitCompoundSegments(command).some(s => GIT_WRITE_PATTERN.test(s.trim()))) return null;

  // A consumed advisory must cost zero subprocesses, so the suppression
  // check runs before any git probe. shouldAdvise counts each suppressed
  // occurrence and re-advises on every ADVISORY_READVISE_PERIOD-th, so an
  // ignored advisory resurfaces instead of disappearing for the session.
  // Because it runs pre-probe, git writes on NON-protected branches also
  // advance — and can consume — the cycle: a re-advisory slot that lands on
  // a feature-branch call is spent silently (the probe finds nothing to
  // advise on) and the cycle restarts. Acceptable drift — the alternative
  // is a git subprocess on every suppressed call. The hasAdvised guard
  // keeps the counter untouched until the first advisory has actually fired
  // (which requires the git probe below to confirm a protected branch).
  if (
    level === 'advise' &&
    cache.hasAdvised('branch_discipline') &&
    !cache.shouldAdvise('branch_discipline')
  ) {
    return null;
  }

  let branch: string;
  try {
    branch = exec('git branch --show-current').trim();
  } catch {
    return null; // Not a git repo or git not available
  }
  const protectedBranches = wf?.protected_branches ?? WORKFLOW_DEFAULTS.protected_branches;
  if (!protectedBranches.includes(branch)) return null;

  if (level === 'advise') {
    // First advisory for the session: start the suppression cycle. On a
    // periodic re-advisory the intent is already marked and the counter was
    // reset by the shouldAdvise call above.
    if (!cache.hasAdvised('branch_discipline')) cache.markAdvised('branch_discipline');
    const strategy = resolveIsolationStrategy(wf?.isolation_strategy ?? WORKFLOW_DEFAULTS.isolation_strategy, exec);
    const isolation = strategy === 'worktree'
      ? 'a worktree (/using-git-worktrees)'
      : 'a feature branch';
    return {
      level: 'advise',
      message:
        `[ADVISE] Branch discipline: committing or pushing on ${branch}. ` +
        `Consider ${isolation} and finishing with a PR. ` +
        `(rules.workflow.branch_discipline — set to silent to disable)`,
    };
  }

  return {
    level: 'block',
    message:
      `[BLOCK] Branch discipline: direct ${branch} commits/pushes are blocked by config. ` +
      `Create a feature branch (or worktree via /using-git-worktrees) and open a PR. ` +
      `(rules.workflow.branch_discipline: block — set to advise/silent to relax)`,
  };
}

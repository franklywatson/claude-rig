# Branch/PR Discipline with Isolation Strategy — Design

**Date:** 2026-06-12
**Status:** Approved
**Depends on:** the enforcement-visibility fix (advise output via
`hookSpecificOutput.additionalContext`) — this feature's advisories ride that
channel and touch the same hook templates, so it lands after that PR merges.

## 1. Problem statement

Nothing in rig steers the agent toward working in branches and finishing with
PRs. The only related mechanism is `checkWorktreeSuggestion`
(`src/session/worktree.ts`), an unconditional one-shot session-start hint with
no config gate, no PR guidance, no commit-time presence, and no strategy
awareness. Users who want branch discipline as their default have no lever;
users who don't want the existing hint have no off switch.

The discipline must never be forced: configurable, advisory by default,
blocking only by explicit choice.

## 2. Decision log (design Q&A, 2026-06-12)

1. **Full lever set** — one rule with three levels covering session start,
   commit time, and skill-chain propagation.
2. **Default `advise`** — preserves today's unconditional hint behavior while
   adding `silent` as the new escape hatch and `block` for strict teams.
3. **Worktree selection rolled in as a strategy** — the nudge recommends
   *how* to isolate (plain branch vs `/using-git-worktrees`), with an `auto`
   mode that picks per situation from cheap signals.
4. **Docs are in scope** — worktree usage and the advisory mechanics must be
   documented across README, getting-started, and architecture.

## 3. Configuration

```yaml
rules:
  workflow:
    branch_discipline: advise      # silent | advise | block
    protected_branches: [master, main]
    isolation_strategy: auto       # auto | branch | worktree
```

- `branch_discipline` controls **whether** rig nudges (and whether commit-time
  enforcement blocks). Default `advise`.
- `protected_branches` — branches the discipline applies to. Default
  `[master, main]` (matches the current `MAIN_BRANCHES` set).
- `isolation_strategy` controls **what** the nudge recommends:
  - `branch` — always a plain feature branch
  - `worktree` — always `/using-git-worktrees`
  - `auto` (default) — worktree when the working tree is dirty
    (`git status --porcelain` non-empty at advisory time) or when the context
    is plan execution (`tdd+`/`sdd+` preflight); plain branch otherwise
- Absent `workflow` key → defaults apply; existing `.harness.yaml` files need
  no migration. `HarnessConfig` and `DEFAULT_CONFIG` extended accordingly.

## 4. Seam 1 — session start

`checkWorktreeSuggestion` evolves into `checkBranchDiscipline(cwd, exec,
config)` in `src/session/worktree.ts` (file may rename to
`branch-discipline.ts`; keep a re-export if anything else imports it):

- Level `silent` → no output (new capability).
- On a protected branch, level `advise`/`block` → emit a hint naming the level,
  the resolved isolation strategy, and the PR expectation, e.g.:

  > `[rig] On master — branch discipline active (advise): start feature work
  > on a feature branch, finish with a PR. Working tree has uncommitted
  > changes — /using-git-worktrees recommended so in-flight work stays
  > untangled.`

- Strategy resolution for `auto` at emission time: dirty tree → worktree;
  clean → branch. The emission is part of the "active enforcement rules"
  block, so every plus-skill inherits awareness for free.

## 5. Seam 2 — commit time (PreToolUse)

New Bash intent detection for `git commit` and `git push`:

- Scanned across **all** quote-aware compound segments via
  `splitCompoundSegments` — `cd x && git commit ...` is detected (lesson from
  the v0.5.0 TR3 finding applied from day one).
- On match, the hook resolves the current branch live
  (`git branch --show-current` via the injectable `ExecFn`) — executed only
  when the command is actually a commit/push, never cached (branches change
  mid-session).
- Current branch protected:
  - `advise` → once-per-session agent-visible advisory (via
    `hasAdvised('branch_discipline')` and the `additionalContext` channel):
    names the branch, the recommended strategy with its reason, and the config
    key.
  - `block` → exit 2 with the reason and the pointer to
    `rules.workflow.branch_discipline` to relax it.
- Pushing a feature branch is never flagged — only operations while *on* a
  protected branch. Explicit refspec pushes (`git push origin HEAD:master`)
  are out of scope for v1 and noted as future hardening.
- Strategy only shapes advisory text; `block` blocks regardless of strategy.

## 6. Seam 3 — skill chain

- The session-start emission propagates the rule generically (templates
  already load active enforcement rules).
- `tdd+` and `sdd+` Phase A gain a preflight line: "If branch discipline is
  active and you're on a protected branch, create an isolated workspace before
  implementing — a worktree (`superpowers:using-git-worktrees`) when the plan
  is multi-task or the working tree is dirty, a plain feature branch
  otherwise."
- `review+`'s completion pointer prefers "finish with a PR (`gh pr create`)
  via `superpowers:finishing-a-development-branch`" over local merge when the
  rule is active.

## 7. What this feature never does

No auto-created branches or worktrees, no auto-opened PRs, no blocking at the
default level. `block` is the only enforcing level and exists solely by
explicit user configuration.

## 8. Documentation (in scope, required)

- **README**: Configuration section gains the `workflow` block with level and
  strategy semantics; the skill-chain/feature prose mentions branch discipline
  and worktree strategy in one paragraph.
- **docs/getting-started.md**: "Configure enforcement" section documents the
  three levels, `protected_branches`, `isolation_strategy` semantics (with the
  `auto` signals), and shows the default config block.
- **docs/architecture.md**: session layer documents `checkBranchDiscipline`
  (replacing the current worktree-hint description); tool router intent table
  gains the git commit/push row with its advise/block resolution; the
  advisory-mechanics paragraph explains once-per-session suppression and the
  agent-visible channel.
- **docs/skill-wrapping.md**: the superpowers-vs-rig table row for
  `using-git-worktrees` (generic isolation discipline → config-gated,
  strategy-aware advisory integration).

## 9. Testing

- Unit (injectable `ExecFn`, no mocks, per repo convention):
  - config: defaults, absent-key behavior, level/strategy parsing
  - `checkBranchDiscipline`: level × branch × strategy × dirty/clean matrix
  - intent: `git commit`/`git push` detection incl. compound segments and
    quoted-string negatives
  - resolver/hook: advise once-per-session suppression; block path; feature
    branches never flagged
- Template-content tests: tdd+/sdd+ preflight line; review+ PR pointer.
- E2E hook tests mirroring the existing tests/hooks patterns for both the
  advisory JSON emission and the block exit code.
- Docs lint (`npm run lint:md`) and the docs CI gates cover §8.

## 10. Acceptance criteria

1. Default config emits the same spirit of session-start hint as today, now
   level-aware and strategy-aware; `silent` suppresses it entirely.
2. With `advise`, a `git commit` on master produces exactly one agent-visible
   advisory per session; with `block`, the commit is rejected with remediation
   text; feature-branch commits are never touched.
3. `auto` strategy demonstrably recommends worktree on a dirty tree and branch
   on a clean one (unit-tested via ExecFn).
4. tdd+/sdd+/review+ templates carry the preflight and PR-pointer prose
   (template-content tests).
5. All docs in §8 updated; full suite, coverage gate, lint, and docs CI green.

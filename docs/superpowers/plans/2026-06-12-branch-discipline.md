# Branch/PR Discipline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configurable branch/PR discipline — session-start nudge with worktree-vs-branch strategy, once-per-session commit-time advisory (or block), and skill-chain propagation. Spec: `docs/superpowers/specs/2026-06-12-branch-discipline-design.md`.

**Architecture:** New `rules.workflow` config section; `checkWorktreeSuggestion` evolves into config-aware `checkBranchDiscipline`; a new `src/router/branch-discipline.ts` module wires into `handlePreToolUse` (no IntentType changes); template prose + docs.

**Tech Stack:** TypeScript, vitest, injectable `ExecFn` (no mocks).

**Sequencing:** Execute AFTER the enforcement-visibility PR merges (shared hook seam + advisory channel). Task 0 rebases.

## Constitutional Rules for This Plan

Active enforcement: `evidence_only: block`, `zero_defect.unrelated_errors: block`, `no_mocks: advise`, `conditional_assert: block`, `empty_test: block`, `stale_tests: advise`.

- Show command output before claiming any step done
- Every source change ships with test changes in the same task

## Mock Policy

Stack/E2E (real deps): none — CLI middleware; tests use injectable `ExecFn` and temp dirs per repo convention. Unit tests: no mocking frameworks needed.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/types.ts` | Modify | `WorkflowRules` interface; `HarnessConfig.rules.workflow` |
| `src/config.ts` | Modify | `DEFAULT_CONFIG.rules.workflow`; `mergeConfigs` workflow spread |
| `src/session/worktree.ts` | Modify | `checkBranchDiscipline(cwd, exec, config)` (keep `checkWorktreeSuggestion` as thin deprecated wrapper) |
| `src/session/start.ts` | Modify | Call site passes `config` |
| `src/router/branch-discipline.ts` | Create | Commit-time check: detect git commit/push across compound segments, resolve branch+strategy, advise/block |
| `src/router/hook.ts` | Modify | Wire check into `handlePreToolUse` |
| `templates/skills/tdd-plus/SKILL.md`, `templates/skills/sdd-plus/SKILL.md` | Modify | Preflight isolation line |
| `templates/skills/review-plus/SKILL.md` | Modify | PR-preference completion pointer |
| `tests/session/worktree.test.ts`, `tests/config/*.test.ts`, `tests/router/branch-discipline.test.ts` (new), `tests/hooks/*`, `tests/cli/template-content.test.ts` | Tests | Per-task below |
| README.md, docs/getting-started.md, docs/architecture.md, docs/skill-wrapping.md | Modify | Spec §8 |

---

### Task 0: Rebase onto post-visibility master

**Files:** none

- [ ] Step 1: Confirm the enforcement-visibility PR is merged: `gh pr list --state merged --limit 3`
- [ ] Step 2: `git checkout feat/branch-discipline && git rebase master`
- [ ] Step 3: `npm test` — all pass. Identify the advisory-emission helper that PR introduced (read `templates/hooks/pre-tool-use.ts` and `src/router/hook.ts` for how advise-level output is emitted agent-visibly) — Task 3 reuses it.

### Task 1: Config — `rules.workflow`

**Files:**
- Modify: `src/types.ts` (after `ZeroDefectRules`, ~line 207), `src/config.ts` (DEFAULT_CONFIG ~line 47, mergeConfigs ~line 77)
- Test: `tests/config/config.test.ts` (or the existing config test file — locate with `ls tests/config* tests/*config*`)

- [ ] **Step 1: Write failing tests**

```typescript
  it('defaults workflow rules: advise, master/main, auto strategy', async () => {
    const config = await loadConfig('/nonexistent/.harness.yaml');
    expect(config.rules.workflow?.branch_discipline).toBe('advise');
    expect(config.rules.workflow?.protected_branches).toEqual(['master', 'main']);
    expect(config.rules.workflow?.isolation_strategy).toBe('auto');
  });

  it('merges partial workflow overrides onto defaults', () => {
    const merged = mergeConfigs(structuredClone(DEFAULT_CONFIG), {
      rules: { workflow: { branch_discipline: 'block' } },
    } as HarnessConfig);
    expect(merged.rules.workflow?.branch_discipline).toBe('block');
    expect(merged.rules.workflow?.protected_branches).toEqual(['master', 'main']);
  });
```

- [ ] **Step 2:** `npx vitest run tests/config*` → FAIL (workflow undefined / type error)
- [ ] **Step 3: Implement.** `src/types.ts`:

```typescript
export interface WorkflowRules {
  branch_discipline?: EnforcementLevel;
  protected_branches?: string[];
  isolation_strategy?: 'auto' | 'branch' | 'worktree';
}
```

Add `workflow?: WorkflowRules;` to `HarnessConfig.rules`. `src/config.ts` DEFAULT_CONFIG gains:

```typescript
    workflow: {
      branch_discipline: 'advise',
      protected_branches: ['master', 'main'],
      isolation_strategy: 'auto',
    },
```

`mergeConfigs` gains (note: array override replaces, consistent with object-spread semantics):

```typescript
      workflow: { ...(base.rules.workflow ?? {}), ...override.rules.workflow } as WorkflowRules,
```

- [ ] **Step 4:** tests pass; `npm run lint` clean
- [ ] **Step 5:** `git add src/types.ts src/config.ts tests/ && git commit -m "feat: workflow.branch_discipline config rules"`

### Task 2: Session-start — `checkBranchDiscipline`

**Files:**
- Modify: `src/session/worktree.ts`, `src/session/start.ts:206`
- Test: `tests/session/worktree.test.ts`

- [ ] **Step 1: Write failing tests** (extend existing file; `makeExec` helper exists). Matrix:

```typescript
import { checkBranchDiscipline } from '../../src/session/worktree.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

function cfg(level: string, strategy = 'auto', branches = ['master', 'main']) {
  const c = structuredClone(DEFAULT_CONFIG);
  c.rules.workflow = { branch_discipline: level as never, protected_branches: branches, isolation_strategy: strategy as never };
  return c;
}

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
```

Keep existing `checkWorktreeSuggestion` tests passing (it becomes a wrapper calling `checkBranchDiscipline` with DEFAULT_CONFIG).

- [ ] **Step 2:** RED run
- [ ] **Step 3: Implement** in `src/session/worktree.ts`:

```typescript
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
```

Update `src/session/start.ts:206` to `checkBranchDiscipline(cwd, (cmd) => execSync(...), config)` (config is in scope — used at line 201). Adjust any existing worktree tests asserting old wording (they assert `toContain('master')` / `toContain('using-git-worktrees')` — the clean-tree default now says "feature branch"; update those expectations to the new contract, e.g. dirty-exec fixtures where worktree wording is asserted).

- [ ] **Step 4:** GREEN + `npx vitest run tests/session/` all pass
- [ ] **Step 5:** Commit `feat: config-aware branch discipline hint with isolation strategy`

### Task 3: Commit-time check (PreToolUse)

**Files:**
- Create: `src/router/branch-discipline.ts`
- Modify: `src/router/hook.ts` (wire into `handlePreToolUse`)
- Test: `tests/router/branch-discipline.test.ts` (new)

- [ ] **Step 1: Write failing tests** — new file, follow `tests/router/hook.test.ts` fixture style (SessionCache + config + ExecFn injection; read that file first):

Required cases:
1. `git commit -m "x"` on master, level advise → returns advisory result containing 'master', 'branch discipline', the strategy recommendation, and `rules.workflow.branch_discipline`; second call returns null (`hasAdvised('branch_discipline')`)
2. `cd /tmp && git commit -m "x"` on master → still detected (compound segment)
3. `git push` on main, level block → block result with remediation text
4. `git commit` on `feat/x` → null
5. `echo "git commit"` (quoted) → null
6. `git status` / `git diff` → null (only commit/push)
7. level silent → null
8. not a git repo (exec throws) → null

- [ ] **Step 2:** RED run
- [ ] **Step 3: Implement** `src/router/branch-discipline.ts`:

```typescript
import { splitCompoundSegments } from './intent.js';
import type { HarnessConfig } from '../types.js';
import type { SessionCache } from '../session/cache.js';

export type ExecFn = (cmd: string) => string;

const GIT_WRITE_PATTERN = /^\s*git\s+(commit|push)\b/;

export interface BranchDisciplineResult {
  level: 'advise' | 'block';
  message: string;
}

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
    return null;
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
```

(Adjust `markAdvised` to the actual SessionCache method name — check `src/session/cache.ts:138`.) Wire into `handlePreToolUse` in `src/router/hook.ts` for Bash commands, after the resolution-block step and before rtk rewrite; emit advise via the agent-visible channel the enforcement-visibility PR established, and block via the existing block path. Match the existing return-shape conventions in hook.ts.

- [ ] **Step 4:** GREEN; then e2e: extend `tests/hooks/` pre-tool-use test with one advisory case and one block case (set config in the temp fixture's `.harness.yaml`)
- [ ] **Step 5:** Commit `feat: commit-time branch discipline advisory/block in tool router`

### Task 4: Skill-chain prose

**Files:**
- Modify: `templates/skills/tdd-plus/SKILL.md`, `templates/skills/sdd-plus/SKILL.md` (Phase A), `templates/skills/review-plus/SKILL.md` (Skill Chain section)
- Test: `tests/cli/template-content.test.ts`

- [ ] **Step 1: Failing tests** in the loop-aware describe block:

```typescript
  it('tdd+ and sdd+ carry the branch-discipline preflight', () => {
    for (const skill of ['tdd-plus', 'sdd-plus']) {
      const content = read(`skills/${skill}/SKILL.md`);
      expect(content).toContain('branch discipline');
      expect(content).toContain('isolated workspace');
    }
  });

  it('review+ prefers a PR when branch discipline is active', () => {
    expect(read('skills/review-plus/SKILL.md')).toContain('gh pr create');
  });
```

- [ ] **Step 2:** RED
- [ ] **Step 3:** Add to tdd-plus and sdd-plus Phase A (numbered step, exact text):

```markdown
N. If branch discipline is active (see session-start output) and you are on a
   protected branch, create an isolated workspace before implementing — a
   worktree (`superpowers:using-git-worktrees`) when the plan is multi-task or
   the working tree is dirty, a plain feature branch otherwise.
```

Add to review-plus Skill Chain section:

```markdown
- If branch discipline is active, finish with a PR (`gh pr create` via
  `superpowers:finishing-a-development-branch`) rather than a local merge.
```

- [ ] **Step 4:** GREEN
- [ ] **Step 5:** Commit `feat: branch-discipline preflight and PR pointers in skill templates`

### Task 5: Documentation (spec §8)

**Files:** README.md, docs/getting-started.md, docs/architecture.md, docs/skill-wrapping.md

- [ ] Step 1: README Configuration yaml block gains the `workflow:` section (3 keys, comments for levels/strategies); one sentence in "What it does" Enforcement bullet: ", and configurable branch/PR discipline with worktree-aware isolation advice".
- [ ] Step 2: getting-started "Configure enforcement": add the workflow block to the sample yaml + a short paragraph explaining levels, `protected_branches`, and `auto` strategy signals (dirty tree → worktree; plan execution → worktree; else branch).
- [ ] Step 3: architecture.md: session-layer paragraph replaces the worktree-hint description with `checkBranchDiscipline` semantics; tool-router section documents the commit-time step (advise once per session via the agent-visible channel; block honors config); note compound-segment scanning.
- [ ] Step 4: skill-wrapping.md table gains: `| \`using-git-worktrees\` | Workspace isolation | Config-gated, strategy-aware advisory (\`rules.workflow\`): rig recommends worktree vs branch from tree state and plan context |`
- [ ] Step 5: `npm run lint:md` → 0 errors. Commit `docs: branch discipline configuration and advisory mechanics`

### Task 6: Full verification + PR

- [ ] Step 1: `npm test` (all pass, coverage gate holds), `npm run lint`, `npm run lint:md`, `npm run build`
- [ ] Step 2: Live smoke: `rig init` dogfood refresh; confirm session cache + hint behavior unchanged for default config
- [ ] Step 3: Push branch, `gh pr create` (title: "feat: configurable branch/PR discipline with isolation strategy"). Do not merge — report PR URL.

## Verification (overall → spec §10)

1. AC1 — Task 2 matrix (silent off-switch; level/strategy-aware hint)
2. AC2 — Task 3 cases 1/3/4 (+e2e)
3. AC3 — Task 2 dirty/clean tests
4. AC4 — Task 4 content tests
5. AC5 — Task 5 + Task 6 gates

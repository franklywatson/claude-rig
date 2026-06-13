# Teams-Aware sdd+ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Claude Code's experimental agent-teams feature is enabled, `sdd+` offers to execute independent plan tasks as parallel worktree-isolated implementer teammates with the lead reviewing and merging; everything degrades byte-for-byte to sequential dispatch when absent. Spec: `docs/superpowers/specs/2026-06-12-teams-aware-sdd-design.md`.

**Architecture:** One detection field (`Environment.agentTeamsAvailable` from the `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` env flag, injectable), one config key (`workflow.team_execution`), template prose in `plan-plus` (independence contract) and `sdd-plus` (preflight offer + team procedure), a mandatory empirical probe of hook coverage in worktrees, and the mandated docs pass + consistency sweep as the final tasks.

**Tech Stack:** TypeScript, vitest, injectable env record (extends the `ExecFn` testability convention).

**Sequencing:** Execute AFTER the hook-payload-drift fix (task #25) and the docs-archive PR merge. Task 0 rebases.

## Constitutional Rules for This Plan

Active enforcement: `evidence_only: block`, `zero_defect.unrelated_errors: block`, `no_mocks: advise`, `conditional_assert: block`, `empty_test: block`, `stale_tests: advise`, `branch_discipline (advise)`.

- Show command output before claiming any step done
- Every source change ships with test changes in the same task
- Work happens on `feat/teams-aware-sdd` (never a protected branch)

## Mock Policy

Stack/E2E (real deps): none involved — detection reads an injected env record; no Docker services. Unit tests: no mocking frameworks; env records and `ExecFn` fakes per repo convention.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/types.ts` | Modify | `Environment.agentTeamsAvailable`; `WorkflowRules.team_execution` |
| `src/session/environment.ts` | Modify | Read the flag via injectable env record |
| `src/session/start.ts` | Modify | Panel line when available |
| `src/config.ts` | Modify | `team_execution: 'offer'` default (merge spread already generic over workflow) |
| `templates/skills/plan-plus/SKILL.md` | Modify | Exhaustive-Files + `Depends on:` instructions |
| `templates/skills/sdd-plus/SKILL.md` | Modify | Preflight offer, Phase B-team procedure, degrade path |
| `docs/architecture.md` | Modify | Worktree hook-coverage probe answer (Task 1); teams graduation (Task 7) |
| `tests/session/environment.test.ts`, `tests/session/start.test.ts`, `tests/config.test.ts`, `tests/cli/template-content.test.ts` | Tests | Per-task below |
| README.md, docs/getting-started.md, docs/skill-wrapping.md | Modify | Task 7 docs pass |

---

### Task 0: Rebase onto post-#25 master

**Files:** none

- [ ] Step 1: Confirm task #25's PR and the docs-archive PR (#42) are merged: `gh pr list --state merged --limit 5`
- [ ] Step 2: `git checkout feat/teams-aware-sdd && git rebase origin/master` (resolve `.gitignore`/`.markdownlint-cli2.jsonc` overlaps by keeping both sides' additions)
- [ ] Step 3: `npm install && npm test` — all pass (baseline count noted for later tasks; expect ≥1249 plus #25's additions)

### Task 1: Worktree hook-coverage probe (spec §7 — mandatory first)

**Files:**
- Modify: `docs/architecture.md` (Subagent operations section — record the answer)
**Test strategy:** empirical probe, evidence in commit message + doc text; no unit tests (documentation task)
**Mock check:** none

- [ ] **Step 1: Probe A — hook firing for subagent tool calls in a worktree.** Create a worktree (`git worktree add /tmp/teams-probe -b probe/teams-hooks`), then from the MAIN session run a Bash command with cwd inside the worktree that the router must block: `cd /tmp/teams-probe && sed -i '' 's/a/b/' README.md` — record whether the `[BLOCK]` fires (expected: yes — hooks run in the session process regardless of command cwd; compound-segment scanning catches the cd-prefixed form).
- [ ] **Step 2: Probe B — config and session-cache resolution from a worktree cwd.** Pipe a real-shape payload into the installed PostToolUse hook with cwd set to the worktree (`cd /tmp/teams-probe && echo '<payload with session_id teams-probe, Edit on a .ts file>' | npx tsx /Users/jerome/tools/skills/claude-rig/.claude/hooks/scripts/post-tool-use.ts`); record (a) whether `.harness.yaml` resolves (worktrees lack the gitignored file — expected: falls back to DEFAULT_CONFIG), (b) which `/tmp/rig-session-*` cache file is written (expected: keyed by worktree cwd — a fragment invisible to `/savings` matching, as architecture.md already documents for subdirectory contexts).
- [ ] **Step 3: Record the findings** in `docs/architecture.md`'s "Subagent operations" section as a short "Hook coverage in worktrees" note: hooks fire for teammate tool calls (session-level), config inside worktrees falls back to defaults unless `.harness.yaml` is present, session-cache writes fragment per worktree cwd; teammates additionally carry enforcement in their typed system prompts. Adjust wording to match what the probes actually showed — if either expectation is contradicted, STOP and report NEEDS_CONTEXT with the evidence before proceeding to Task 6.
- [ ] **Step 4: Clean up** (`git worktree remove --force /tmp/teams-probe; git branch -D probe/teams-hooks`) and commit: `docs: record worktree hook-coverage probe results`

### Task 2: Detection — `agentTeamsAvailable`

**Files:**
- Modify: `src/types.ts` (Environment, after `headroomInitialized`), `src/session/environment.ts` (detectEnvironment)
- Test: `tests/session/environment.test.ts`

- [ ] **Step 1: Write failing tests** (follow the file's existing fixture style for detectEnvironment's injectable params):

```typescript
  it('detects agent teams from the experimental env flag', async () => {
    const env = await detectEnvironment('/p', failExec, () => false, () => undefined,
      failMcp, failRegistration, { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' });
    expect(env.agentTeamsAvailable).toBe(true);
  });

  it('reports agent teams unavailable when the flag is absent or not "1"', async () => {
    const base = [failExec, () => false, () => undefined, failMcp, failRegistration] as const;
    const none = await detectEnvironment('/p', ...base, {});
    expect(none.agentTeamsAvailable).toBe(false);
    const zero = await detectEnvironment('/p', ...base, { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0' });
    expect(zero.agentTeamsAvailable).toBe(false);
  });
```

(Adapt helper names — `failExec`/`failMcp`/`failRegistration` stand for the file's existing no-op fixtures; read the test file first and reuse its actual helpers. If positional defaults make a trailing param awkward, accept an options object — pick whichever matches the file's conventions and keep ALL existing call sites compiling.)

- [ ] **Step 2:** RED run (`npx vitest run tests/session/environment.test.ts`)
- [ ] **Step 3: Implement.** `src/types.ts`: add `agentTeamsAvailable?: boolean;` to `Environment`. `src/session/environment.ts`: add trailing param `envVars: Record<string, string | undefined> = process.env` to `detectEnvironment`, and include `agentTeamsAvailable: envVars.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === '1'` in the returned object.
- [ ] **Step 4:** GREEN + full `tests/session/` pass + `npm run lint`
- [ ] **Step 5:** Commit `feat: detect experimental agent-teams availability`

### Task 3: Panel emission

**Files:**
- Modify: `src/session/start.ts` (panel lines, adjacent to the headroom line ~156)
- Test: `tests/session/start.test.ts`

- [ ] **Step 1: Failing test** (follow start.test.ts's existing emission-assertion style): when the detected environment has `agentTeamsAvailable: true`, session-start output contains `agent-teams: available (experimental)`; when false/absent, it does not.
- [ ] **Step 2:** RED
- [ ] **Step 3:** In the panel-emission block of `handleSessionStart`, after the headroom line:

```typescript
  if (env.agentTeamsAvailable) {
    lines.push('  agent-teams: available (experimental)');
  }
```

- [ ] **Step 4:** GREEN + `npm run lint`
- [ ] **Step 5:** Commit `feat: session-start panel reports agent-teams availability`

### Task 4: Config — `workflow.team_execution`

**Files:**
- Modify: `src/types.ts` (WorkflowRules), `src/config.ts` (DEFAULT_CONFIG)
- Test: `tests/config.test.ts`

- [ ] **Step 1: Failing tests:**

```typescript
  it('defaults team_execution to offer', async () => {
    const config = await loadConfig('/nonexistent/.harness.yaml');
    expect(config.rules.workflow?.team_execution).toBe('offer');
  });

  it('merges team_execution override while keeping other workflow defaults', () => {
    const merged = mergeConfigs(structuredClone(DEFAULT_CONFIG), {
      rules: { workflow: { team_execution: 'never' } },
    } as HarnessConfig);
    expect(merged.rules.workflow?.team_execution).toBe('never');
    expect(merged.rules.workflow?.branch_discipline).toBe('advise');
  });
```

- [ ] **Step 2:** RED
- [ ] **Step 3:** `WorkflowRules` gains `team_execution?: 'offer' | 'auto' | 'never';`; `DEFAULT_CONFIG.rules.workflow` gains `team_execution: 'offer',`. (The workflow merge spread is already generic — no mergeConfigs change.)
- [ ] **Step 4:** GREEN + lint
- [ ] **Step 5:** Commit `feat: workflow.team_execution config (offer|auto|never)`

### Task 5: plan+ — independence contract

**Files:**
- Modify: `templates/skills/plan-plus/SKILL.md` (Phase B, after the existing task-pattern step)
- Test: `tests/cli/template-content.test.ts`

- [ ] **Step 1: Failing test** (in the loop-aware/typed-dispatch describe area):

```typescript
  it('plan-plus carries the parallelism/independence contract', () => {
    const content = read('skills/plan-plus/SKILL.md');
    expect(content).toContain('Depends on: Task');
    expect(content).toContain('exhaustive');
  });
```

- [ ] **Step 2:** RED
- [ ] **Step 3:** Add to Phase B (numbered to fit the existing list, after the task-pattern step):

```markdown
N. **Independence contract** (consumed by sdd+ team mode): every task's
   `**Files:**` list must be exhaustive — include shared test files a task
   extends (a tests file touched by several tasks makes them dependent).
   Where ordering matters even without file overlap, add an explicit
   `Depends on: Task N` line under the task header. A pair of tasks is
   parallelizable only when their Files lists are disjoint AND neither
   depends on the other.
```

- [ ] **Step 4:** GREEN
- [ ] **Step 5:** Commit `feat: plan+ independence contract for team execution`

### Task 6: sdd+ — preflight offer and team procedure

**Files:**
- Modify: `templates/skills/sdd-plus/SKILL.md`
- Test: `tests/cli/template-content.test.ts`

- [ ] **Step 1: Failing tests:**

```typescript
  it('sdd-plus offers team mode behind detection and config', () => {
    const content = read('skills/sdd-plus/SKILL.md');
    expect(content).toContain('agent-teams');
    expect(content).toContain('team_execution');
    expect(content).toContain('Team mode available');
    expect(content).toContain('at most 3');
    expect(content).toContain('sequential dispatch');
  });
```

- [ ] **Step 2:** RED
- [ ] **Step 3:** Two template additions. (a) New Phase A step after the signal-stack step:

```markdown
N. **Team-mode preflight.** If session-start reported `agent-teams: available
   (experimental)` AND `rules.workflow.team_execution` is not `never`:
   compute task independence from the plan's contract (disjoint `**Files:**`
   lists AND no `Depends on:` marker either way). If ≥2 tasks are pairwise
   independent: at `offer`, ask once — "Team mode available: tasks [N, M, …]
   are independent — run them as parallel teammates? Sequential otherwise." —
   and proceed per the answer; at `auto`, use team mode without asking. In
   every other case (flag absent, `never`, declined, no independent pairs),
   use the standard sequential dispatch below, unchanged.
```

(b) New section after Phase B, titled `### Phase B-team: Team execution (when team mode is on)`:

```markdown
1. Create a team named after the plan (e.g. `sdd-<plan-slug>`); the team's
   shared task list mirrors the plan: one entry per plan task, with
   `Depends on:` markers encoded as blocked-by edges so only unblocked tasks
   are claimable.
2. Spawn implementer teammates — at most 3, and never more than the number of
   currently-unblocked independent tasks. Each is the typed `implementer`
   agent, worktree-isolated, joined to the team with a distinct name. Each
   teammate's standing instructions: claim one unblocked task, execute it on
   its own branch (`<plan-branch>-task-N`) off the plan branch following the
   task's TDD steps exactly, push the branch, mark the task complete, then
   claim the next unblocked task or go idle.
3. **Lead loop (you):** on each task-completion notification, run the
   standard two-stage review from Phase B (spec-reviewer, then code-reviewer)
   against that task's branch. Route review findings back as new blocked
   tasks assigned to a fresh implementer dispatch. Merge each approved task
   branch into the plan branch in dependency order — one merge at a time,
   re-running the suite after each merge.
4. When all plan tasks are complete and merged: send each teammate a shutdown
   request, delete the team, and continue to Phase C as in sequential mode.
5. Turn budgets, worktree isolation, and enforcement apply to teammates
   exactly as to any typed implementer dispatch (see architecture.md
   "Subagent operations", including the worktree hook-coverage note).
```

- [ ] **Step 4:** GREEN + `npm run lint:md`
- [ ] **Step 5:** Commit `feat: sdd+ team-mode preflight and lead-reviews-merges procedure`

### Task 7: Documentation pass (mandated final docs task)

**Files:** README.md, docs/getting-started.md, docs/architecture.md, docs/skill-wrapping.md

- [ ] Step 1: README — cockpit "Plug-and-play detection" bullet gains agent-teams in the probe list; "Rig vs plain superpowers" Subagents cell appends ", team-mode execution of independent plan tasks when Claude Code's experimental agent-teams feature is detected".
- [ ] Step 2: getting-started — Configure-enforcement sample gains `team_execution: offer  # offer | auto | never (requires the experimental agent-teams flag)`; new short section "Team mode (experimental)" after the skill-chain section: what the offer looks like, the 3-teammate cap, lead-reviews-and-merges, and the degrade guarantee.
- [ ] Step 3: architecture.md — Layer 3 `sdd+` paragraph gains team mode (preflight, B-team, cap, lead loop); "Subagent operations" agent-teams paragraph rewritten from forward-looking ("Tracked as future work; not yet designed") to shipped, describing detection, the parallelism model end-to-end, and referencing the Task 1 hook-coverage note.
- [ ] Step 4: skill-wrapping.md — `subagent-driven-development` row's overlay cell appends ", team-mode parallel execution (experimental agent-teams)".
- [ ] Step 5: `npm run lint:md` → 0 errors. Commit `docs: teams-aware sdd+ and the parallelism model`

### Task 8: Docs-consistency sweep + full verification + PR

**Files:** none new (fixes from findings only)

- [ ] Step 1: Dispatch a typed code-reviewer for a docs-consistency sweep over the branch (the v0.6.0 pre-release pattern): counts, cross-doc claims, config samples vs DEFAULT_CONFIG, template/docs agreement on the team procedure, degrade-path claims vs code. Fix findings on the branch.
- [ ] Step 2: `npm test` (all pass), `npm run lint`, `npm run lint:md`, coverage gate holds.
- [ ] Step 3: Push branch; `gh pr create` titled "feat: teams-aware sdd+ — detect, offer, degrade". Do NOT merge — report PR URL for sign-off.

## Verification (overall → spec §11)

1. AC1 (flag unset = identical behavior) — Tasks 2/4 negative tests; degrade prose in Task 6
2. AC2 (detect, offer, auto/never) — Tasks 2/3/4/6
3. AC3 (plan+ contract) — Task 5
4. AC4 (probe answer recorded) — Task 1
5. AC5 (docs + sweep + gates) — Tasks 7/8

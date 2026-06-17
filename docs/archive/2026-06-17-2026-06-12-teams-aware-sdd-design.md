# Teams-Aware sdd+ — Design

> **Status:** Executed — design realized by the shipped teams-aware sdd+; archived 2026-06-17


**Date:** 2026-06-12
**Status:** Approved — plan written
(`docs/superpowers/plans/2026-06-12-teams-aware-sdd.md`); execution pending
the #25 merge.
**Task:** #23. Sequenced behind the hook-payload-drift fix (task #25) for merge
order only; no code dependency.

## 1. Problem statement

`sdd+` executes plan tasks strictly sequentially. That is correct within a
branch (shared files, merge chain) but leaves Claude Code's experimental
agent-teams capability unused when a plan contains genuinely independent
tasks. Per the cockpit pattern, rig should detect the capability, offer it,
and degrade gracefully — never force it.

The v0.6.0 parallelism rule ("one implementer per branch/worktree; orthogonal
work concurrent") is the manual version of this; teams make it first-class
with a shared task list and lead coordination instead of orchestrator
hand-juggling.

## 2. Decision log (design Q&A, 2026-06-12)

1. **Detect + offer, config-gated** — `workflow.team_execution: offer | auto
   | never` (default `offer`). sdd+ asks once per plan when the capability
   and fit are both present; `auto` skips the ask; `never` suppresses.
2. **plan+ declares, sdd+ verifies** — independence = disjoint `**Files:**`
   lists AND no explicit `Depends on: Task N` marker, both required. The plan
   stays the single contract.
3. **Teammates implement; lead reviews and merges (v1)** — only the implement
   stage parallelizes. The lead keeps today's two-stage typed review per
   completed task and merges per-task branches in dependency order.
   Reviewers-as-teammates deferred to v2.
4. **Docs mandate** — the implementation plan MUST end with a docs pass
   covering teams mode and the broader parallelism model, plus a pre-merge
   docs-consistency sweep (user requirement, recorded in task #23).

## 3. Detection

- `Environment.agentTeamsAvailable: boolean` — true when
  `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === '1'` in the process environment.
  Verified live: the flag is present in hook/session processes and persisted
  in `~/.claude/settings.json`'s `env` block when the feature is enabled.
- Detection reads an injectable env record (same testability convention as
  `ExecFn`), runs in `detectEnvironment()`, caches in `SessionCache`, and is
  emitted in the session-start panel: `agent-teams: available (experimental)`.
- Flag absent → `false` → the feature is invisible end-to-end.

## 4. Configuration

```yaml
rules:
  workflow:
    team_execution: offer      # offer | auto | never
```

Default `offer`. `WorkflowRules` type, `DEFAULT_CONFIG`, and `mergeConfigs`
extended; absent key → default applies (consistent with 0.6.0 workflow
semantics). README/getting-started config samples updated.

## 5. plan+ changes — independence in the contract

Two additions to the plan+ template (Phase B):

1. **Files lists are the disjointness input** — instruct that every task's
   `**Files:**` list must be exhaustive, including shared test files a task
   extends (the historical leak: multiple tasks appending to one
   template-content test file).
2. **Explicit dependency markers** — add `Depends on: Task N` to any task
   that must follow another even without file overlap.

A task pair is independent iff their Files lists are disjoint AND neither
carries a dependency marker on the other.

## 6. sdd+ changes — team mode

**Preflight (Phase A):** when `agentTeamsAvailable` AND `team_execution !=
never` AND the plan contains ≥2 pairwise-independent tasks: at `offer`, ask
once — "Team mode available: tasks N, M are independent — run as parallel
teammates? Sequential otherwise." At `auto`, proceed without asking. Any
other condition → sequential, unchanged.

**Phase B-team (new section in the template):**

1. Create a team named from the plan slug (team = shared task list, 1:1).
2. Mirror plan tasks into the task list; encode dependency markers as
   blocked-by edges so teammates can only claim unblocked tasks.
3. Spawn up to **3** implementer teammates (v1 cap) — typed `implementer`
   agent, worktree isolation, team name + teammate name. Each teammate's
   instructions: claim an unblocked task, work it on its own branch
   (`<plan-branch>-task-N`) off the plan branch, follow the task's TDD steps,
   push, mark the task complete, claim the next or idle.
4. **Lead loop (the sdd+ session):** on each completion notification, run the
   existing two-stage typed review (spec-reviewer → code-reviewer) on that
   task's branch; route fixes back as new tasks on the shared list; merge
   reviewed branches into the plan branch in dependency order.
5. On plan completion: send shutdown requests to teammates, delete the team,
   run Phase C wrap-up as today.

**Degrade path:** flag absent / `never` / declined / no independent pairs →
today's sequential dispatch, byte-for-byte identical behavior.

**Operational rules carried over:** per-teammate turn backstops; one
implementer per branch/worktree (holds by construction); enforcement reaches
teammates via hooks where they fire, and via the typed agents' system prompts
(`.harness.yaml` read at runtime) regardless.

## 7. Known risk — resolve as the plan's first task

**Hook coverage inside teammate worktrees.** Teammate worktrees live under
`.claude/worktrees/`; whether the project's PreToolUse/PostToolUse hooks fire
there depends on `CLAUDE_PROJECT_DIR` resolution in worktree sessions. The
implementation plan's first task is an empirical probe (spawn a worktree
agent, run a hook-triggering command, observe). If hooks do not fire in
worktrees, v1 documents the enforcement gap explicitly (architecture.md
subagent operations) and relies on the agents' system-prompt enforcement;
the gap becomes a tracked follow-up.

## 8. What v1 deliberately does not do

- No reviewers-as-teammates (v2 candidate after the lead-loop pattern proves
  out).
- No cross-plan / portfolio teams (orthogonal work items remain
  orchestrator-managed per the parallelism rule).
- No auto-merge: every merge goes through the lead after two-stage review.
- No teams without the env flag, ever — detection is the only entry.

## 9. Documentation (mandated, final plan task)

- README: cockpit detection list gains agent-teams; "Rig vs plain
  superpowers" Subagents cell gains team-mode mention.
- docs/getting-started.md: team_execution config + a short "team mode" usage
  section.
- docs/architecture.md: Layer 3 sdd+ section gains the team procedure; the
  "Subagent operations" agent-teams paragraph graduates from forward-looking
  to shipped, with the full parallelism model described.
- docs/skill-wrapping.md: subagent-driven-development row notes team mode.
- Followed by a pre-merge docs-consistency sweep (v0.6.0 pattern).

## 10. Testing

- Unit (injectable env record): detection true/false/missing; config
  defaults, merge, `never`/`auto`/`offer` resolution.
- Template-content: plan+ dependency-marker + exhaustive-Files instructions;
  sdd+ preflight offer prose, team procedure, v1 cap, degrade path.
- Independence computation: if implemented as code (vs prose), unit-test the
  disjointness+marker logic incl. the shared-test-file case; if prose-only in
  v1, the template-content tests carry it and the eval harness (task #26)
  owns behavioral verification.
- Behavioral (offer fires correctly, teammates coordinate, lead merges in
  order): explicitly deferred to dogfooding + the #26 eval harness — same
  honest split as the loop docs.

## 11. Acceptance criteria

1. With the env flag unset, every code path and template behaves identically
   to v0.6.x (deterministic tests prove the degrade path).
2. With the flag set, session start reports agent-teams availability; sdd+
   offers team mode only when the plan has ≥2 independent tasks and config
   is `offer`; `auto`/`never` behave as specified.
3. plan+ emits dependency markers and exhaustive-Files guidance
   (template-content tests).
4. The worktree hook-coverage probe (§7) has a recorded answer in
   architecture.md, whichever way it lands.
5. Docs per §9; full suite, coverage gate, lint, docs-consistency sweep green.

---
name: sdd+
description: "Invoke AFTER plan+ is approved, as an alternative to tdd+ for plans with independent tasks. Wraps superpowers:subagent-driven-development with typed agent dispatch: fresh implementer subagent per task, then spec-reviewer and code-reviewer subagents. Executes the whole plan without pausing between tasks."
argument-hint: "[plan file path]"
user-invocable: true
---

<!-- rig-generated -->

# sdd+ — Subagent-Driven Development

Wraps `superpowers:subagent-driven-development`. Requires superpowers to be
installed. Use `tdd+` instead when tasks are tightly coupled or the plan is
small — subagent execution costs more tokens and pays off on independent,
parallelizable tasks.

## Typed Dispatch Override

This project ships typed agent definitions in `.claude/agents/`. Where the
delegated superpowers skill instructs `Task tool with general-purpose type`,
instead dispatch the typed agent and pass only the per-task payload — the
role content lives in the agent definition:

- Implementation → `Agent(subagent_type="implementer", prompt=<full task text from plan + scene-setting context + working directory>)`
- Spec compliance review → `Agent(subagent_type="spec-reviewer", prompt=<task requirements + implementer's report>)`
- Code quality review → `Agent(subagent_type="code-reviewer", prompt=<DESCRIPTION + PLAN_OR_REQUIREMENTS + BASE_SHA + HEAD_SHA>)`

If a typed agent is unavailable (definition deleted), fall back to a general-purpose
subagent using the superpowers prompt template for that role.

## Procedure

### Phase A: Load Plan

1. Load the plan from `docs/plans/` or `docs/superpowers/plans/` (or the path
   given in arguments).
2. Load active enforcement rules from session context (see session-start
   output) — include them in every implementer dispatch prompt.
3. If the plan defines a signal stack, note each task's named gating signal:
   that signal is the task's completion gate, and the implementer dispatch
   prompt must say so.
4. If branch discipline is active (see session-start output) and you are on a
   protected branch, create an isolated workspace before implementing — a
   worktree (`superpowers:using-git-worktrees`) when the plan is multi-task or
   the working tree is dirty, a plain feature branch otherwise.

### Phase B: Execute (delegate to superpowers:subagent-driven-development)

1. Invoke `superpowers:subagent-driven-development` with the loaded plan.
2. Per task, apply the Typed Dispatch Override above:
   implementer → spec-reviewer → code-reviewer.
3. Spec gaps or quality issues route back to a fresh implementer dispatch
   with the reviewer's findings included in the payload.
4. Do not pause between tasks. Stop only for BLOCKED you cannot resolve,
   genuine ambiguity, or plan completion.
5. Parallelism: this plan's tasks run **sequentially** — they share a branch
   and usually files, so one implementer at a time per branch/worktree (the
   wrapped skill's no-parallel rule applies within the plan). Orthogonal work
   *outside* this plan (a different branch, disjoint files, no merge-order
   dependency) may proceed concurrently in its own worktree; reviewers are
   read-only and always safe to run in parallel.

### Phase C: Wrap Up

1. Confirm every plan task is committed and its checkboxes are complete.
2. Report per-task status (DONE / DONE_WITH_CONCERNS) with commit SHAs.

## Skill Chain

After completing sdd+, invoke `/verify+` for full-suite verification — the
phase tracker accepts the sdd+ path.

## Completion

- **DONE** — All plan tasks implemented, reviewed, and committed.
- **DONE_WITH_CONCERNS** — Plan complete; reviewer concerns noted for follow-up.
- **BLOCKED** — A task cannot proceed; details and attempted resolutions listed.
- **NEEDS_CONTEXT** — User input required to resolve ambiguity.

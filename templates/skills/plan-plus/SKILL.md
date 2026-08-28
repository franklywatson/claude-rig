---
name: plan+
description: "Invoke AFTER brain+ design is approved. Wraps superpowers:writing-plans with constitutional rules, testing strategy per task, and mock policy. Creates bite-sized implementation plans."
argument-hint: "[plan description]"
user-invocable: true
---

<!-- rig-generated -->

# plan+ — Disciplined Planning

Wraps `superpowers:writing-plans`. Requires superpowers to be installed.

## Before You Begin

This skill runs after `brain+` has produced a validated design. It creates the implementation plan with testing discipline baked into every task.

## Procedure

### Phase A: Load Context

1. Read the design output from `brain+` (from the current session or saved spec).

2. When you need to explore the codebase (verify file paths, check dependencies, find related modules), use the scout agent:

   ```
   Agent(subagent_type="scout", prompt="Map the codebase structure for [area]. Focus on: dependencies, test files, and related modules.")
   ```

3. Load active enforcement rules from session context (see session-start output). If active enforcement rules are configured, add a **Constitutional Compliance** section to the plan:

   ```
   ## Constitutional Rules for This Plan
   [List active enforcement rules from session-start output — these are configurable via .harness.yaml]
   - Use real [database/payment/logger] connections in stack/E2E tests — mocks are appropriate in unit tests
   - Show command output before claiming done
   - Every source file change requires corresponding test changes
   - Full-loop assertions: verify primary + second-order + third-order effects
   ```

4. Identify the mock policy for this plan based on active enforcement rules:

   ```
   ## Mock Policy
   Stack/E2E (real deps): [list from active enforcement rules]
   Unit tests (mocks ok): [all components] / External without sandbox: [third-party services]
   ```

### Phase B: Create Plan (delegate to superpowers:writing-plans)

1. Invoke `superpowers:writing-plans` with the enriched context.

2. For each task in the plan, ensure it includes:
   - **Test strategy**: which tests cover this task's requirements
   - **Mock check**: does this task need to interact with protected components (per active enforcement rules)?
   - **Evidence criteria**: what output proves this task is done

3. Every task must follow the pattern:

   ```
   ### Task N: [Name]
   **Files:** [exact paths]
   **Test strategy:** [which tests, scoped to this task]
   **Mock check:** [are protected components involved?]
   - [ ] Step 1: Write failing test
   - [ ] Step 2: Verify it fails
   - [ ] Step 3: Write minimal implementation
   - [ ] Step 4: Verify it passes
   - [ ] Step 5: Commit
   ```

4. **`Spec:` pointer.** The plan's header carries a `Spec:` line naming the
   design `brain+` produced — the document path plus a one-line scope summary:

   ```
   **Spec:** docs/designs/<slug>.md — <one line: what was approved and when>
   ```

   superpowers 6.3.0's subagent-driven-development reads this pointer at setup
   to resolve plan conflicts and ambiguities against the approved design
   instead of guessing ([#2086](https://github.com/obra/superpowers/issues/2086)),
   and `sdd+` hands it to the spec-reviewer as the compliance reference. If
   there is no design document (a spike, or `plan+` invoked directly on a small
   change), write `**Spec:** none — no design document; ask on conflict` rather
   than omitting the line, so the controller stops to ask instead of inferring.

5. **If the design includes a loop/signal-stack section** (see
   `references/agent-loops.md`): order the plan signal-stack-first — harness
   tasks (golden tests, contract probes, calibration harness, dry-run rig,
   telemetry store) come before or alongside the features they gate, because
   the assembly process uses the stack to verify itself as it builds. Then:
   - Each task names its **gating signal** (which layer's signal proves it done)
   - The maintainer deployment is a late task, after the primary system's
     acceptance criteria pass
   - Rollout gates (credentials, schedule enablement, live writes) are
     explicitly reserved to the user — never automated in any task

6. **Independence contract** (consumed by sdd+ team mode): every task's
   `**Files:**` list must be exhaustive — include shared test files a task
   extends (a tests file touched by several tasks makes them dependent).
   Where ordering matters even without file overlap, add an explicit
   `Depends on: Task N` line under the task header. A pair of tasks is
   parallelizable only when their Files lists are disjoint AND neither
   depends on the other.

### Phase C: Validate Plan

1. Confirm the plan:
   - [ ] Every task has a test strategy
   - [ ] No task mocks a protected component
   - [ ] Plan references exact file paths (no TBDs)
   - [ ] Evidence criteria defined for each task
   - [ ] `Spec:` pointer present (or explicitly `none`)
   - [ ] Active enforcement rules section present (if rules are configured)

## Output

Save the plan to `docs/plans/` and feed into `tdd+` for implementation.

## Skill Chain

After completing plan+, the next step is:

- Invoke `/tdd+` to implement the plan task-by-task with RED-GREEN-REFACTOR
- Or invoke `/sdd+` to execute the plan via typed subagents (implementer → spec-reviewer → code-reviewer) — best for plans with independent tasks

## Completion

Report one of these states when the skill finishes:

- **DONE** — Plan saved to `docs/plans/`, all validation checklist items in Phase C confirmed.
- **DONE_WITH_CONCERNS** — Plan complete but has open questions or tasks needing refinement.
- **BLOCKED** — Cannot proceed (missing design from brain+, unclear requirements).
- **NEEDS_CONTEXT** — Need user input to resolve a task scope or dependency question.

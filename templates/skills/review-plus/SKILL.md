---
name: review+
description: "Invoke AFTER verify+ passes. Wraps superpowers:requesting-code-review with constitutional compliance checklist, stale test validation, and reviewer agent invocation. Two-stage review: spec compliance + code quality."
argument-hint: "[plan file path]"
user-invocable: true
---

<!-- rig-generated -->

# review+ — Compliance Review

Wraps `superpowers:requesting-code-review`. Requires superpowers to be installed.

## Procedure

### Phase A: Gather Review Context

1. Load the plan from `docs/plans/`.

2. Get the list of files changed since the plan was created:

   ```
   git diff --name-only [plan-commit]..HEAD
   ```

3. Invoke the scout agent to get current codebase state for comparison:

   ```
   Agent(subagent_type="scout", prompt="Get current state of these files: [changed files list]. For each file, report: symbol count, key exports, test coverage status.")
   ```

### Phase B: Spec Compliance Review

1. Dispatch the typed spec reviewer with the per-task payload (role content
   lives in the agent definition):

   ```
   Agent(subagent_type="spec-reviewer", prompt="Task requirements: [full task text from the plan]. Implementer's report: [what was claimed/committed for this task]. Verify the implementation matches the spec — nothing more, nothing less.")
   ```

   If the typed agent is unavailable, fall back to a general-purpose subagent
   using the superpowers spec-reviewer prompt template.

2. The spec reviewer verifies, for each task in the plan:
   - Check: was the task implemented? (file exists, code present)
   - Check: does the implementation match the plan's specification?
   - Check: are the specified tests present and passing?
   - Check: were any plan tasks skipped or significantly changed?

3. Check stale test status:
   - For each changed source file, verify a corresponding test file was also changed
   - Flag any source edits without test updates as stale test violations

4. Check enforcement compliance (see active enforcement rules from session-start output):
   - [ ] Active enforcement rules followed in all test and source files (real dependencies in stack/E2E tests; mocks appropriate in unit tests)
   - [ ] All claims of success are backed by command output
   - [ ] Full-loop assertions present where applicable
   - [ ] No conditional test assertions (`if (condition) assert(...)`)
   - [ ] No empty test bodies
   - No `.skip` without documented reason

### Phase C: Code Quality Review (delegate to superpowers:requesting-code-review)

1. Invoke `superpowers:requesting-code-review` for process. Where it instructs
   `Task tool with general-purpose type`, instead dispatch the typed reviewer
   with only the per-task payload:

   ```
   Agent(subagent_type="code-reviewer", prompt="DESCRIPTION: [what was built]. PLAN_OR_REQUIREMENTS: [plan file path or task text]. BASE_SHA: [starting commit]. HEAD_SHA: [ending commit].")
   ```

   If the typed agent is unavailable, fall back to a general-purpose subagent
   using the superpowers code-reviewer prompt template.

2. Check code quality:
   - Files are focused (one clear responsibility per file)
   - Interfaces are well-defined
   - No unnecessary abstractions
   - No speculative generalization
   - Positive framing in code comments and error messages

### Phase D: Review Report

1. Produce a two-stage review report:

   ```
   ## Review Report

   ### Stage 1: Spec Compliance
   - [ ] All plan tasks implemented
   - [ ] Implementation matches plan specification
   - [ ] No stale test violations
   - [ ] Active enforcement rules followed (see session-start output)

   ### Stage 2: Code Quality
   - [ ] Files are focused and well-structured
   - [ ] Interfaces are clean
   - [ ] No unnecessary complexity
   - [ ] Positive framing throughout

   ### Verdict
   PASS / FAIL with specific items to address
   ```

2. If PASS: the implementation is complete. Proceed to integration.
    If FAIL: list specific items, return to tdd+ to fix, then re-run verify+ and review+.

## Skill Chain

After review+ passes:

- The implementation is complete
- Proceed to merge/PR decision (superpowers:finishing-a-development-branch)
- If branch discipline is active, finish with a PR (`gh pr create` via
  `superpowers:finishing-a-development-branch`) rather than a local merge.

## Completion

Report one of these states when the skill finishes:

- **DONE** — Review passed (PASS verdict). All spec compliance and code quality checks confirmed.
- **DONE_WITH_CONCERNS** — Review passed with minor items noted for follow-up.
- **BLOCKED** — Review failed (FAIL verdict). Items must be fixed before proceeding.
- **NEEDS_CONTEXT** — Need user input to resolve a review question or accept a deviation.

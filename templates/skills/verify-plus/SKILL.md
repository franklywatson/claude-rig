---
name: verify+
description: "Invoke AFTER tdd+ or sdd+ implementation is complete. Wraps superpowers:verification-before-completion with evidence standards, spec drift check, and full-suite test run. This is the ONLY phase where full test suite runs are appropriate."
argument-hint: "[plan file path]"
user-invocable: true
---

<!-- rig-generated -->

# verify+ — Evidence-Based Verification

Wraps `superpowers:verification-before-completion`. Requires superpowers to be installed.

**This skill activates verify+ phase in the enforcement layer.** During this phase:

- Full test suite runs are ALLOWED (this is the verification phase)
- Zero-defect enforcement is at strict tolerance
- Evidence must be shown before claiming done

## Procedure

### Phase A: Preparation

1. Announce phase entry:

   ```
   Now using verify+ skill. Enforcement layer adjusted:
   - Test scope: full suite runs allowed (this is verification phase)
   - Zero-defect: strict — every failure must be fixed
   - Evidence: show command output before claiming done
   ```

2. Load the plan from `docs/plans/`.

3. List all acceptance criteria from the plan.

### Phase B: Full Verification (delegate to superpowers:verification-before-completion)

1. Invoke `superpowers:verification-before-completion` with the plan context.

2. Run the FULL test suite:

   ```
   npx vitest run
   ```

   Show the output. Every test must pass. Zero failures. Zero errors.

3. For each acceptance criterion in the plan:
   - Show evidence that it is met (command output, file contents, test results)
   - Use positive framing: "Criterion X is met: [evidence]"
   - Do NOT say "tests pass" — show the actual test output

4. Check for spec drift:
   - Compare the plan's task list against actual implementation
   - Were any tasks skipped? Added? Changed?
   - Document any deviations with reasons

### Phase C: Evidence Report

1. Produce a verification report:

   ```
   ## Verification Report

   ### Test Suite
   [Full test output — ALL must pass]

   ### Acceptance Criteria
   - [ ] Criterion 1: [evidence]
   - [ ] Criterion 2: [evidence]
   - [ ] ...

   ### Spec Drift
   - [No deviations / List deviations with reasons]

   ### Enforcement Compliance
   - [ ] Active enforcement rules followed (see session-start output; real dependencies in stack/E2E tests by default)
   - [ ] If the design defines a signal stack: every applicable layer's signal was run, with each layer's result reported (pass / diff / drift / trace)
   - [ ] Evidence shown for all claims
   - [ ] All source changes have test coverage
   ```

2. If ALL checks pass, verification is complete.
   If ANY check fails, return to the implementation phase (tdd+ or sdd+) to fix.

## Skill Chain

After verify+ passes:

- Invoke `/review+` to run the compliance review agent

## Completion

Report one of these states when the skill finishes:

- **DONE** — Full test suite passes, all acceptance criteria met with evidence, no spec drift.
- **DONE_WITH_CONCERNS** — All tests pass but minor spec deviations exist (documented).
- **BLOCKED** — Tests failing, cannot proceed without fixing regressions.
- **NEEDS_CONTEXT** — Need user input to resolve an acceptance criterion or spec drift question.

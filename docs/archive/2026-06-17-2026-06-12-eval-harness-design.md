# Behavioral Eval Harness — Design

> **Status:** Executed — design realized by the shipped eval harness (PR #45); archived 2026-06-17


**Date:** 2026-06-12
**Status:** Approved
**Task:** #26.

## 1. Problem statement

Rig's 1278-test deterministic suite is **model-independent by construction** —
it never runs through a model, so it cannot observe model-driven behavior
change. This blindspot has produced two real failures this session:

1. The `tool_response` payload drift shipped green through 1271 deterministic
   tests because the e2e fixtures spoke the hook's dialect, not the harness's.
2. The Fable 5 → Opus 4.8 switch is invisible to the suite: 1278/1278 before
   and after, while the actual agent behavior the skills depend on may have
   shifted.

What no current test exercises: does `brain+` actually *elicit the loop opt-in*
for a fitting project and stay silent for a CLI tool? Does an opted-in design
actually *contain* the required sections? Does the agent *act on* an advisory
the hook emits? These are behavioral facts about a model driving the skill
chain. The eval harness closes that gap.

In the agent-loops vocabulary this harness IS the **L2 (evaluation quality)**
instrument for rig's own skills — frozen reference scenarios with
human-validated expected behavior, re-evaluated by the current model+prompt,
drift measured against a threshold. It monitors the primary system (the skill
chain); it is not itself a headless system needing its own maintainer loop.

## 2. Decision log (design Q&A, 2026-06-12)

1. **Structural-first grading, judge as fallback.** Primary assertions are
   programmatic on observable artifacts (files written, sections present,
   transcript contains the elicitation question, hook exit codes) — model-
   robust because a fact is a fact across models. An LLM-judge call is reserved
   for genuinely fuzzy invariants and must assert a yes/no *behavioral fact*,
   never a quality score.
2. **N-of-M majority** for run-to-run variance: each scenario runs K times
   (default 3), the invariant passes if it holds in ≥⌈K/2⌉ runs. Per-run
   results are reported so flakiness is visible.
3. **Local/manual runner first; CI lane deferred.** Ship `npm run eval` for a
   developer machine against the configured model, with a `--model` flag so
   Fable and Opus can be run and diffed. The nightly GitHub Action + API-key
   secret is a later, explicitly-gated step (a credentials/cost/security
   decision reserved to the operator) — documented, not built in v1.
4. **No agent-loop trajectory for the harness itself** — it is the L2
   instrument, not an instrumented system; a recursive signal stack would be
   over-engineering.

## 3. Architecture

```
evals/                            (NOT under tests/ — excluded from `npm test`)
  scenarios.ts        fixture project briefs + expected behavioral invariants
  runner.ts           orchestrates: scaffold → claude -p → capture → grade
  grade.ts            structural assertions + judge fallback; N-of-M reducer
  report.ts           EvalReport (mirrors tests/eval/score.ts shape)
  fixtures/           project-brief files per scenario
```

`npm run eval` (new script, separate from `test`) invokes `runner.ts`.

**Per scenario, per run (K=3 default):**

1. **Scaffold** a temp project dir; `rig init` into it (hooks/skills/agents);
   superpowers is globally available so its skills resolve. Write the
   scenario's project brief into the dir.
2. **Drive** `claude -p "<scripted prompt>" --model <model> --output-format
   stream-json` from the temp dir, capturing the full stream-json transcript
   plus any artifacts the run writes (design docs, hook stderr/stdout).
3. **Grade** the run against the scenario's invariants (§4).
4. **Tear down** the temp dir and its `/tmp/rig-session-*` cache fragments
   (reusing the #43 teardown discipline).

**Reduce** K runs per scenario by majority; emit an `EvalReport` (overall
score, per-scenario pass, per-run breakdown, failures with the observed vs
expected invariant). Report type is shared with / mirrors
`tests/eval/score.ts`'s `EvalReport`.

## 4. Invariants (v1 scenarios)

Each invariant is a **behavioral fact**, model-agnostic in wording.

| Scenario | Brief | Invariant (primary = structural) |
|---|---|---|
| `loop-fit-positive` | A headless, scheduled scoring pipeline with an external API contract | brain+ **fires the loop opt-in question** — transcript contains the opt-in elicitation (structural: match the question's stable substring, e.g. "agent-loop pattern" / "signal stack"). |
| `loop-fit-negative` | A one-off CLI string-formatting utility | brain+ **does not raise the loop trajectory** — transcript contains no loop opt-in elicitation (structural: absence of the same substrings). Judge fallback confirms no loop/maintainer framing appeared. |
| `loop-optin-sections` | The positive brief + a scripted "yes, include it" answer | the produced design **contains the three required sections** (signal stack, primary/loop boundary, autonomy ceiling) — structural: headings/markers present in the written design artifact. |

v1 ships these three. A hook-behavior scenario (agent *acts on* an emitted
advisory) is noted as a v2 candidate — it overlaps the deterministic e2e layer
and needs a sharper invariant than v1 should block on.

**Grading specifics:**

- Structural matchers operate on the stream-json transcript text and on files
  in the temp dir after the run.
- The judge fallback (only `loop-fit-negative`) sends the transcript to a
  judge `claude -p` call whose prompt demands a strict `PASS`/`FAIL` on the
  single fact "did the assistant propose a loop/maintainer/signal-stack
  trajectory? FAIL if yes." — a behavioral fact, not a rubric score.
- N-of-M: invariant result per run is boolean; scenario passes if ≥2/3.

## 5. Model robustness (the core requirement)

- Invariants assert facts that a *correct* system produces regardless of model
  (the opt-in question appears / doesn't; the sections exist) — never
  model-specific phrasing or quality.
- `--model` parameterizes the whole run. The runner records the model in the
  report. Running the suite under Fable and under Opus and diffing the reports
  is the drift check: a scenario that passes under one model and fails under
  the other is exactly the signal the deterministic suite cannot produce.
- The judge, being itself model-sensitive, is confined to one negative-case
  fact with a forced binary verdict, minimizing its variance surface.

## 6. Execution & cost

- **v1: local.** `npm run eval [--model <m>] [--scenario <id>] [--runs K]`.
  Uses the developer's existing `claude` auth — no secret. Real tokens: 3
  scenarios × 3 runs (+1 judge call on the negative) ≈ 10 `claude -p`
  sessions per full run; keep the scenario set small.
- **Deferred (gated to the operator): nightly CI.** A `evals.yml` workflow on
  a `schedule:` cron with an `ANTHROPIC_API_KEY` secret, non-gating (never
  blocks PRs), posting the `EvalReport`. Spec'd here; built only on explicit
  go — it commits credentials and recurring spend.

## 7. Risks / unknowns → first plan task

- **`claude -p` mechanics spike.** Confirmed available with `--print`,
  `--model`, `--output-format stream-json`. The plan's **first task** is a
  spike that scripts a single brain+ invocation headlessly against a scaffolded
  temp project and captures the transcript + artifacts — proving the
  scaffold→drive→capture loop end-to-end before any scenario/grader code. If
  headless skill invocation or artifact capture doesn't work as assumed, STOP
  and report before building the harness on a false assumption (the same
  spike-first discipline used for the teams worktree probe).
- **Skill availability in a temp project.** superpowers + rig skills must
  resolve from a fresh temp dir; the spike confirms this.
- **Determinism of briefs.** Each brief must be unambiguous enough that a
  correct system reliably elicits / stays silent; the spike's first real runs
  calibrate brief wording before the invariants are locked.
- **Cost discipline.** Default K=3 and 3 scenarios; the runner must support
  `--scenario`/`--runs` to run one scenario cheaply during development.

## 8. Testing

- The harness's own pure logic (grader reducers, report builder, N-of-M
  majority, structural matchers over canned transcript fixtures) is
  **deterministic vitest** under `tests/evals/` — unit-tested with recorded
  transcript samples, no live `claude -p` in the unit tests.
- The live `claude -p` runs are the harness's *output*, not part of
  `npm test`; they run via `npm run eval`.
- Enforcement: structural matchers and report logic ship with unit tests;
  no mocks (canned transcript fixtures are real recorded output).

## 9. What v1 deliberately does not do

- No CI workflow / API-key secret (deferred, §6).
- No judge-primary grading (judge is one confined fallback, §4).
- No hook-behavior scenario (v2, §4).
- No quality scoring — only behavioral pass/fail facts.

## 10. Acceptance criteria

1. `npm run eval` scaffolds, drives `claude -p`, grades, and tears down for
   all v1 scenarios; `--model`, `--scenario`, `--runs` flags work.
2. The three v1 invariants are asserted structurally (judge fallback only on
   `loop-fit-negative`); N-of-M majority with per-run reporting.
3. Running under two models produces comparable reports that surface a
   behavioral difference if one exists (the drift check).
4. The spike (§7) has a recorded outcome before harness code is built.
5. Harness pure logic is unit-tested under `tests/evals/`; `npm test` stays
   green and does not invoke `claude -p`; the CI nightly lane is documented as
   a gated follow-up, not built.

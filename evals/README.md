# Behavioral Eval Harness

Scripted `claude -p` sessions against fixture project briefs, asserting on
skill-chain **behavior** the deterministic vitest suite cannot reach — and
doing it with **model-robust invariants** so the same eval run under two models
surfaces behavioral drift.

This is the **L2 evaluation-quality instrument** (in rig's own agent-loops
vocabulary) for rig's skill chain: frozen reference scenarios with
human-validated expected behavior, re-evaluated by the current model+prompt.
It monitors the primary system (the skills); it is not itself an instrumented
loop.

## Why this exists

`npm test` is deterministic and **model-independent by construction** — it never
runs through a model, so it cannot observe model-driven behavior change. Two
real failures this proved necessary:

- the `tool_response` payload drift that shipped green through 1271 deterministic
  tests (the e2e fixtures spoke the hook's dialect, not the harness's);
- the Fable 5 → Opus 4.8 switch, invisible to the suite.

The eval harness closes that gap: it drives the real skills through a real model
and asserts on observable behavior.

## Usage

```bash
npm run eval                                   # all scenarios, 3 runs each, default model
npm run eval -- --scenario loop-fit-negative   # one scenario
npm run eval -- --runs 1                        # fewer runs (cheaper, during dev)
npm run eval -- --model claude-opus-4-8         # pin a model (also: EVAL_MODEL=...)
```

Uses your local `claude` auth — no API key or secret. Each run scaffolds a
throwaway temp project (`rig init` + the brief), drives `claude -p`, grades the
captured `stream-json` transcript, and tears down the temp dir and its
`/tmp/rig-session-*` cache fragments (exact paths only — never globs).

Exit code is 0 iff every scenario passed (suitable for a CI gate later).

## Scenarios (v1)

| Scenario | Brief | Invariant |
| --- | --- | --- |
| `loop-fit-positive` | headless nightly ATS-scoring service | brain+ **fires** the loop opt-in |
| `loop-fit-negative` | one-off local CSV-reformatting CLI | brain+ does **not** offer the loop trajectory |
| `loop-optin-sections` | the positive brief + a scripted "yes" | the design carries the signal-stack, primary/loop-boundary, and autonomy-ceiling sections |
| `divert-jcodemunch-used` | a fixture TypeScript router the agent is asked to grep | the agent **follows the Step 2.5 divert** and calls an `mcp__jcodemunch__` tool to locate the symbol |

The `divert-jcodemunch-used` scenario is the first to scaffold a fixture
codebase (`scenario.projectFiles` → materialized into the temp project before
`claude -p`, so session-start auto-indexes it) and the first to grade **tool-use
structure** rather than assistant text: the invariant passes only when an
`mcp__jcodemunch__*` tool call appears in the transcript. It closes the
model-driven gap the deterministic router tests can't reach — *does the agent
follow the divert advisory?* Run it with `npm run eval -- --scenario
divert-jcodemunch-used` (needs local `claude` auth and jcodemunch installed).

## How grading stays model-robust

- **Structural-first.** Invariants assert facts a *correct* system produces
  regardless of model — the opt-in question appears / doesn't; the sections
  exist — never model-specific phrasing or a quality score.
- **Loop-specific tokens.** The opt-in is detected via `agent-loop pattern` /
  `maintainer trajectory`, **not** `signal stack` (which brain+ emits in its
  general guidance for *every* project, so it is not a discriminator).
- **Visible output only (with one structural exception).** Grading runs on
  extracted assistant text, dropping thinking blocks — the user sees the offer
  in visible output, not in reasoning. The `divert-jcodemunch-used` scenario is
  the exception: "followed the advisory" is observable only in the tool calls,
  so it grades tool-use structure (an `mcp__jcodemunch__*` call) instead.
- **Confined judge fallback.** Only the negative scenario consults a judge, and
  only for one forced binary fact ("did it propose a loop trajectory?"), to
  minimize the grader's own model-sensitivity.

### Known limitation (tracked)

The negative-scenario structural matcher detects token *presence*, which
conflates *offering* the trajectory with *dismissing it by name* ("this does
not fit the agent-loop pattern" in visible output). Surfaced by the first live
run. Refinement — offer-context detection or judge-primary for the loop-fit
scenarios — is tracked as a follow-up.

`matchSectionsPresent` carries the same presence-vs-structure caveat (a
heading-marker match is the tracked refinement), and the grader does not yet
distinguish an errored `claude -p` run (`is_error`) from a model that declined
— both are minor follow-ups.

## The drift check (running across models)

Run the suite under two models and diff the reports:

```bash
npm run eval -- --model claude-fable-5  > /tmp/eval-fable.txt
npm run eval -- --model claude-opus-4-8 > /tmp/eval-opus.txt
diff /tmp/eval-fable.txt /tmp/eval-opus.txt
```

A scenario that passes under one model and fails under the other is exactly the
behavioral drift signal the deterministic suite cannot produce.

## Deferred: the nightly CI lane (reserved to the operator)

Not built in v1 — it commits API credentials and recurring token spend, which
is the operator's call. When wanted, the shape is:

- a `.github/workflows/evals.yml` on a `schedule:` cron (e.g. nightly),
- an `ANTHROPIC_API_KEY` repo secret for the headless `claude -p` runs,
- **non-gating** — it posts the `EvalReport` (and can open an issue on
  regression) but never blocks PRs, because the runs are non-deterministic and
  the lane is a drift monitor, not a merge gate.

Until then, run `npm run eval` locally before releases and after any model
change.

## Internals

- `scenarios.ts` — the briefs + invariants (`fixtures/*.md`).
- `grade.ts` — `extractAssistantText`, the structural matchers, the judge.
- `reduce.ts` — N-of-M majority + report builder.
- `runner.ts` — orchestration (`gradeTranscript`, `runScenario`, `runAll`,
  `TeardownRegistry`, `parseArgs`, `main`).
- `session-driver.ts` — the live `claude -p` driver (`buildClaudeArgs`,
  `makeLiveDriver`, `makeJudge`, `sessionFragmentOwnedBy`); not imported by unit tests.
- Pure logic is unit-tested under `tests/evals/` with canned recorded
  transcripts; the live runs are the harness's output, not part of `npm test`.

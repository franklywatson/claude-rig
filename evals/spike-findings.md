# Eval Harness Spike — Findings (Task 1)

**Date:** 2026-06-12 · **Driving model probed:** `claude-opus-4-8` · **Result: PASS — STOP gate cleared.**

The spec §7 make-or-break unknown — *does `claude -p` invoke a rig skill headlessly,
and can we capture the behavior?* — is resolved affirmatively, and both the positive
and negative loop-fit invariants were observed live.

## What was probed

A temp project was scaffolded with `rig init`, given a one-line `BRIEF.md`, and driven
with `claude -p "<prompt>" --model claude-opus-4-8 --output-format stream-json --verbose
--dangerously-skip-permissions`.

## Findings

1. **Headless skill visibility — YES.** A cheap probe ("list skills ending in `+`")
   returned `brain+, debug+, plan+, review+, sdd+, tdd+, verify+` — the rig-installed
   project skills resolve in a non-interactive `claude -p` session from a temp dir.
2. **Transcript capture — YES.** `stream-json` lines parse cleanly. Assistant text is
   recoverable two ways: the final `{type:"result"}` line's `result` field, and each
   `{type:"assistant"}` line's `message.content[].text`. The grader concatenates both.
3. **Hooks fire in the nested session.** The probe dir's rig hooks ran
   (`system/hook_started` / `system/hook_response` events present) without breaking the
   headless run — installed enforcement is active under `claude -p`.
4. **Positive invariant fires.** Brief = headless nightly ATS-scoring service (all four
   loop-fit signals). brain+ ran the loop-fit assessment and **emitted the opt-in
   question verbatim**; both loop-specific tokens present (`agent-loop pattern`,
   `maintainer trajectory`). Captured: `fixtures/canned-loop-fit-positive.jsonl`.
5. **Negative invariant holds.** Brief = one-off local CSV-reformatting CLI (no
   contracts, no model, not long-lived). brain+ did **not** offer the loop trajectory;
   loop-specific tokens absent. Captured: `fixtures/canned-loop-fit-negative.jsonl`.
6. **Model-robustness discriminator confirmed empirically.** In the positive run the
   ambient token `signal stack` appeared 4× (brain+'s general signal-first guidance),
   while in the negative run it appeared 0×. Either way it is the wrong discriminator —
   the grader keys the opt-in invariant on `agent-loop pattern` / `maintainer
   trajectory`, which appeared only when the elicitation genuinely fired.

## Design decisions locked by the spike

- **Capture:** parse `stream-json`; concatenate `result` + all `assistant` text for grading.
- **Invocation:** `claude -p <prompt> --model <m> --output-format stream-json --verbose
  --dangerously-skip-permissions`, bounded by a wall-clock timeout (≈300s) per run.
- **Suppress subagent dispatch in the eval prompt** ("do brain+'s assessment yourself,
  do NOT dispatch subagents"). This isolates the elicitation behavior under test and
  sidesteps subagent-dispatch stalls; recorded as an intentional harness constraint,
  not a fidelity gap (the assessment logic is what the invariant targets).
- **Grader token sets (model-robust):** opt-in present ⇔ `agent-loop pattern` OR
  `maintainer trajectory` (case-insensitive). Never `signal stack`.
- **Single-turn suffices** for the loop-fit invariants when the prompt asks the model to
  complete the assessment this turn — no multi-turn `--input-format stream-json` needed
  for v1 scenarios.

No fallback framing required — the primary design works as specced.

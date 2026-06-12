# Agent Loops & the Signal Stack

How rig supports loop-centric development: projects that don't just get built,
but **self-assemble against their own test signals and stay healthy under an
always-on maintainer agent**. This is the user-facing guide; the design
vocabulary the skills load at runtime is installed into
`.claude/skills/brain-plus/references/agent-loops.md` (and the same file under
`plan-plus/`) by `rig init`.

The model is strictly **opt-in**. `brain+` assesses fit silently and asks
once, only when fit signals are present. Declining costs nothing, and nothing
about the loop is ever enforced by hooks — it is a design trajectory, not a
rule.

## The model

**Primary system vs subordinate loop.** The primary system is the thing being
built. It must be complete and operable entirely on its own — human-driveable
with no dependency on any automation around it. The agentic loop is a
subordinate layer with one top-level goal, set by you (the orchestrator):
*self-assemble the primary system from the approved spec, then keep it
conformant and healthy.* Disabling the loop changes nothing about the primary
system.

**The signal stack.** Layered test signals, each isolating exactly one failure
source. Projects include only the layers that apply:

| Layer | What's tested | Signal | A failure here means |
| ----- | ------------- | ------ | -------------------- |
| L0 — Deterministic logic | Golden tests: known inputs to exact outputs | binary pass/fail | code regression |
| L1 — External contract | Read-only probes of third-party APIs | contract diff report | the dependency changed, not us |
| L2 — Evaluation quality | Calibration harness for model components | drift metrics vs thresholds | model shift or prompt regression |
| L3 — Integration | Dry-run end-to-end, everything except writes | stage-by-stage trace | wiring/config/auth — the seams |
| L4 — Production telemetry | Structured metrics from every real run | trend series | input drift vs system drift |

Classic stack/E2E tests are the L3 instrument. Docker services and full-loop
assertions are instrumentation for whichever layers a feature touches.

**Triangulation.** Cross-layer failure patterns localize faults by
construction: L2 failing while L0 passes means the model layer moved, not the
code. L3 failing while L1 passes means our integration broke, not the
dependency. L4 shifting while L2 is stable means the inputs changed — don't
"fix" anything. Each opted-in design records its own truth table.

**Two phases, one goal.** *Assembly:* the stack is built first, and the
assembly process uses it to verify itself as it builds — each stage gated by
its layer's signal. *Sustain:* a scheduled maintainer agent runs the same
stack, triangulates, and acts by graduated autonomy — heartbeat when healthy,
structured diagnosis when degraded, and for code fixes a PR through the same
CI gates as human work. It never edits the live system directly, and policy
artifacts (rubrics, thresholds) are flagged, never edited.

## How the skill chain carries it

| Phase | Loop-aware behavior |
| ----- | ------------------- |
| `brain+` | Assesses loop fit within its own reasoning (headless/scheduled operation, external contracts, model components, long-lived operation). Asks the opt-in question once when fit. On opt-in, the design gains a signal-stack section, a primary/loop boundary statement, and an autonomy ceiling. |
| `plan+` | Orders opted-in plans **signal-stack-first**: harness tasks come before or alongside the features they gate. Every task names its gating signal. The maintainer deployment is a late task; rollout gates (credentials, schedules, live writes) are reserved to you. |
| `sdd+` | Executes the plan via typed subagents (implementer, spec-reviewer, code-reviewer). When the plan defines a signal stack, each task's completion gate is its named signal — the implementer must run it and show output. |
| `tdd+` | Same gating-signal rule for inline execution. |
| `verify+` | Runs every applicable layer's signal and reports each layer's result (pass / diff / drift / trace). |

The maintainer agent itself is deliberately **not** shipped as a rig template:
its schedule, tools (e.g., a repo as a tool with a vault-held token), and
rollout gates are deeply project-specific. Rig ships the thinking framework;
each opted-in project designs its own maintainer during `brain+`. If a common
shape emerges across projects, a `loop+` skill and maintainer template are the
natural next iteration.

## When it fits — and when it doesn't

The pattern pays for headless or scheduled systems, systems with external API
contracts, model/evaluation components, and long-lived operation where drift
is the dominant failure mode. It does not pay for one-off scripts, interactive
UI applications, or libraries — `brain+` will not offer it for these.

## How this is tested today

Deterministic coverage lives in `tests/cli/template-content.test.ts` and
`tests/cli/init.test.ts`: the opt-in question and fit guidance exist in
`brain+`, the signal-stack-first ordering exists in `plan+`, the gating-signal
rules exist in `sdd+`/`tdd+`/`verify+`, and `rig init` installs the reference
into both consuming skills.

What deterministic tests cannot cover is **behavior**: does `brain+` actually
ask the opt-in question for a fitting project and stay silent for a CLI tool?
That requires scenario-based evaluation — scripted non-interactive sessions
(`claude -p`) run against fixture project descriptions, asserting on the
elicitation behavior and the produced design sections. This eval harness is
tracked as future work; until it exists, the loop behavior is validated by
dogfooding on real projects.

## Related

- [architecture.md](architecture.md) — Layer 3 (skill chain) and the typed agents that execute loop plans
- [skill-wrapping.md](skill-wrapping.md) — how the chain wraps superpowers skills
- [design-process.md](design-process.md) — how rig itself was built

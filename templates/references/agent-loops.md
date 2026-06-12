<!-- rig-generated -->

# Agent Loops & the Signal Stack

A design vocabulary for projects that opt into a self-assembling,
self-maintaining trajectory. Offered during brain+ when fit signals are
present; never mandated.

## Primary system vs subordinate loop

The **primary system** is the thing being built. It must be complete and
operable entirely on its own — human-driveable with no dependency on any
automation around it.

The **agentic loop** is a subordinate layer with one top-level goal, set by
the orchestrator (the user): **self-assemble the primary system from the
approved spec, then keep it conformant and healthy.** Disabling the loop
changes nothing about the primary system.

## The signal stack

Layered test signals, each isolating exactly one failure source. Projects
include only the layers that apply.

| Layer | What's tested | Signal | A failure here means |
|---|---|---|---|
| **L0 — Deterministic logic** | Golden tests: known inputs → exact expected outputs, encoded as fixtures | binary pass/fail | code regression |
| **L1 — External contract** | Read-only probes of third-party dependencies: field IDs resolve, response shapes unchanged, permissions intact | contract diff report | the dependency changed, not us |
| **L2 — Evaluation quality** *(model components only)* | Calibration harness: frozen reference inputs with validated expected outputs, re-evaluated by the current model+prompt; drift metrics vs thresholds | drift metrics | model shift, prompt regression, or policy-edit side effect |
| **L3 — Integration** | Dry-run end-to-end against live dependencies — everything except writes; per-stage timing and success | stage-by-stage trace | wiring/config/auth — the seams |
| **L4 — Production telemetry** | Every real run appends structured metrics to a memory store: counts, error rates, distributions over time | trend series | population drift (the inputs changed) vs system drift — distinguishable because L2 holds the system constant |

Stack/E2E tests in the classic sense are the L3 instrument. Docker services,
test containers, and full-loop assertions are instrumentation for whichever
layers the feature touches.

## Triangulation

Cross-layer failure patterns localize faults by construction:

- **L2 fails while L0 passes** → the model layer moved, code didn't
- **L3 fails while L1 passes** → our integration broke, not the dependency
- **L4 shifts while L2 is stable** → the inputs changed, not the system —
  don't "fix" anything

Each diagnosis that would have been an afternoon of grepping becomes a lookup
in a truth table. Write the project's own truth table in the design doc.

## Two phases, one goal

**Assembly.** The signal stack is built *first*; the assembly process uses it
to verify itself as it builds — each build stage gated by its layer's signal
(golden tests gate the core logic; contract probes gate the client;
calibration gates the evaluation component; dry-runs gate integration).
Rollout gates — credentials, schedule enablement, live writes — are reserved
to the orchestrator.

**Sustain.** A scheduled maintainer agent runs the same stack, triangulates
via the truth table, and acts by graduated autonomy:

- healthy → heartbeat line into the telemetry store
- degraded/broken → structured diagnosis (implicated layer, evidence,
  candidate fix); for code fixes, a branch + patch + PR through the same CI
  gates as human work

The maintainer never edits the live system directly. Policy artifacts
(rubrics, thresholds, business rules) are flagged, never edited — policy is
the orchestrator's, not the loop's.

## When this pattern fits

**It pays for:** headless/scheduled systems; systems with external API
contracts; model/evaluation components; long-lived operation where drift is
the dominant failure mode.

**It does not pay for:** one-off scripts, interactive UI applications,
libraries. Don't offer the trajectory for these.

## What opting in adds to the design

1. A signal-stack section: each applicable layer with its signal and failure
   meaning, plus the project's triangulation truth table
2. A primary/loop boundary statement: the primary system is operable with the
   loop disabled
3. An autonomy ceiling: what the loop may do alone, what requires the
   orchestrator (merges, policy, rollout gates)
4. A maintainer trajectory: cadence, signals consumed, graduated-autonomy
   actions

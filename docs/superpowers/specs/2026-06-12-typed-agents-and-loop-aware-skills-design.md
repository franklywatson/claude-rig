# Typed Subagent Dispatch & Loop-Aware Skill Chain — Design

**Date:** 2026-06-12
**Status:** Approved
**Scope:** Two-part evolution of rig's skill chain. Part 1 replaces general-purpose
subagent dispatch with typed agent definitions. Part 2 encodes the agent-loop /
signal-stack operating model as an opt-in design vocabulary in `brain+` and `plan+`.

---

## 1. Problem statement

**Part 1.** Superpowers skills dispatch every subagent as `general-purpose`
(explicit in `requesting-code-review/SKILL.md:34` and throughout
`subagent-driven-development`). Role, context, and responsibility scope ride in
prompt templates, which works, but loses what Claude Code's typed agent registry
(`.claude/agents/`) provides: tool restriction (a reviewer dispatched as
general-purpose can edit files), a dedicated system prompt (rig's enforcement
rules can't reach the subagent's system prompt), per-agent model/turn budgets,
and observability (everything renders as "General purpose agent" in the UI).
Superpowers does this deliberately for cross-platform portability; rig is
Claude-Code-only and already ships one typed agent (scout), so it can do better.

**Part 2.** Rig's plus-skills currently assume "stack tests" as the universal
operating model. The more general model — proven in the reference project
`~/forgd/forgd-ashby-integ` (spec §13) — is a **subordinate agentic loop** over a
**layered signal stack**: each foundational layer of a system emits its own test
signal, failure patterns localize faults by construction, and a scheduled
maintainer agent reasons over signals instead of spelunking. Stack tests are one
instrument in that stack (the integration layer), not the whole model. Rig should
offer this trajectory during brainstorming and planning — opt-in, never mandated.

## 2. Decision log

Decisions from design Q&A (2026-06-12):

1. **Full-role agents** — agent system prompts carry the complete role (persona,
   checklists, review discipline) plus rig's enforcement overlay. Skills dispatch
   with per-task payload only. Role content is deliberately forked from
   superpowers' prompt templates (porting policy: §8.3).
2. **Three agents** — `code-reviewer`, `spec-reviewer`, `implementer`.
   Superpowers' code-quality-reviewer stage reuses the code-reviewer template, so
   one code-reviewer agent serves both `review+` and the quality stage of
   subagent-driven development.
3. **New `sdd+` skill** wrapping `superpowers:subagent-driven-development` is the
   implementer's dispatch seam. `tdd+` stays inline and remains the default path
   (multi-agent costs 3–10× tokens vs single-agent; opt in deliberately).
4. **One spec, two parts** — typed dispatch and loop-aware skills ship as one
   coherent evolution.
5. **Part 2 depth: elicit + design vocabulary only** — rig ships the thinking
   framework as a reference doc loaded by `brain+`/`plan+`. No maintainer agent
   template, no loop+ skill in this iteration. Each project designs its own loop.
6. **Loop trajectory is strictly opt-in** — the skill assesses fit silently,
   asks the user once only when fit signals are present, and a decline costs
   nothing. No enforcement-pipeline or `.harness.yaml` surface for it.

Grounding (from `~/forgd/claude-kb`, Anthropic canonical posts):

- *Building Multi-Agent Systems* (2026-01-23): verification is a good context
  boundary (blackbox — the verifier needs *whether*, not *why*); the
  **early-victory problem** is the top failure mode for verification agents and
  is mitigated with explicit completeness instructions; specialization is
  justified for conflicting behavioral modes (critical reviewer vs implementer).
- *Subagents in Claude Code* (2026-04-07): the `description` field controls
  auto-trigger vs explicit invocation — these agents must be explicit-dispatch
  only, the opposite of scout's "PROACTIVELY use" phrasing.

---

## Part 1 — Typed subagent dispatch

## 3. Agent definitions (`templates/agents/`)

Three new templates, each carrying the `<!-- rig-generated -->` marker so
`copyUserTemplate` refreshes unmodified installs without `--force`. The existing
`scout.md` gains the same marker (targeted fix — it lacks one today, so installed
scouts are never auto-refreshed). Frontmatter follows scout's shipped pattern:
`tools` as a single comma-separated quoted string, `model: inherit`.

| | `code-reviewer` | `spec-reviewer` | `implementer` |
| --- | --- | --- | --- |
| **Role** | Senior code reviewer: plan alignment + code quality, ported from superpowers `requesting-code-review/code-reviewer.md` | Adversarial spec-compliance checker, ported from `subagent-driven-development/spec-reviewer-prompt.md` — "do not trust the report", line-by-line spec vs code | Task executor, ported from `implementer-prompt.md`: TDD discipline, asks before guessing, commits, self-reviews |
| **tools** | `Read,Glob,Grep,Bash` + jcodemunch/graphify read tools (scout's list) — **no Edit/Write/NotebookEdit** | Same read-only set | Field omitted → inherits all tools |
| **model** | `inherit` | `inherit` | `inherit` |
| **maxTurns** | 25 | 15 | 50 |
| **description** | Explicit-dispatch wording: "Use when dispatched by review+ or sdd+ to review completed work… Do not invoke proactively." | Same pattern | Same pattern |

Each system prompt contains, in order:

1. **Persona and checklist** — forked from the corresponding superpowers
   template's role content.
2. **Enforcement overlay** — instruction to read `.harness.yaml` (and
   session-start context if present) for active enforcement rules at runtime:
   constitutional rules (real dependencies in stack/E2E tests), evidence-only
   claims, zero-defect expectations. Read at runtime, not baked at init, so
   config changes never require re-init.
3. **Early-victory guard** (reviewers) — "You MUST read the complete diff
   (`git diff BASE..HEAD`, every file) before issuing a verdict" /
   (implementer) — "You MUST run the scoped tests and show output before
   reporting completion."
4. **Output contract** — matches superpowers' exactly so orchestrating skills'
   expectations hold: reviewers return Strengths / Issues
   (Critical/Important/Minor) / Assessment; spec-reviewer returns
   compliant-or-gaps; implementer reports what was built, test evidence, and
   commit SHA.

Reviewers run tests via Bash when the review requires it; they cannot modify
files — fixes route back through the orchestrator to the implementer (or main
session). No `{{VAR}}` placeholders are needed in any agent template.

## 4. Dispatch-override mechanism

Rig skills keep delegating to superpowers skills for process. Each dispatch site
adds one explicit override clause:

> Where the delegated skill instructs `Task tool with general-purpose type`,
> instead dispatch `Agent(subagent_type="<name>", prompt=<payload only>)`. The
> role content lives in the agent definition — pass only the per-task
> placeholders (DESCRIPTION, PLAN_OR_REQUIREMENTS, BASE_SHA, HEAD_SHA, task
> text). If the typed agent is unavailable, fall back to general-purpose with
> the superpowers prompt template.

This keeps superpowers as the process source, makes the swap structural and
greppable (verify-harness checks dispatch syntax literally), and degrades to
today's behavior if a user deletes an agent file.

Wiring:

- **`review-plus`**: Phase B (spec compliance) dispatches `spec-reviewer`;
  Phase C dispatches `code-reviewer`.
- **`sdd-plus`** (new skill, `templates/skills/sdd-plus/SKILL.md`): wraps
  `superpowers:subagent-driven-development`. Per task: `implementer` →
  `spec-reviewer` → `code-reviewer`, continuous execution, same override
  clause. One Part-2 seam line: "If the plan defines a signal stack, each
  task's completion gate is its named signal."
- **`tdd+`, `verify+`**: unchanged dispatch (inline), Part 2 rewords prose only.

## 5. Phase tracker

`src/skills/phase-tracker.ts`: add `sdd+` as a peer of `tdd+` — same entry rules
(free transition after `plan+`), and `verify+`'s prerequisite widens to "prior
`tdd+` **or** `sdd+` visit". `SkillPhase` type and transition tables updated
accordingly.

## 6. Installer, verify-harness, docs

- `src/cli/init.ts`: `agentFiles` (line 92) gains
  `['code-reviewer.md', 'implementer.md', 'spec-reviewer.md']`; the skills array
  (line 77) gains `'sdd-plus'`. No structural changes — `copyUserTemplate`,
  `existsSync` guard, and `{{VAR}}` passthrough already handle everything.
- **verify-harness**: new AG checklist items per agent (file exists +
  dispatchable via `Agent(subagent_type="…")`), mirroring AG1/AG2 for scout.
- **Docs** (docs lint CI requires): README and `docs/getting-started.md`
  "What gets installed" tables gain the three agents and `sdd-plus`;
  `docs/architecture.md` skill-chain diagram and Layer 3 section gain `sdd+`;
  skill table in README gains `sdd+` row.
- **High-level framing**: the README gains a "Rig vs plain superpowers"
  section positioning this release's headline distinction — same superpowers
  workflows, but enforcement is programmatic (hooks), subagents are typed and
  tool-scoped, and the chain can graduate to a self-assembling /
  self-maintaining trajectory. `docs/skill-wrapping.md`'s
  superpowers-vs-rig table gains the typed-dispatch and
  subagent-driven-development rows.

## 7. Part 1 error handling and maintenance

- **User-modified agent files**: preserved by `copyUserTemplate` marker
  semantics (now consistent across all four agents).
- **Agent missing at dispatch**: fallback clause in §4 degrades to
  general-purpose + superpowers template.
- **Superpowers absent**: unchanged — skills already declare the requirement.
- **Porting policy (upstream drift)**: agent role prompts are a deliberate fork
  of superpowers' prompt templates. On superpowers version bumps, diff
  `requesting-code-review/code-reviewer.md` and
  `subagent-driven-development/*-prompt.md` against rig's agent bodies and port
  substantive changes. Recorded here so the maintenance cost is a known,
  accepted trade for enforcement reach and tool scoping.

## 8. Part 1 testing

1. `tests/cli/init.test.ts`: mirror `creates scout agent definition` for the
   three agents and `sdd-plus`; marker-refresh tests for agent files
   (update-without-`--force`, preserve-user-modified) — new coverage, since
   scout never had the marker.
2. `tests/skills/phase-tracker.test.ts`: `sdd+` transitions; `verify+` accepts
   either `tdd+` or `sdd+` visit.
3. Template-content assertions: dispatch syntax
   `Agent(subagent_type="code-reviewer"` (etc.) present in review-plus and
   sdd-plus templates; reviewers' `tools` frontmatter contains no
   Edit/Write/NotebookEdit; `<!-- rig-generated -->` present in all four agent
   templates; explicit-dispatch description wording present.
4. Coverage gate (80/75) applies; the only `src/` logic change is the phase
   tracker.

---

## Part 2 — Loop-aware skill chain

## 9. The reference doc (`templates/references/agent-loops.md`)

One template, installed to **both** `.claude/skills/brain-plus/references/` and
`.claude/skills/plan-plus/references/` (single source, two targets — robust to
either skill being removed). Content, generalized from
`forgd-ashby-integ/docs/superpowers/specs/2026-06-11-ashby-prescreen-design.md`
§13:

1. **Primary system vs subordinate loop.** The loop's top-level goal — set by
   the orchestrator (the user) — is to *self-assemble the primary system from
   the approved spec, then keep it conformant and healthy*. The primary system
   must be fully operable with the loop disabled; disabling the loop changes
   nothing about it.
2. **The signal stack.** Generic five-layer form; projects include only the
   layers that apply. Each layer isolates exactly one failure source:

   | Layer | What's tested | Signal | A failure here means |
   | --- | --- | --- | --- |
   | L0 — Deterministic logic | Golden tests: known inputs → exact outputs | binary pass/fail | code regression |
   | L1 — External contract | Read-only probes of third-party APIs: shapes, IDs, permissions | contract diff report | the dependency changed, not us |
   | L2 — Evaluation quality *(model components only)* | Calibration harness: frozen references with validated expected outputs, re-evaluated by current model+prompt; drift metrics | drift vs thresholds | model shift, prompt regression, or policy-edit side effect |
   | L3 — Integration | Dry-run end-to-end against live dependencies, everything except writes; per-stage timing/success | stage-by-stage trace | wiring/config/auth — the seams |
   | L4 — Production telemetry | Every real run appends structured metrics to a memory store | trend series | population drift vs system drift (distinguishable because L2 holds the system constant) |

3. **Triangulation.** Cross-layer failure patterns localize faults by
   construction: L2 fails while L0 passes → the model layer moved, code didn't.
   L3 fails while L1 passes → our integration, not the dependency. L4 shifts
   while L2 is stable → the inputs changed, not the system — don't "fix"
   anything. Each diagnosis that would have been an afternoon of grepping
   becomes a lookup in a truth table.
4. **Two phases, one goal.** *Assembly:* the stack is built first; the assembly
   process uses it to verify itself as it builds — each stage gated by its
   layer's signal; rollout gates (credentials, schedule enablement, live
   writes) reserved to the orchestrator. *Sustain:* a scheduled maintainer
   agent runs the same stack, triangulates, and acts by graduated autonomy —
   healthy → heartbeat; degraded/broken → structured diagnosis (implicated
   layer, evidence, candidate fix) and, for code fixes, a PR through the same
   CI gates as human work. It never edits the live system directly; policy
   artifacts (rubrics, thresholds) are flagged, never edited.
5. **Fit guidance.** The pattern pays for headless/scheduled systems, systems
   with external API contracts, model/evaluation components, and long-lived
   operation. It does not pay for one-off scripts, interactive UI apps, or
   libraries — and the skills must say so, so the question isn't asked there.

## 10. brain+ changes (opt-in elicitation)

Phase B gains a **loop-fit assessment** step inside the skill's own reasoning:
check the emerging design against the fit signals in the reference doc. Only
when fit signals are present, ask the user **one** opt-in question:

> "This project fits the agent-loop pattern (headless operation / external
> contracts / model components). Want the design to include a signal stack and
> a maintainer trajectory? (See references/agent-loops.md.)"

A decline costs nothing and is not re-asked within the session. On opt-in,
brainstorming walks the layering for this project: which layers apply, what
signal each emits, where the primary/loop boundary sits, the autonomy ceiling,
and the maintainer cadence. Phase C checklist gains **conditional** items
(only when opted in):

- [ ] Signal stack defined for each applicable layer (signal + failure meaning)
- [ ] Primary system fully operable with the loop disabled
- [ ] Autonomy ceiling and orchestrator-owned gates stated

## 11. plan+ changes and vocabulary generalization

When the design doc contains a loop section, `plan+` orders the plan
**signal-stack-first**: harnesses are built before or alongside the features
they gate. Each task names its gating signal; the maintainer deployment is a
late task; rollout gates are explicitly reserved to the user.

Existing "stack tests" / "Docker services" / "full-loop assertion" prose in
`brain-plus`, `tdd-plus`, and `verify-plus` templates is reworded into
signal-stack vocabulary — stack tests become one instrument (the integration
layer, L3) rather than the assumed universal model. Semantics are unchanged for
projects that don't opt in: the same Docker-services and full-loop-assertion
questions get asked, framed as instrumentation of the layers the feature
touches.

## 12. What Part 2 deliberately does not change

- **No enforcement-pipeline or `.harness.yaml` surface** — the loop trajectory
  is advisory by requirement; nothing about it is blockable.
- **No maintainer agent template, no loop+ skill** — deferred until the
  elicitation pattern proves out; each project designs its own maintainer (as
  the ashby project did).
- **No phase-tracker changes** — elicitation lives inside existing phases.

## 13. Part 2 testing

1. `tests/cli/init.test.ts`: reference doc installed to both skill dirs.
2. Template-content assertions: opt-in question and fit-guidance reference in
   `brain-plus`; signal-stack-first ordering instruction in `plan-plus`;
   generalized vocabulary present (and bare "stack test" framing absent as the
   assumed default) in `tdd-plus`/`verify-plus`; the sdd+ seam line present.
3. Docs lint: getting-started and README mention the opt-in loop trajectory.

---

## 14. Acceptance criteria

1. `rig init` in a clean project installs four agent files (scout + three new),
   ten skills (nine existing + `sdd-plus`), and the agent-loops reference in
   both `brain-plus` and `plan-plus` — all carrying rig-generated markers.
2. `/verify-harness` passes with the new AG items.
3. `review+` dispatches `spec-reviewer` (Phase B) and `code-reviewer` (Phase C)
   as named typed agents; both are tool-restricted (no file edits possible).
4. `/sdd+` after `/plan+` executes plan tasks via typed
   implementer → spec-reviewer → code-reviewer chains; `/verify+` accepts the
   `sdd+` path.
5. `brain+` asks the loop opt-in question only on fit, and an opted-in design
   doc contains a signal-stack section with the three conditional checklist
   items satisfied.
6. Full test suite passes; coverage gate (80% statements/functions/lines, 75%
   branches) holds; docs lint passes.

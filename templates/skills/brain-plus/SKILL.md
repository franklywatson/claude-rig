---
name: brain+
description: "Invoke BEFORE any design or feature work. Wraps superpowers:brainstorming with scout agent context harvesting, signal-first design considerations, opt-in agent-loop trajectory elicitation, and constitutional rule awareness. Asks questions one at a time to refine the design."
argument-hint: "[feature description]"
user-invocable: true
---

<!-- rig-generated -->

# brain+ — Context-Aware Design

Wraps `superpowers:brainstorming`. Requires superpowers to be installed.

## Before You Begin

Invoke this skill BEFORE starting any design work. It adds three capabilities on top of the base brainstorming skill:

1. **Scout context** — automatically harvests codebase context
2. **Signal-first design** — considers which layers of the signal stack the feature touches, plus Docker/test infrastructure and full-loop verification (see `references/agent-loops.md`)
3. **Constitutional awareness** — loads active enforcement rules from session context

## Procedure

### Phase A: Harvest Context

1. Invoke the scout agent to map the current codebase:

   ```
   Agent(subagent_type="scout", prompt="Map the codebase structure for [feature area]. Focus on: existing patterns, related modules, test infrastructure, and entry points relevant to [feature].")
   ```

2. Read the project's CLAUDE.md for project-specific rules.

3. Identify:
   - Existing patterns this feature should follow
   - Test infrastructure available (vitest, pytest, stack tests)
   - Modules that will be affected
   - Active enforcement rules from session context (see session-start output; real dependencies in stack/E2E tests by default)

### Phase B: Design (delegate to superpowers:brainstorming)

1. Invoke `superpowers:brainstorming` with the enriched context.

2. During brainstorming, add these signal-first considerations:
   - Which layers of the signal stack does this feature touch? (see `references/agent-loops.md` — deterministic logic, external contract, evaluation quality, integration, telemetry)
   - What instrumentation do those layers need? (Docker services, test harnesses, probes)
   - What are the full-loop assertions? (primary + second-order + third-order effects)
   - What test utilities need to exist before implementation?
   - Which components are protected from mocking (see active enforcement rules)?

3. Use positive framing in all design guidance:
   - "Use real database connections in tests" (not "don't mock the database")
   - "Write assertions that verify observable behavior" (not "don't test implementation details")
   - "Show command output before claiming done" (not "don't say tests pass without evidence")

4. **Loop-fit assessment** (within your own reasoning — do not ask unless fit
   signals are present). Check the emerging design against the fit guidance in
   `references/agent-loops.md`: headless/scheduled operation, external API
   contracts, model/evaluation components, long-lived operation. One-off
   scripts, interactive UI apps, and libraries do not fit — skip silently.

   If fit signals are present, ask the user **once**:

   > "This project fits the agent-loop pattern (headless operation / external
   > contracts / model components). Want the design to include a signal stack
   > and a maintainer trajectory? See `references/agent-loops.md` for what
   > that adds. Opting out costs nothing."

   If declined, do not re-ask this session. If accepted, walk the layering
   for this project: which layers apply, what signal each emits, where the
   primary/loop boundary sits, the autonomy ceiling, and the maintainer
   cadence — capture all of it in the design.

5. **Sizing scales; this overlay does not.** superpowers 7.0.1 sizes the work
   only after it understands the request — a quick, clear task is done at
   once, a small change is agreed in chat, a project gets a written design
   with a builder check. Before sizing, 7.0.1 digs into the project's own
   context first (it reads what the request referred to and never asks what
   the context already answers) and then lays out two or three approaches
   with a recommendation for the user to pick; the design doc carries the
   chosen approach as its Approaches part
   ([#2571](https://github.com/obra/superpowers/issues/2571)). The offer to
   skip the questions is conditional
   ([#2560](https://github.com/obra/superpowers/issues/2560)): it appears
   only when brainstorming started on its own — `/brain+` dispatches the
   skill by name, so this path never sees the offer and the first message
   ends with its question. (The user can still wave the questions off
   themselves; the coverage below applies there too.) Whichever size the
   wrapped skill picks (or the user overrides to), apply the overlay above
   in full — scout context (Phase A; the wrapped skill's read-first pass
   composes with the scout harvest, it does not replace it), the
   signal-first considerations, the loop-fit assessment, and the Phase C
   checklist. On a quick task or a chat change the deliverable may be a
   short answer or an agreed paragraph rather than a design document, but
   the opt-in question is still asked when fit signals are present —
   including on the skip-the-questions path, where the base skill considers
   itself done: skipping its questions is not opting out of the loop
   trajectory. The opt-in composes with the wrapped skill's
   owns-the-choices step
   ([#2482](https://github.com/obra/superpowers/issues/2482)): treat the
   signal-stack/maintainer question as one of the how-it-gets-made choices
   the user can own. When a written design is produced, confirm the Phase C
   checklist before handover so the rig sections ride through the builder
   check with the rest of the document. Never skip the overlay because the
   base skill took a small path.

### Phase C: Validate

1. Confirm the design addresses:
   - [ ] Feature purpose and scope
   - [ ] Affected modules identified
   - [ ] Testing strategy defined
   - [ ] Active enforcement rules acknowledged (see session-start output)
   - [ ] Protected components identified per enforcement rules (real dependencies in stack/E2E tests; mocks appropriate in unit tests)
   - [ ] Integration-layer (stack test) user journey defined (if applicable)
   - [ ] **If loop trajectory opted in:** signal stack defined for each applicable layer (signal + failure meaning);
     primary system operable with the loop disabled; autonomy ceiling and orchestrator-owned gates stated

## Output

Return the validated design with testing strategy to feed into `plan+`.

## Skill Chain

After completing brain+, the next step is:

- Invoke `/plan+` to create the implementation plan from this design

## Completion

Report one of these states when the skill finishes:

- **DONE** — Design validated, ready for `/plan+`. All checklist items in Phase C confirmed.
- **DONE_WITH_CONCERNS** — Design complete but has open questions or risks to address in planning.
- **BLOCKED** — Cannot proceed (missing context, unclear requirements, external dependency).
- **NEEDS_CONTEXT** — Need user input to resolve an ambiguity or make a design decision.

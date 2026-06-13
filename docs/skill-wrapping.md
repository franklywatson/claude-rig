# Skill Wrapping

Rig's skill chain (`brain+` -> `plan+` -> `tdd+` -> `verify+` -> `review+`) works
by **wrapping** [superpowers](https://github.com/obra/superpowers) skills. Each
rig skill adds project-specific enforcement on top of a generic superpowers
workflow.

This doc explains the wrapping pattern and shows how to create your own wrapped
skills for domain-specific needs. For the basics of adding standalone skills and
enforcement checks, see [extending.md](extending.md).

## The wrapping pattern

Every wrapped skill follows three phases:

1. **Pre-process** -- enrich context with project-specific state (scout agent
   results, constitutional rules, environment detection, phase history)
2. **Delegate** -- invoke the underlying `superpowers:*` skill with that
   enriched context
3. **Post-process** -- validate output against project-specific constraints
   (stale tests, no-mock enforcement, evidence standards)

```
brain+                           superpowers:brainstorming
  |  (pre-process)                   |
  |  scout agent maps codebase        |
  |  load constitutional rules        |
  |  identify affected modules        |
  |                                   |
  +-------- delegate ---------------->+
  |                                   |
  |  (post-process)                   |
  |  validate against rules           |
  |  confirm testing strategy         |
  +-----------------------------------+
```

## What superpowers provides vs what rig adds

| Superpowers skill | Generic discipline | Rig overlay adds |
| ----------------- | ------------------ | ---------------- |
| `brainstorming` | Design exploration | Scout-harvested context, constitutional rules, stack-first constraints |
| `writing-plans` | Task breakdown | Mock policy per task, test strategy, evidence criteria |
| `test-driven-development` | RED-GREEN-REFACTOR | No-mock enforcement, stale test detection, scoped runs |
| `verification-before-completion` | Completeness check | Full suite unlocked, spec drift detection, evidence standards |
| `requesting-code-review` | Code quality review | Two-stage review (spec + quality), constitutional checklist, typed code-reviewer/spec-reviewer agent dispatch (tool-scoped, no file edits) |
| `systematic-debugging` | Structured debugging | Scout-harvested context, no phase prerequisite |
| `subagent-driven-development` | Per-task subagent execution | Typed implementer/spec-reviewer/code-reviewer dispatch via `sdd+`, enforcement rules in each agent's system prompt, signal-stack gating, team-mode parallel execution of independent tasks (experimental agent-teams) |
| `using-git-worktrees` | Workspace isolation | Config-gated, strategy-aware advisory (`rules.workflow`): rig recommends worktree vs branch from tree state and plan context |

Without wrapping, superpowers gives you generic process discipline. With
wrapping, every phase automatically carries your project's non-negotiables --
and the enforcement hooks make them programmatic (can't be talked around by the
agent).

## Scenario 1: Security-hardened brainstorming

A fintech project adds threat modeling as a mandatory design step inside `brain+`:

```markdown
---
name: brain+
description: "Wraps superpowers:brainstorming with threat modeling for fintech"
user-invocable: true
---

# brain+ — Security-Aware Design

Wraps `superpowers:brainstorming`. Requires superpowers to be installed.

## Before You Begin

This skill adds security threat modeling on top of the base brainstorming skill.

## Procedure

### Phase A: Harvest Context

1. Invoke the scout agent to map the codebase.
2. Read CLAUDE.md for constitutional rules.
3. Identify external interfaces, data flows, and trust boundaries.

### Phase B: Design (delegate to superpowers:brainstorming)

Invoke `superpowers:brainstorming` with the enriched context.

### Phase C: Threat Model (project-specific overlay)

1. For each external interface identified in the design:
   - [ ] Authentication mechanism defined
   - [ ] Authorization boundary documented
   - [ ] Input validation strategy specified
   - [ ] Audit logging requirement captured
2. Classify data sensitivity (PII, financial, health).
3. Identify trust boundaries between services.

## Skill Chain

After completing brain+, invoke `/plan+` to create the implementation plan.
```

**Benefit:** Every feature design automatically considers security surface area.
The agent can't skip the threat model because it's baked into the skill
procedure.

## Scenario 2: Compliance-aware planning

A healthcare project bakes HIPAA requirements into every plan task:

```markdown
## Phase B: Create Plan (delegate to superpowers:writing-plans)

For each task in the plan, add compliance checks:

- [ ] Does this task handle PHI?
  -> add encryption-at-rest and audit logging steps
- [ ] Does this task modify authentication?
  -> add regression test for auth flows
- [ ] Does this task introduce new external communication?
  -> add encryption-in-transit verification

## Constitutional Rules for This Plan

- All PHI access must be logged
- All external API calls must use mTLS
- No credentials in environment variables -- use vault integration
```

**Benefit:** Compliance isn't an afterthought checked at the end. It's
structural -- every plan task accounts for it from the start.

## Scenario 3: Performance-constrained TDD

An API project enforces latency budgets as first-class test assertions:

```markdown
---
name: tdd+
description: "Wraps superpowers:tdd with latency budget assertions"
user-invocable: true
---

# tdd+ -- Performance-Aware Implementation

Wraps `superpowers:test-driven-development`. Requires superpowers to be
installed.

## Procedure

### Phase B: Implement Each Task (delegate to superpowers:tdd)

**RED -- Write the failing test first:**

For API endpoints, include a latency assertion (in your test file):

    expect(responseTime).toBeLessThan(P95_BUDGET_MS);

For database queries, include a query count assertion:

    expect(queryCount).toBeLessThanOrEqual(MAX_QUERIES);

**GREEN -- Write minimal implementation:**

If the test fails due to latency, the implementation needs optimization, not
just correctness. Profile before optimizing -- show the flame graph or slow
query log.

## Skill Chain

After completing all plan tasks with tdd+, invoke `/verify+`.
```

**Benefit:** Performance is a test concern, not a post-implementation concern
discovered in staging.

## Scenario 4: Security review overlay

A project adds an OWASP/security checklist to the code review phase:

```markdown
## Phase C: Security Review (project-specific overlay)

1. For each changed file, check:
   - [ ] No hardcoded secrets (API keys, tokens, passwords)
   - [ ] No SQL string concatenation (parameterized queries only)
   - [ ] No `eval()`, `innerHTML`, or similar injection vectors
   - [ ] Error responses don't leak internal state
   - [ ] Rate limiting present on new endpoints
2. For new dependencies:
   - [ ] License compatible
   - [ ] No known critical CVEs
```

**Benefit:** Security review runs as a structured checklist with the same rigor
every time, not as a gut check that depends on who's reviewing.

## Scenario 5: Custom phase -- deploy+

A production project adds a deployment phase after `review+` with rollout gates:

```markdown
---
name: deploy+
description: "Invoke AFTER review+ passes. Deployment with verification gates."
user-invocable: true
---

# deploy+ -- Safe Deployment

## Phase A: Pre-Deployment Checks

1. Verify monitoring alerts are configured for new/changed endpoints
2. Verify feature flags exist for high-risk changes
3. Verify rollback procedure documented and tested

## Phase B: Deploy

1. Deploy to staging, run smoke tests
2. Deploy to production with canary (if available)
3. Monitor error rate dashboard for 5 minutes post-deploy

## Phase C: Post-Deployment Verification

1. [ ] Error rate below threshold
2. [ ] P95 latency within budget
3. [ ] No new alerts firing
4. [ ] Rollback procedure confirmed working
```

**Benefit:** Deployment is a structured process with verification gates, not
just `git push` and hope.

## Scenario 6: Wrapping unwrapped superpowers skills

Rig wraps eight superpowers skills out of the box (the table above). The rest
of the superpowers catalog is available for wrapping with project-specific
context:

### debug+ (wraps `superpowers:systematic-debugging`)

> Note: The built-in `/investigate` skill already wraps `superpowers:systematic-debugging`
> with scout context harvesting. Use `debug+` only if you need additional project-specific
> overlay beyond what `/investigate` provides.

```markdown
## Phase A: Gather Project Context

1. Load service topology from CLAUDE.md or docs/
2. Check recent deployments that may correlate with the issue
3. Pull relevant logs from the project's logging stack
4. Identify which components are involved (from architecture docs)

## Phase B: Debug (delegate to superpowers:systematic-debugging)

Use the 4-phase systematic process with project context.
```

### swarm+ (wraps `superpowers:dispatching-parallel-agents`)

```markdown
## Pre-dispatch

1. Load .harness.yaml for enforcement rules agents must follow
2. Assign constitutional rules to each agent's prompt
3. Define shared state coordination (session cache, file ownership)
```

### ship+ (wraps `superpowers:finishing-a-development-branch`)

```markdown
## Phase A: Pre-Merge Checks

1. Verify all plan tasks completed (cross-reference docs/plans/)
2. Verify no stale test violations
3. Verify constitutional compliance across all changed files
4. Confirm deployment runbook updated (if applicable)
```

## Wiring custom wrapped skills

After creating your SKILL.md file in `.claude/skills/<name>/`, two things
happen automatically:

1. The skill appears as `/<name>` in Claude Code
2. The skill procedure is followed exactly when invoked

If you want phase transitions enforced (e.g., `deploy+` requires `review+`),
add the transition rule to your project's phase tracking. See
[architecture.md](architecture.md) for the phase transition system.

If you want enforcement hooks to check your custom rules (e.g., the security
checklist in scenario 4), wire them into the PostToolUse pipeline. See
[extending.md](extending.md) for the enforcement check pattern.

## Related

- [extending.md](extending.md) -- custom enforcement checks, standalone skills,
  custom agents, and config rules
- [architecture.md](architecture.md) -- full system design, phase transitions,
  enforcement pipeline
- [getting-started.md](getting-started.md) -- installation and configuration

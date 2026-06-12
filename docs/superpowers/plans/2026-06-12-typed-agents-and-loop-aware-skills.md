# Typed Subagent Dispatch & Loop-Aware Skill Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three typed agent definitions (code-reviewer, spec-reviewer, implementer) plus an `sdd+` skill so rig dispatches named, tool-scoped subagents instead of general-purpose; encode the agent-loop/signal-stack operating model as an opt-in design vocabulary in brain+/plan+.

**Architecture:** All new behavior lives in `templates/` (agent definitions, one new skill, one reference doc) plus two small `src/` changes (phase tracker gains `sdd+`; init.ts installs the new files). Skill templates keep delegating to superpowers for process and add an explicit dispatch-override clause. Spec: `docs/superpowers/specs/2026-06-12-typed-agents-and-loop-aware-skills-design.md`.

**Tech Stack:** TypeScript, vitest, commander. Templates are markdown with `{{VAR}}` substitution (none needed in new files).

## Constitutional Rules for This Plan

Active enforcement (from `.harness.yaml`): `evidence_only: block`, `zero_defect.unrelated_errors: block`, `no_mocks: advise`, `conditional_assert: block`, `empty_test: block`, `stale_tests: advise`.

- Show command output before claiming any step done
- Every source change ships with test changes in the same task
- No conditional assertions, no empty test bodies

## Mock Policy

Stack/E2E (real deps): none involved — this is a CLI tool; tests use real fs in temp dirs.
Unit tests (mocks ok): none needed. Environment detection uses injectable `ExecFn` (existing convention, no mocks).

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/skills/phase-tracker.ts` | Modify | Add `sdd+` phase; widen `verify+` prerequisite |
| `templates/agents/code-reviewer.md` | Create | Full-role reviewer agent (read-only tools) |
| `templates/agents/spec-reviewer.md` | Create | Adversarial spec-compliance agent (read-only tools) |
| `templates/agents/implementer.md` | Create | Task-executor agent (all tools) |
| `templates/agents/scout.md` | Modify | Add `<!-- rig-generated -->` marker |
| `templates/skills/sdd-plus/SKILL.md` | Create | Wraps superpowers:subagent-driven-development with typed dispatch |
| `templates/references/agent-loops.md` | Create | Signal-stack / agent-loop design vocabulary |
| `src/cli/init.ts` | Modify | Install new agents, skill, and reference doc |
| `templates/skills/review-plus/SKILL.md` | Modify | Typed dispatch in Phases B and C |
| `templates/skills/brain-plus/SKILL.md` | Modify | Loop-fit elicitation + signal-first vocabulary |
| `templates/skills/plan-plus/SKILL.md` | Modify | Signal-stack-first plan ordering |
| `templates/skills/tdd-plus/SKILL.md` | Modify | Vocabulary generalization + gating-signal line |
| `templates/skills/verify-plus/SKILL.md` | Modify | Signal-stack verification line |
| `templates/skills/verify-harness/SKILL.md` | Modify | SK6 + AG3–AG8 checks; 35-point totals |
| `tests/skills/phase-tracker.test.ts` | Modify | sdd+ transition coverage |
| `tests/cli/init.test.ts` | Modify | New install assertions + agent marker-refresh tests |
| `tests/cli/template-content.test.ts` | Create | Content assertions on templates (dispatch syntax, tool scoping, markers, vocabulary) |
| `README.md`, `docs/getting-started.md`, `docs/architecture.md` | Modify | Tables, skill chain, checklist count |

---

### Task 1: Phase tracker gains `sdd+`

**Files:**
- Modify: `src/skills/phase-tracker.ts:1` (PHASE_ORDER) and `:27-30` (canTransitionTo)
- Test: `tests/skills/phase-tracker.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside the top-level `describe('SkillPhaseTracker')` block:

```typescript
  it('allows sdd+ as a free transition like tdd+', () => {
    tracker.setPhase('plan+');
    expect(tracker.canTransitionTo('sdd+')).toBe(true);
  });

  it('verify+ accepts a prior sdd+ visit', () => {
    tracker.setPhase('sdd+');
    expect(tracker.canTransitionTo('verify+')).toBe(true);
  });

  it('verify+ accepts a prior tdd+ visit', () => {
    tracker.setPhase('tdd+');
    expect(tracker.canTransitionTo('verify+')).toBe(true);
  });

  it('verify+ rejected without tdd+ or sdd+ visit', () => {
    tracker.setPhase('plan+');
    expect(tracker.canTransitionTo('verify+')).toBe(false);
  });

  it('includes sdd+ in phase order', () => {
    expect(tracker.getAllPhases()).toContain('sdd+');
  });
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run tests/skills/phase-tracker.test.ts`
Expected: FAIL — `Argument of type '"sdd+"' is not assignable to parameter of type 'SkillPhase'` (type error) or assertion failures.

- [ ] **Step 3: Implement**

In `src/skills/phase-tracker.ts`, change line 1:

```typescript
const PHASE_ORDER = ['brain+', 'plan+', 'tdd+', 'sdd+', 'verify+', 'review+', 'debug+'] as const;
```

And in `canTransitionTo`, change the verify+ branch:

```typescript
    // verify+ requires tdd+ or sdd+ to have been visited
    if (target === 'verify+') {
      return this.history.some(e => e.phase === 'tdd+' || e.phase === 'sdd+');
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/skills/phase-tracker.test.ts`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add src/skills/phase-tracker.ts tests/skills/phase-tracker.test.ts
git commit -m "feat: add sdd+ phase; verify+ accepts tdd+ or sdd+ visit"
```

---

### Task 2: Agent template — `code-reviewer.md`

**Files:**
- Create: `templates/agents/code-reviewer.md`
- Test: `tests/cli/template-content.test.ts` (new file)

- [ ] **Step 1: Write the failing tests**

Create `tests/cli/template-content.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const TEMPLATES = join(process.cwd(), 'templates');

function read(rel: string): string {
  return readFileSync(join(TEMPLATES, rel), 'utf-8');
}

describe('agent templates', () => {
  it('code-reviewer is read-only, marked, and explicit-dispatch', () => {
    const content = read('agents/code-reviewer.md');
    expect(content).toContain('<!-- rig-generated -->');
    expect(content).toContain('name: code-reviewer');
    expect(content).toContain('Do not invoke proactively');
    expect(content).toMatch(/tools: "[^"]+"/);
    expect(content).not.toMatch(/tools: "[^"]*Edit/);
    expect(content).not.toMatch(/tools: "[^"]*Write/);
    expect(content).toContain('complete diff');
    expect(content).toContain('.harness.yaml');
    expect(content).toContain('### Assessment');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/template-content.test.ts`
Expected: FAIL — `ENOENT ... templates/agents/code-reviewer.md`

- [ ] **Step 3: Create the template**

Create `templates/agents/code-reviewer.md` with exactly this content:

````markdown
---
name: code-reviewer
description: "Use when dispatched by review+ or sdd+ to review completed work against its plan or requirements. Reviews a git range for plan alignment and code quality. Do not invoke proactively — this agent is dispatched explicitly by the skill chain."
tools: "mcp__jcodemunch__get_repo_outline,mcp__jcodemunch__get_file_tree,mcp__jcodemunch__get_file_outline,mcp__jcodemunch__search_symbols,mcp__jcodemunch__get_symbol,mcp__jcodemunch__get_symbols,mcp__jcodemunch__search_text,mcp__jcodemunch__list_repos,mcp__graphify__query_graph,mcp__graphify__get_community,mcp__graphify__god_nodes,mcp__graphify__shortest_path,mcp__graphify__graph_stats,Read,Glob,Grep,Bash"
model: inherit
maxTurns: 25
---

<!-- rig-generated -->

# Code Reviewer Agent

You are a Senior Code Reviewer with expertise in software architecture, design
patterns, and best practices. Your job is to review completed work against its
plan or requirements and identify issues before they cascade into more work.

You cannot edit files. Fixes route back through the orchestrator to the
implementer. Your value is an accurate, specific, well-calibrated verdict.

## Dispatch Contract

The dispatching prompt provides: DESCRIPTION (what was built),
PLAN_OR_REQUIREMENTS (what it should do), BASE_SHA, HEAD_SHA. If any is
missing, ask for it before reviewing.

## Enforcement Overlay

Before reviewing, read `.harness.yaml` in the project root (and session-start
context if available) for active enforcement rules. Apply them as review
criteria — typically: real dependencies in stack/E2E tests (mocks appropriate
in unit tests), evidence-only claims, no conditional assertions, no empty
tests, source changes accompanied by test changes.

## Completeness Guard

You MUST read the complete diff before issuing a verdict:

```bash
git diff --stat BASE_SHA..HEAD_SHA
git diff BASE_SHA..HEAD_SHA
```

Review every changed file. If the review requires running tests, run them and
read the output. Never issue a verdict from the diffstat, the description, or
a partial read. Reviewing 2 of 9 files and approving is the single most common
reviewer failure — do not do it.

## What to Check

**Plan alignment:**
- Does the implementation match the plan / requirements?
- Are deviations justified improvements, or problematic departures?
- Is all planned functionality present?

**Code quality:**
- Clean separation of concerns?
- Proper error handling?
- Type safety where applicable?
- DRY without premature abstraction?
- Edge cases handled?

**Architecture:**
- Sound design decisions?
- Reasonable scalability and performance?
- Security concerns?
- Integrates cleanly with surrounding code?

**Testing:**
- Tests verify real behavior, not mocks?
- Edge cases covered?
- Integration tests where they matter?
- All tests passing?

**Production readiness:**
- Migration strategy if schema changed?
- Backward compatibility considered?
- Documentation complete?
- No obvious bugs?

## Calibration

Categorize issues by actual severity — not everything is Critical. Acknowledge
what was done well before listing issues; accurate praise helps the implementer
trust the rest of the feedback. If you find significant deviations from the
plan, flag them specifically so the implementer can confirm whether the
deviation was intentional. If you find issues with the plan itself rather than
the implementation, say so.

## Output Format

### Strengths
[What's well done? Be specific.]

### Issues

#### Critical (Must Fix)
[Bugs, security issues, data loss risks, broken functionality]

#### Important (Should Fix)
[Architecture problems, missing features, poor error handling, test gaps]

#### Minor (Nice to Have)
[Code style, optimization opportunities, documentation polish]

For each issue: file:line reference, what's wrong, why it matters, how to fix
(if not obvious).

### Recommendations
[Improvements for code quality, architecture, or process]

### Assessment

**Ready to merge?** [Yes | No | With fixes]

**Reasoning:** [1-2 sentence technical assessment]

## Critical Rules

**DO:** categorize by actual severity; be specific (file:line); explain WHY
each issue matters; acknowledge strengths; give a clear verdict.

**DON'T:** say "looks good" without checking; mark nitpicks as Critical; give
feedback on code you didn't read; be vague; avoid giving a clear verdict.
````

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli/template-content.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add templates/agents/code-reviewer.md tests/cli/template-content.test.ts
git commit -m "feat: add code-reviewer typed agent template"
```

---

### Task 3: Agent template — `spec-reviewer.md`

**Files:**
- Create: `templates/agents/spec-reviewer.md`
- Test: `tests/cli/template-content.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside `describe('agent templates')`:

```typescript
  it('spec-reviewer is read-only, adversarial, and explicit-dispatch', () => {
    const content = read('agents/spec-reviewer.md');
    expect(content).toContain('<!-- rig-generated -->');
    expect(content).toContain('name: spec-reviewer');
    expect(content).toContain('Do not invoke proactively');
    expect(content).not.toMatch(/tools: "[^"]*Edit/);
    expect(content).not.toMatch(/tools: "[^"]*Write/);
    expect(content).toContain('Do Not Trust the Report');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/template-content.test.ts`
Expected: FAIL — ENOENT on `templates/agents/spec-reviewer.md`

- [ ] **Step 3: Create the template**

Create `templates/agents/spec-reviewer.md` with exactly this content:

````markdown
---
name: spec-reviewer
description: "Use when dispatched by review+ or sdd+ to verify an implementation matches its specification — nothing more, nothing less. Do not invoke proactively — this agent is dispatched explicitly by the skill chain."
tools: "mcp__jcodemunch__get_repo_outline,mcp__jcodemunch__get_file_tree,mcp__jcodemunch__get_file_outline,mcp__jcodemunch__search_symbols,mcp__jcodemunch__get_symbol,mcp__jcodemunch__get_symbols,mcp__jcodemunch__search_text,mcp__jcodemunch__list_repos,mcp__graphify__query_graph,mcp__graphify__get_community,mcp__graphify__god_nodes,mcp__graphify__shortest_path,mcp__graphify__graph_stats,Read,Glob,Grep,Bash"
model: inherit
maxTurns: 15
---

<!-- rig-generated -->

# Spec Compliance Reviewer Agent

You verify whether an implementation matches its specification. You check what
was *requested* against what was *built* — nothing more, nothing less. You
cannot edit files; your output is a compliance verdict.

## Dispatch Contract

The dispatching prompt provides: the full task requirements (spec or plan task
text) and the implementer's report of what they built. If either is missing,
ask for it before reviewing.

## CRITICAL: Do Not Trust the Report

The implementer's report may be incomplete, inaccurate, or optimistic. You
MUST verify everything independently.

**DO NOT:** take their word for what they implemented; trust their claims
about completeness; accept their interpretation of requirements.

**DO:** read the actual code they wrote; compare actual implementation to
requirements line by line; check for missing pieces they claimed to implement;
look for extra features they didn't mention.

## What to Check

**Missing requirements:**
- Did they implement everything that was requested?
- Are there requirements they skipped or missed?
- Did they claim something works but didn't actually implement it?

**Extra/unneeded work:**
- Did they build things that weren't requested?
- Did they over-engineer or add unnecessary features?
- Did they add "nice to haves" that weren't in spec?

**Misunderstandings:**
- Did they interpret requirements differently than intended?
- Did they solve the wrong problem?
- Did they implement the right feature the wrong way?

## Enforcement Overlay

Read `.harness.yaml` in the project root for active enforcement rules and
verify the implementation honors them (test integrity, mock policy for
stack/E2E tests, evidence standards).

## Completeness Guard

You MUST read every file the implementer reports as changed (and check
`git diff` / `git show` for files they didn't mention) before issuing a
verdict. Verify by reading code, not by trusting the report.

## Output Format

Report exactly one of:

- ✅ **Spec compliant** — everything matches after code inspection
- ❌ **Issues found:** [list specifically what's missing, extra, or
  misunderstood, each with file:line references]
````

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli/template-content.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add templates/agents/spec-reviewer.md tests/cli/template-content.test.ts
git commit -m "feat: add spec-reviewer typed agent template"
```

---

### Task 4: Agent template — `implementer.md`

**Files:**
- Create: `templates/agents/implementer.md`
- Test: `tests/cli/template-content.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside `describe('agent templates')`:

```typescript
  it('implementer has full tools, marker, and evidence discipline', () => {
    const content = read('agents/implementer.md');
    expect(content).toContain('<!-- rig-generated -->');
    expect(content).toContain('name: implementer');
    expect(content).toContain('Do not invoke proactively');
    expect(content).not.toContain('tools:'); // omitted -> inherits all tools
    expect(content).toContain('show output before reporting');
    expect(content).toContain('BLOCKED');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/template-content.test.ts`
Expected: FAIL — ENOENT on `templates/agents/implementer.md`

- [ ] **Step 3: Create the template**

Create `templates/agents/implementer.md` with exactly this content:

````markdown
---
name: implementer
description: "Use when dispatched by sdd+ to implement a single plan task: write tests, implement, verify, commit, self-review, report. Do not invoke proactively — this agent is dispatched explicitly by the skill chain."
model: inherit
maxTurns: 50
---

<!-- rig-generated -->

# Implementer Agent

You implement exactly one task from an implementation plan. The dispatching
prompt provides the full task text, scene-setting context, and the working
directory. You do not inherit the orchestrator's conversation — everything you
need is in the dispatch prompt; if it isn't, ask.

## Before You Begin

If you have questions about the requirements or acceptance criteria, the
approach, dependencies or assumptions, or anything unclear in the task
description — **ask them now.** Raise concerns before starting work. While you
work: if you encounter something unexpected or unclear, ask. Don't guess or
make assumptions.

## Your Job

1. Implement exactly what the task specifies
2. Write tests (following TDD if the task says to: failing test first, verify
   it fails, minimal implementation, verify it passes)
3. Verify the implementation works — run the scoped tests and read the output
4. Commit your work
5. Self-review (below)
6. Report back

## Enforcement Overlay

Read `.harness.yaml` in the project root for active enforcement rules and
honor them: real dependencies in stack/E2E tests (mocks appropriate in unit
tests), no conditional assertions, no empty tests, evidence before claims.

## Code Organization

You reason best about code you can hold in context at once, and your edits are
more reliable when files are focused:
- Follow the file structure defined in the plan
- Each file should have one clear responsibility with a well-defined interface
- If a file you're creating grows beyond the plan's intent, stop and report
  DONE_WITH_CONCERNS — don't split files on your own without plan guidance
- In existing codebases, follow established patterns; improve code you're
  touching the way a good developer would, but don't restructure outside your
  task

## When You're in Over Your Head

It is always OK to stop and say "this is too hard for me." Bad work is worse
than no work; you will not be penalized for escalating.

**STOP and escalate when:** the task requires architectural decisions with
multiple valid approaches; you need understanding beyond what was provided and
can't find clarity; you're uncertain your approach is correct; the task
involves restructuring the plan didn't anticipate; you've been reading file
after file without progress.

**How:** report BLOCKED or NEEDS_CONTEXT with what you're stuck on, what you
tried, and what help you need.

## Before Reporting Back: Self-Review

**Completeness:** fully implemented everything in the task? missed
requirements? unhandled edge cases?
**Quality:** best work? names clear and accurate? clean and maintainable?
**Discipline:** avoided overbuilding (YAGNI)? only built what was requested?
followed existing patterns?
**Testing:** tests verify real behavior (not mock behavior)? followed TDD if
required? comprehensive?

Fix issues you find now, before reporting.

## Evidence Guard

You MUST run the task's scoped tests and show output before reporting
completion. A claim without command output is not a completed task. If the
plan defines a signal stack, the task's named gating signal is the completion
gate — run it.

## Report Format

- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- What you implemented (or attempted, if blocked)
- What you tested and test results (with output)
- Files changed
- Commit SHA
- Self-review findings (if any)
- Any issues or concerns

Use DONE_WITH_CONCERNS if you completed the work but have doubts. Never
silently produce work you're unsure about.
````

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli/template-content.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add templates/agents/implementer.md tests/cli/template-content.test.ts
git commit -m "feat: add implementer typed agent template"
```

---

### Task 5: Install agents via init; scout gets the marker

**Files:**
- Modify: `templates/agents/scout.md:8` (insert marker after frontmatter)
- Modify: `src/cli/init.ts:92` (agentFiles array)
- Test: `tests/cli/init.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/cli/init.test.ts`, after `it('creates scout agent definition')`:

```typescript
  it('creates typed agent definitions', async () => {
    await initCommand(tempDir, { force: false });
    expect(existsSync(join(tempDir, '.claude', 'agents', 'code-reviewer.md'))).toBe(true);
    expect(existsSync(join(tempDir, '.claude', 'agents', 'spec-reviewer.md'))).toBe(true);
    expect(existsSync(join(tempDir, '.claude', 'agents', 'implementer.md'))).toBe(true);
  });

  it('updates unmodified rig-installed agents without --force', async () => {
    await initCommand(tempDir, { force: false });
    const agentPath = join(tempDir, '.claude', 'agents', 'code-reviewer.md');
    writeFileSync(agentPath, '<!-- rig-generated -->\n# old agent content\n');
    await initCommand(tempDir, { force: false });
    const content = readFileSync(agentPath, 'utf-8');
    expect(content).toContain('Senior Code Reviewer');
  });

  it('preserves user-modified agent files without --force', async () => {
    await initCommand(tempDir, { force: false });
    const agentPath = join(tempDir, '.claude', 'agents', 'implementer.md');
    writeFileSync(agentPath, '# My custom implementer\n');
    await initCommand(tempDir, { force: false });
    expect(readFileSync(agentPath, 'utf-8')).toBe('# My custom implementer\n');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/cli/init.test.ts`
Expected: FAIL — the three new tests (agents not installed).

- [ ] **Step 3: Implement**

In `src/cli/init.ts`, change the agentFiles line:

```typescript
  const agentFiles = ['scout.md', 'code-reviewer.md', 'spec-reviewer.md', 'implementer.md'];
```

In `templates/agents/scout.md`, insert the marker after the frontmatter (line 8, before `# Scout Agent — Context Harvesting`):

```markdown
<!-- rig-generated -->
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/cli/init.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/init.ts templates/agents/scout.md tests/cli/init.test.ts
git commit -m "feat: install typed agents via rig init; scout gets rig-generated marker"
```

---

### Task 6: `sdd+` skill template + install

**Files:**
- Create: `templates/skills/sdd-plus/SKILL.md`
- Modify: `src/cli/init.ts:77` (skillDirs array)
- Test: `tests/cli/init.test.ts`, `tests/cli/template-content.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/cli/init.test.ts`, inside `it('creates skill directories from templates')`, add:

```typescript
    expect(existsSync(join(tempDir, '.claude', 'skills', 'sdd-plus', 'SKILL.md'))).toBe(true);
```

In `tests/cli/template-content.test.ts`, add a new describe:

```typescript
describe('skill templates — typed dispatch', () => {
  it('sdd-plus dispatches all three typed agents with fallback', () => {
    const content = read('skills/sdd-plus/SKILL.md');
    expect(content).toContain('Agent(subagent_type="implementer"');
    expect(content).toContain('Agent(subagent_type="spec-reviewer"');
    expect(content).toContain('Agent(subagent_type="code-reviewer"');
    expect(content).toContain('superpowers:subagent-driven-development');
    expect(content).toContain('fall back to a general-purpose');
    expect(content).toContain('signal stack');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/cli/init.test.ts tests/cli/template-content.test.ts`
Expected: FAIL — sdd-plus missing.

- [ ] **Step 3: Create the template and register it**

In `src/cli/init.ts`, change the skillDirs line:

```typescript
  const skillDirs = ['brain-plus', 'plan-plus', 'tdd-plus', 'sdd-plus', 'verify-plus', 'review-plus', 'debug-plus', 'verify-harness', 'savings', 'investigate'];
```

Create `templates/skills/sdd-plus/SKILL.md` with exactly this content:

````markdown
---
name: sdd+
description: "Invoke AFTER plan+ is approved, as an alternative to tdd+ for plans with independent tasks. Wraps superpowers:subagent-driven-development with typed agent dispatch: fresh implementer subagent per task, then spec-reviewer and code-reviewer subagents. Executes the whole plan without pausing between tasks."
argument-hint: "[plan file path]"
user-invocable: true
---

<!-- rig-generated -->

# sdd+ — Subagent-Driven Development

Wraps `superpowers:subagent-driven-development`. Requires superpowers to be
installed. Use `tdd+` instead when tasks are tightly coupled or the plan is
small — subagent execution costs more tokens and pays off on independent,
parallelizable tasks.

## Typed Dispatch Override

This project ships typed agent definitions in `.claude/agents/`. Where the
delegated superpowers skill instructs `Task tool with general-purpose type`,
instead dispatch the typed agent and pass only the per-task payload — the
role content lives in the agent definition:

- Implementation → `Agent(subagent_type="implementer", prompt=<full task text from plan + scene-setting context + working directory>)`
- Spec compliance review → `Agent(subagent_type="spec-reviewer", prompt=<task requirements + implementer's report>)`
- Code quality review → `Agent(subagent_type="code-reviewer", prompt=<DESCRIPTION + PLAN_OR_REQUIREMENTS + BASE_SHA + HEAD_SHA>)`

If a typed agent is unavailable (definition deleted), fall back to a
general-purpose subagent using the superpowers prompt template for that role.

## Procedure

### Phase A: Load Plan

1. Load the plan from `docs/plans/` or `docs/superpowers/plans/` (or the path
   given in arguments).
2. Load active enforcement rules from session context (see session-start
   output) — include them in every implementer dispatch prompt.
3. If the plan defines a signal stack, note each task's named gating signal:
   that signal is the task's completion gate, and the implementer dispatch
   prompt must say so.

### Phase B: Execute (delegate to superpowers:subagent-driven-development)

1. Invoke `superpowers:subagent-driven-development` with the loaded plan.
2. Per task, apply the Typed Dispatch Override above:
   implementer → spec-reviewer → code-reviewer.
3. Spec gaps or quality issues route back to a fresh implementer dispatch
   with the reviewer's findings included in the payload.
4. Do not pause between tasks. Stop only for BLOCKED you cannot resolve,
   genuine ambiguity, or plan completion.

### Phase C: Wrap Up

1. Confirm every plan task is committed and its checkboxes are complete.
2. Report per-task status (DONE / DONE_WITH_CONCERNS) with commit SHAs.

## Skill Chain

After completing sdd+, invoke `/verify+` for full-suite verification — the
phase tracker accepts the sdd+ path.

## Completion

- **DONE** — All plan tasks implemented, reviewed, and committed.
- **DONE_WITH_CONCERNS** — Plan complete; reviewer concerns noted for follow-up.
- **BLOCKED** — A task cannot proceed; details and attempted resolutions listed.
- **NEEDS_CONTEXT** — User input required to resolve ambiguity.
````

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/cli/init.test.ts tests/cli/template-content.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add templates/skills/sdd-plus/SKILL.md src/cli/init.ts tests/
git commit -m "feat: add sdd+ skill wrapping subagent-driven-development with typed dispatch"
```

---

### Task 7: `review+` dispatches typed reviewers

**Files:**
- Modify: `templates/skills/review-plus/SKILL.md` (Phases B and C)
- Test: `tests/cli/template-content.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside `describe('skill templates — typed dispatch')`:

```typescript
  it('review-plus dispatches spec-reviewer and code-reviewer', () => {
    const content = read('skills/review-plus/SKILL.md');
    expect(content).toContain('Agent(subagent_type="spec-reviewer"');
    expect(content).toContain('Agent(subagent_type="code-reviewer"');
    expect(content).toContain('fall back to a general-purpose');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/template-content.test.ts`
Expected: FAIL

- [ ] **Step 3: Edit the template**

In `templates/skills/review-plus/SKILL.md`, replace the Phase B intro (step 1, the four "Check:" bullets stay as the payload checklist) — change:

```markdown
### Phase B: Spec Compliance Review

1. For each task in the plan:
```

to:

```markdown
### Phase B: Spec Compliance Review

1. Dispatch the typed spec reviewer with the per-task payload (role content
   lives in the agent definition):

   ```
   Agent(subagent_type="spec-reviewer", prompt="Task requirements: [full task text from the plan]. Implementer's report: [what was claimed/committed for this task]. Verify the implementation matches the spec — nothing more, nothing less.")
   ```

   If the typed agent is unavailable, fall back to a general-purpose subagent
   using the superpowers spec-reviewer prompt template.

2. The spec reviewer verifies, for each task in the plan:
```

(Renumber the existing steps 2 and 3 of Phase B to 3 and 4.)

Replace Phase C step 1 — change:

```markdown
### Phase C: Code Quality Review (delegate to superpowers:requesting-code-review)

1. Invoke `superpowers:requesting-code-review` with the gathered context.
```

to:

```markdown
### Phase C: Code Quality Review (delegate to superpowers:requesting-code-review)

1. Invoke `superpowers:requesting-code-review` for process. Where it instructs
   `Task tool with general-purpose type`, instead dispatch the typed reviewer
   with only the per-task payload:

   ```
   Agent(subagent_type="code-reviewer", prompt="DESCRIPTION: [what was built]. PLAN_OR_REQUIREMENTS: [plan file path or task text]. BASE_SHA: [starting commit]. HEAD_SHA: [ending commit].")
   ```

   If the typed agent is unavailable, fall back to a general-purpose subagent
   using the superpowers code-reviewer prompt template.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli/template-content.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add templates/skills/review-plus/SKILL.md tests/cli/template-content.test.ts
git commit -m "feat: review+ dispatches typed spec-reviewer and code-reviewer agents"
```

---

### Task 8: Agent-loops reference doc + install to both skills

**Files:**
- Create: `templates/references/agent-loops.md`
- Modify: `src/cli/init.ts` (after the agentFiles block, ~line 98)
- Test: `tests/cli/init.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/cli/init.test.ts`:

```typescript
  it('installs agent-loops reference into brain-plus and plan-plus', async () => {
    await initCommand(tempDir, { force: false });
    expect(existsSync(join(tempDir, '.claude', 'skills', 'brain-plus', 'references', 'agent-loops.md'))).toBe(true);
    expect(existsSync(join(tempDir, '.claude', 'skills', 'plan-plus', 'references', 'agent-loops.md'))).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/init.test.ts`
Expected: FAIL

- [ ] **Step 3: Create the reference and install logic**

In `src/cli/init.ts`, after the agentFiles loop, add:

```typescript
  // Copy shared skill references (one source template, installed into each
  // consuming skill's references/ directory)
  const referenceInstalls: Array<{ file: string; skill: string }> = [
    { file: 'agent-loops.md', skill: 'brain-plus' },
    { file: 'agent-loops.md', skill: 'plan-plus' },
  ];
  for (const ref of referenceInstalls) {
    const src = join(TEMPLATES_DIR, 'references', ref.file);
    if (!existsSync(src)) continue;
    const destDir = join(claudeDir, 'skills', ref.skill, 'references');
    mkdirSync(destDir, { recursive: true });
    copyUserTemplate(src, join(destDir, ref.file), renderContext, options.force);
  }
```

Create `templates/references/agent-loops.md` with exactly this content:

````markdown
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
````

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli/init.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add templates/references/agent-loops.md src/cli/init.ts tests/cli/init.test.ts
git commit -m "feat: agent-loops signal-stack reference installed into brain+ and plan+"
```

---

### Task 9: `brain+` loop elicitation + signal-first vocabulary

**Files:**
- Modify: `templates/skills/brain-plus/SKILL.md`
- Test: `tests/cli/template-content.test.ts`

- [ ] **Step 1: Write the failing test**

Add a new describe in `tests/cli/template-content.test.ts`:

```typescript
describe('skill templates — loop-aware vocabulary', () => {
  it('brain-plus elicits the loop trajectory opt-in', () => {
    const content = read('skills/brain-plus/SKILL.md');
    expect(content).toContain('references/agent-loops.md');
    expect(content).toContain('Loop-fit assessment');
    expect(content).toContain('opt-in');
    expect(content).toContain('signal stack');
    expect(content).not.toContain('Stack-first design');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/template-content.test.ts`
Expected: FAIL

- [ ] **Step 3: Edit the template**

In `templates/skills/brain-plus/SKILL.md`:

(a) Change capability 2 in "Before You Begin":

```markdown
2. **Signal-first design** — considers which layers of the signal stack the feature touches, plus Docker/test infrastructure and full-loop verification (see `references/agent-loops.md`)
```

(b) In Phase B, replace step 2's heading line `2. During brainstorming, add these stack-first considerations:` and its bullets with:

```markdown
2. During brainstorming, add these signal-first considerations:
   - Which layers of the signal stack does this feature touch? (see `references/agent-loops.md` — deterministic logic, external contract, evaluation quality, integration, telemetry)
   - What instrumentation do those layers need? (Docker services, test harnesses, probes)
   - What are the full-loop assertions? (primary + second-order + third-order effects)
   - What test utilities need to exist before implementation?
   - Which components are protected from mocking (see active enforcement rules)?
```

(c) Add a new Phase B step 4 (after the positive-framing step 3):

```markdown
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
```

(d) In Phase C, replace the last checklist item `- [ ] Stack test user journey defined (if applicable)` with:

```markdown
   - [ ] Integration-layer (stack test) user journey defined (if applicable)
   - [ ] **If loop trajectory opted in:** signal stack defined for each applicable layer (signal + failure meaning); primary system operable with the loop disabled; autonomy ceiling and orchestrator-owned gates stated
```

(e) Update the frontmatter description:

```markdown
description: "Invoke BEFORE any design or feature work. Wraps superpowers:brainstorming with scout agent context harvesting, signal-first design considerations, opt-in agent-loop trajectory elicitation, and constitutional rule awareness. Asks questions one at a time to refine the design."
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli/template-content.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add templates/skills/brain-plus/SKILL.md tests/cli/template-content.test.ts
git commit -m "feat: brain+ loop-fit elicitation and signal-first vocabulary"
```

---

### Task 10: `plan+` signal-stack-first ordering

**Files:**
- Modify: `templates/skills/plan-plus/SKILL.md` (Phase B)
- Test: `tests/cli/template-content.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside `describe('skill templates — loop-aware vocabulary')`:

```typescript
  it('plan-plus orders signal-stack-first when design opted in', () => {
    const content = read('skills/plan-plus/SKILL.md');
    expect(content).toContain('references/agent-loops.md');
    expect(content).toContain('signal-stack-first');
    expect(content).toContain('gating signal');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/template-content.test.ts`
Expected: FAIL

- [ ] **Step 3: Edit the template**

In `templates/skills/plan-plus/SKILL.md`, Phase B, after step 3 (the task
pattern), add:

```markdown
4. **If the design includes a loop/signal-stack section** (see
   `references/agent-loops.md`): order the plan signal-stack-first — harness
   tasks (golden tests, contract probes, calibration harness, dry-run rig,
   telemetry store) come before or alongside the features they gate, because
   the assembly process uses the stack to verify itself as it builds. Then:
   - Each task names its **gating signal** (which layer's signal proves it done)
   - The maintainer deployment is a late task, after the primary system's
     acceptance criteria pass
   - Rollout gates (credentials, schedule enablement, live writes) are
     explicitly reserved to the user — never automated in any task
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli/template-content.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add templates/skills/plan-plus/SKILL.md tests/cli/template-content.test.ts
git commit -m "feat: plan+ signal-stack-first ordering for loop-opted designs"
```

---

### Task 11: `tdd+` / `verify+` vocabulary generalization

**Files:**
- Modify: `templates/skills/tdd-plus/SKILL.md` (description, line 18, Phase B)
- Modify: `templates/skills/verify-plus/SKILL.md` (line 78 area)
- Test: `tests/cli/template-content.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside `describe('skill templates — loop-aware vocabulary')`:

```typescript
  it('tdd-plus and verify-plus use signal-stack vocabulary', () => {
    const tdd = read('skills/tdd-plus/SKILL.md');
    expect(tdd).toContain('gating signal');
    expect(tdd).toContain('integration-layer');
    const verify = read('skills/verify-plus/SKILL.md');
    expect(verify).toContain('signal stack');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/template-content.test.ts`
Expected: FAIL

- [ ] **Step 3: Edit the templates**

`templates/skills/tdd-plus/SKILL.md`:

(a) Frontmatter description — replace `real-dependency enforcement for stack tests` with `real-dependency enforcement for stack/integration-layer tests`.

(b) Line 18 — replace `real dependencies in stack/E2E tests by default` with `real dependencies in stack/E2E (integration-layer) tests by default`.

(c) In Phase B, after the full-loop assertions bullet (line 43 area), add:

```markdown
   - If the plan defines a signal stack, each task's completion gate is its
     named gating signal — run that signal and show its output before marking
     the task done
```

`templates/skills/verify-plus/SKILL.md`, after the enforcement checklist line (line 78), add:

```markdown
   - [ ] If the design defines a signal stack: every applicable layer's signal was run, with each layer's result reported (pass / diff / drift / trace)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli/template-content.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add templates/skills/tdd-plus/SKILL.md templates/skills/verify-plus/SKILL.md tests/cli/template-content.test.ts
git commit -m "feat: generalize stack-test prose to signal-stack vocabulary in tdd+/verify+"
```

---

### Task 12: verify-harness checks for new agents and skill

**Files:**
- Modify: `templates/skills/verify-harness/SKILL.md`
- Modify: `docs/getting-started.md:123`
- Test: `tests/cli/template-content.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
  it('verify-harness covers the typed agents and sdd+', () => {
    const content = read('skills/verify-harness/SKILL.md');
    expect(content).toContain('**SK6**');
    expect(content).toContain('**AG8**');
    expect(content).toContain('Agent(subagent_type="code-reviewer")');
    expect(content).toContain('XX/35');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/template-content.test.ts`
Expected: FAIL

- [ ] **Step 3: Edit the templates**

In `templates/skills/verify-harness/SKILL.md`:

(a) Skills section — add after SK5:

```markdown
- [ ] **SK6**: `/sdd+` shows in skill list
```

(b) Agents section — add after AG2:

```markdown
- [ ] **AG3**: code-reviewer agent definition exists
- [ ] **AG4**: code-reviewer can be invoked with `Agent(subagent_type="code-reviewer")`
- [ ] **AG5**: spec-reviewer agent definition exists
- [ ] **AG6**: spec-reviewer can be invoked with `Agent(subagent_type="spec-reviewer")`
- [ ] **AG7**: implementer agent definition exists
- [ ] **AG8**: implementer can be invoked with `Agent(subagent_type="implementer")`
```

(c) Report format — change `Skills:         X/5 passed` to `Skills:         X/6 passed`, `Agents:         X/2 passed` to `Agents:         X/8 passed`, and `TOTAL: XX/28 passed` to `TOTAL: XX/35 passed`.

(d) In `docs/getting-started.md:123`, change `a 28-point checklist` to `a 35-point checklist`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli/template-content.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add templates/skills/verify-harness/SKILL.md docs/getting-started.md tests/cli/template-content.test.ts
git commit -m "feat: verify-harness checks typed agents and sdd+ (35-point checklist)"
```

---

### Task 13: Documentation

**Files:**
- Modify: `README.md` (high-level framing section, skill table, "What gets installed")
- Modify: `docs/getting-started.md` (generated-files table, skill list)
- Modify: `docs/architecture.md` (skill chain diagram, Layer 3, phase rules)
- Modify: `docs/skill-wrapping.md` (superpowers-vs-rig table rows)

- [ ] **Step 0: README.md — high-level "Rig vs plain superpowers" framing**

This is the headline distinction of the release: what running superpowers
*through rig* gets you over running superpowers alone. Insert a new section
immediately after the "What it does" section:

```markdown
## Rig vs plain superpowers

[superpowers](https://github.com/obra/superpowers) provides the process
discipline: brainstorming, planning, TDD, verification, review. Rig keeps all
of it — every chain skill delegates to its superpowers counterpart — and
upgrades the three places where process text alone can't reach:

| | plain superpowers | superpowers through rig |
| --- | --- | --- |
| **Enforcement** | Persuasive skill text the agent can rationalize around | PreToolUse/PostToolUse hooks that programmatically block or advise (`.harness.yaml`) |
| **Subagents** | Every implementer and reviewer dispatched as a general-purpose agent; role and discipline ride inside the prompt | Typed agents in `.claude/agents/`: tool-scoped (reviewers physically cannot edit files), enforcement rules in their system prompt, named in the UI, per-agent turn budgets |
| **Trajectory** | The skill chain ends at merge | Opt-in agent-loop trajectory: `brain+`/`plan+` can design a layered signal stack so the system self-assembles gate-by-gate and hands off to an always-on maintainer agent |

The result: the same superpowers workflows, but the review chain is
structural instead of persuasive, and projects that fit can graduate from
"built and merged" to "self-assembling and self-maintaining".
```

- [ ] **Step 1: README.md — tables and bullets**

(a) Skill table — add after the `tdd+` row:

```markdown
| `sdd+` | Subagent-driven plan execution (typed implementer/reviewer agents) | `superpowers:subagent-driven-development` |
```

(b) "What gets installed" tree — under `skills/`, add `sdd-plus/          # sdd+ skill (typed subagent execution)`; under `agents/`, replace the single `scout.md` line with:

```
  agents/
    scout.md             # Cross-repo scout agent
    code-reviewer.md     # Typed code-quality reviewer (read-only)
    spec-reviewer.md     # Typed spec-compliance reviewer (read-only)
    implementer.md       # Typed task implementer
```

(c) In "What it does", extend the Skill Chain bullet: after `plus standalone investigate and savings`, append `, and sdd+ for subagent-driven plan execution via typed agents (code-reviewer, spec-reviewer, implementer) installed into .claude/agents/`.

- [ ] **Step 2: docs/getting-started.md**

(a) Generated-files table — add rows after the `verify-plus` row:

```markdown
| `.claude/skills/sdd-plus/` | Subagent-driven plan execution with typed agents |
| `.claude/agents/code-reviewer.md` | Typed code-quality reviewer (read-only tools) |
| `.claude/agents/spec-reviewer.md` | Typed spec-compliance reviewer (read-only tools) |
| `.claude/agents/implementer.md` | Typed task implementer |
```

(b) Skill-command list — add after `/tdd+`:

```
/sdd+      -> Execute a plan via typed subagents (implementer -> spec-reviewer -> code-reviewer)
```

(c) After the "Skills enforce ordering" paragraph, append: `/sdd+ is an alternative to /tdd+ for plans with independent tasks; /verify+ accepts either path. During /brain+, projects that fit the agent-loop pattern are offered an opt-in signal-stack trajectory (see the agent-loops reference installed into brain-plus/references/).`

- [ ] **Step 3: docs/architecture.md**

(a) Skill chain diagram line `|  brain+ -> plan+ -> tdd+ -> verify+ -> rev+ |` — change to `|  brain+ -> plan+ -> tdd+|sdd+ -> verify+ -> rev+ |`.

(b) Layer 3 phase-transition rules list — change `- verify+ requires a prior tdd+ visit` to `- verify+ requires a prior tdd+ or sdd+ visit`, and add `- sdd+ is a peer of tdd+ (free transition; executes plans via typed subagents: implementer, spec-reviewer, code-reviewer from .claude/agents/)`.

(c) In the Layer 3 "Standalone skills" section, add a paragraph:

```markdown
`sdd+` wraps `superpowers:subagent-driven-development` with typed agent
dispatch: a fresh `implementer` subagent per plan task, followed by
`spec-reviewer` and `code-reviewer` subagents. Typed definitions live in
`.claude/agents/` (installed by `rig init`) and carry tool restrictions —
reviewers cannot edit files. Where the wrapped superpowers skill says
"general-purpose", the rig skill dispatches the typed agent with payload-only
prompts, falling back to general-purpose if the definition is missing.
`brain+` and `plan+` load `references/agent-loops.md` for the opt-in
signal-stack / maintainer-loop trajectory.
```

- [ ] **Step 3b: docs/skill-wrapping.md**

In the "What superpowers provides vs what rig adds" table, update the
`requesting-code-review` row's "Rig overlay adds" cell to end with
`, typed code-reviewer/spec-reviewer agent dispatch (tool-scoped, no file edits)`,
and add after the `systematic-debugging` row:

```markdown
| `subagent-driven-development` | Per-task subagent execution | Typed implementer/spec-reviewer/code-reviewer dispatch via `sdd+`, enforcement rules in each agent's system prompt, signal-stack gating |
```

- [ ] **Step 4: Verify docs lint passes**

Run: `npm run lint` and the docs workflow check if available locally (`ls .github/workflows/docs.yml` to see what it runs; typically a link/format check).
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/getting-started.md docs/architecture.md
git commit -m "docs: typed agents, sdd+, and loop-aware skill chain"
```

---

### Task 14: Full verification + dogfood re-init

**Files:** none new

- [ ] **Step 1: Full test suite with coverage**

Run: `npm test`
Expected: all tests pass (1100+ plus new), coverage ≥80% statements/functions/lines, ≥75% branches.

- [ ] **Step 2: Type check**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 3: Build and refresh the dogfood install**

Run: `npm run build && rig init`
Expected: `.claude/agents/` gains code-reviewer.md, spec-reviewer.md, implementer.md; `.claude/skills/sdd-plus/` and both `references/agent-loops.md` copies appear; existing rig-generated skills refresh (marker semantics).

- [ ] **Step 4: Verify installed files**

Run: `ls .claude/agents/ .claude/skills/sdd-plus/ .claude/skills/brain-plus/references/ .claude/skills/plan-plus/references/`
Expected: all new files present.

- [ ] **Step 5: Commit dogfood updates**

```bash
git add .claude/
git commit -m "chore: dogfood re-init with typed agents and loop-aware skills"
```

---

## Verification (overall)

Maps to spec §14 acceptance criteria:

1. Init installs 4 agents + 10 skills + 2 reference copies (Tasks 5, 6, 8; tests in init.test.ts)
2. verify-harness 35-point checklist (Task 12)
3. review+ typed dispatch, tool-restricted reviewers (Tasks 2, 3, 7)
4. sdd+ → verify+ path (Tasks 1, 6)
5. brain+ opt-in elicitation with conditional checklist (Task 9)
6. Suite + coverage + docs lint green (Task 14)

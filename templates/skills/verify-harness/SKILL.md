---
name: verify-harness
description: "Run after `rig init` to verify all hooks, skills, and agents are installed and working correctly in the live session."
user-invocable: true
---

<!-- rig-generated -->

# verify-harness — Post-Install Verification

Run this skill after `rig init` to confirm everything is working.

## Procedure

Run each check and report PASS/FAIL with evidence.

### Session Start Hook

- [ ] **S1**: Session started without hook errors
- [ ] **S2**: Run `which rtk` — report if available
- [ ] **S3**: Run `which jcodemunch-mcp` (or `which uvx`) — report if available
- [ ] **S4**: Check if CWD is indexed: run `jcodemunch-mcp list-repos` if available
- [ ] **S5**: Check `.harness.yaml` exists and parses

### Tool Router (PreToolUse Hook)

- [ ] **TR1**: Run `grep -r test .` in a test call — does the hook intercept it?
- [ ] **TR2**: Run `find . -name '*.ts'` — does the hook intercept it?
- [ ] **TR3**: Run `sed -i 's/old/new/g' file` — does the hook BLOCK it?
- [ ] **TR4**: Run `git status` — does the hook advise rtk (if available)?
- [ ] **TR5**: Run `Read` on a specific file — does it pass through?
- [ ] **TR6**: Run `Grep` tool — does it advise jcodemunch (if indexed)?
- [ ] **TR7**: Run `Glob` tool — does it advise jcodemunch (if indexed)?
- [ ] **TR8**: Reference an external directory — does it trigger auto-index?

### Enforcement (PostToolUse Hook)

- [ ] **E1**: Edit a source file — does it warn about missing test update?
- [ ] **E2**: Write a test with `jest.mock()` — does constitutional check fire?
- [ ] **E3**: Run a test that fails — does zero-defect check fire?
- [ ] **E4**: Edit source without test — does stale test warning appear?
- [ ] **E5**: During tdd+ phase, run full suite — does scope redirect fire?
- [ ] **E6**: During verify+ phase, run full suite — is it allowed?

### Skills

- [ ] **SK1**: `/brain+` shows in skill list
- [ ] **SK2**: `/plan+` shows in skill list
- [ ] **SK3**: `/tdd+` shows in skill list
- [ ] **SK4**: `/verify+` shows in skill list
- [ ] **SK5**: `/review+` shows in skill list
- [ ] **SK6**: `/sdd+` shows in skill list

### Agents

- [ ] **AG1**: Scout agent definition exists
- [ ] **AG2**: Scout can be invoked with `Agent(subagent_type="scout")`
- [ ] **AG3**: code-reviewer agent definition exists
- [ ] **AG4**: code-reviewer can be invoked with `Agent(subagent_type="code-reviewer")`
- [ ] **AG5**: spec-reviewer agent definition exists
- [ ] **AG6**: spec-reviewer can be invoked with `Agent(subagent_type="spec-reviewer")`
- [ ] **AG7**: implementer agent definition exists
- [ ] **AG8**: implementer can be invoked with `Agent(subagent_type="implementer")`
- [ ] **AG9**: During `sdd+`/`review+`, an `Agent` dispatch with `subagent_type: "general-purpose"` is steered to a typed agent (`rules.workflow.typed_agent_enforcement`)

### Configuration

- [ ] **CF1**: Change a rule in `.harness.yaml` — does behavior change?
- [ ] **CF2**: Default config was generated correctly

## Report Format

```
Session Verification Report
============================
Session Start:  X/5 passed
Tool Router:    X/8 passed
Enforcement:    X/6 passed
Skills:         X/6 passed
Agents:         X/9 passed
Configuration:  X/2 passed

TOTAL: XX/36 passed

Failures:
- [ID]: [what happened]. Expected: [expected]. Got: [actual].
  Remediation: [how to fix]
```

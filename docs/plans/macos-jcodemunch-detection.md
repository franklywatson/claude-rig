# Plan: macOS jcodemunch Detection + Advisory Suppression Fixes

**Date:** 2026-05-15
**Status:** Approved — ready for tdd+

## Problem Statement

On macOS, rig produces 0 jcodemunch queries and the debug+ skill rarely self-invokes. Root causes
identified via debug+ investigation in a live session against the forgd-onboarding project.

## Root Causes

| # | Severity | Root Cause | Impact |
| - | -------- | ---------- | ------ |
| 1 | Critical | `detectJcodemunch()` tries `which jcodemunch` then `which jcodemunch-mcp`. macOS installs via `uvx jcodemunch-mcp` — binary not in PATH. Both `which` fail → `jcodemunchAvailable: false` | Tool router never advises jcodemunch. 0 queries. |
| 2 | Minor | `resolveJcodemunchRepos` uses `r.endsWith(folderName)` | Wrong `jcodemunchCwdIndexed` state. |
| 3 | Design | First-occurrence advisory suppression: each intent type gets one advisory per session. | Agents revert to native tools after first miss. |
| 4 | Missing | No eval tests for debug+ skill trigger phrases. | debug+ underused; scout context harvesting skipped. |

## Platform Context

This distinction must be reflected in code comments and test names:

- **Linux (direct binary):** `pip install jcodemunch-mcp` / `pipx install jcodemunch-mcp` → binary
  lands in `~/.local/bin/jcodemunch-mcp` which IS in PATH → `which jcodemunch-mcp` succeeds →
  existing `detectJcodemunchMcp` path works. **Not broken on Linux.**
- **macOS (uvx-managed):** `uvx jcodemunch-mcp` is Claude Code's recommended install →
  uvx manages a cached Python env → binary NOT in PATH → `which jcodemunch-mcp` fails →
  needs new uvx detection path.
- **uvx on Linux:** Same as macOS case — users who install via uvx instead of pip/pipx hit this.
  The fix is not macOS-exclusive; it's uvx-install-exclusive.

## Constitutional Rules for This Plan

- No mocks for environment detection — use injectable `ExecFn` (project convention)
- Evidence criteria: all 1029+ existing tests pass, all new tests green
- Every source change has corresponding test additions
- Show test output before claiming done

## Mock Policy

- Unit/integration tests: injectable `ExecFn` stubs `which uvx` and `uvx jcodemunch-mcp` stdio
  calls — no real uvx invoked during test runs
- Existing integration tests (real `npx tsx` subprocess): unaffected

---

## Tasks

### Task 1: Fix endsWith → exact basename matching

**Why first:** `resolveJcodemunchRepos` is shared by all detection paths including the new uvx
path. Fix correctness before adding more callers.

**Files:** `src/session/environment.ts` (line 213)

**Test strategy:** `tests/session/environment.test.ts` — 2 new tests

```
// Platform-agnostic correctness (not OS-specific)
- "basename match: CWD my-rig does NOT match repo local/rig (endsWith false-positive)"
- "basename match: CWD rig DOES match repo local/rig (exact match preserved)"
```

**Steps:**

- [ ] Write failing test: `my-rig` must not match `local/rig`
- [ ] Verify red
- [ ] Change `repos.find(r => r.endsWith(folderName))` → `repos.find(r => r.split('/').pop() === folderName)`
- [ ] Verify green
- [ ] Verify existing tests unaffected

---

### Task 2: Add uvx jcodemunch detection fallback

**Files:** `src/session/environment.ts`

**Test strategy:** `tests/session/environment.test.ts` — 5 new tests (names explicitly call out
platform/install-method context):

```
// macOS/uvx-install path (new)
- "macOS/uvx: detects jcodemunch when binary not in PATH but uvx available and CWD is indexed"
- "macOS/uvx: marks jcodemunchAvailable=true but cwdIndexed=false when uvx runs but CWD not in repo list"
- "macOS/uvx: marks jcodemunchAvailable=false when uvx is not installed (which uvx fails)"
- "macOS/uvx: handles uvx jcodemunch-mcp startup failure gracefully (exit nonzero / timeout)"

// Linux/direct-binary regression guard
- "Linux/direct-binary: existing which jcodemunch-mcp path still wins when binary is in PATH"
```

**Implementation:**

Add `queryJcodemunchViaUvx(exec)` — pipes JSON-RPC init+ready+list_repos to
`uvx jcodemunch-mcp 2>/dev/null`, 15s timeout (uvx may resolve package on first run).

Add `detectJcodemunchViaUvx(cwd, exec)` — parses MCP JSON-RPC response same format as
`detectJcodemunchMcp`, calls `resolveJcodemunchRepos`. Returns `available: false` (not `true`)
when uvx runs but returns no parseable output.

In `detectJcodemunch()`, add 3rd try/catch after MCP-binary path:

```typescript
// macOS/uvx install: jcodemunch-mcp is managed by uvx and not in PATH.
// Claude Code's recommended install (command: "uvx", args: ["jcodemunch-mcp"])
// works but `which jcodemunch-mcp` fails. Try piping JSON-RPC via uvx directly.
// This also applies to Linux users who install via uvx instead of pip/pipx.
try {
  exec('which uvx');
  return detectJcodemunchViaUvx(cwd, exec);
} catch {
  // uvx not available
}
return { available: false, cwdIndexed: false, cwdRepo: null, knownRepos: [] };
```

**Steps:**

- [ ] Write 5 failing tests (all red)
- [ ] Implement `queryJcodemunchViaUvx` and `detectJcodemunchViaUvx`
- [ ] Wire into `detectJcodemunch`
- [ ] Verify all 5 new tests green; verify existing 1029 unaffected

---

### Task 3: Add debug+ skill trigger eval tests

**Files:** NEW `tests/eval/debug-skill-eval.test.ts`, update `templates/skills/debug-plus/SKILL.md`

**Test strategy:** New eval file verifying skill description and trigger-phrase breadth:

```
- "debug+ description covers core trigger concepts: bug, failure, unexpected, diagnose"
- "debug+ argument-hint covers error/failure terminology, not just investigation phrasing"
- "debug+ body explicitly references debug/fix/broken as triggers alongside investigate"
- "debug+ skill is distinct from investigate alias (investigate is a redirect, debug+ is the skill)"
- "debug+ trigger phrase coverage: at least 8 of 12 canonical debugging phrases match description"
```

**SKILL.md changes:**

- Update `description` to cover: debugging, fixing bugs, diagnosing failures, broken/unexpected
- Update `argument-hint` to: `"[bug description, error output, or what is broken]"`

**Steps:**

- [ ] Write failing tests (red — old description won't cover all phrases)
- [ ] Update SKILL.md description and argument-hint
- [ ] Verify green
- [ ] Verify skill-definitions.test.ts (existing) still passes

---

### Task 4: Remove cwd_path_expand advisory

**Status: DONE** — removed in this session. All associated tests deleted.

**Rationale:** Claude Code v2.1.97 made absolute path usage unconditional across agent threads
and ReadFile. The `cwd_path_expand` advisory actively conflicted with this deliberate Anthropic
design decision. Three recent commits (0.3.6–0.3.8) had been iteratively patching detection
edge cases — a signal the advisory was fighting the agent's natural behavior.

---

### Task 5: Add `--broad-permissions` install flag

**Files:** `src/cli/init.ts`, `src/cli/permissions.ts`, `docs/getting-started.md`,
`docs/architecture.md`, `README.md`

**Problem:** When agents use absolute paths (required by Claude Code system prompt), common
read-only shell operations trigger permission prompts for each new path pattern.

**Design:** Add `--broad-permissions` flag to `rig init`. Without the flag, only the
secret-file deny list is written. With the flag, all allow permissions are added.

**Permissions added by `--broad-permissions`:**

```json
"mcp__jcodemunch__*", "mcp__graphify__*",
"Bash(cat /tmp/rig-session-*)", "Bash(ls /tmp/rig-session-*)",
"Read(/tmp/rig-session-*.json)", "Read(/private/tmp/rig-session-*.json)",
"Bash(npx:*)", "Bash(rtk:*)" (when rtk detected),
"Bash(ls:*)", "Bash(cat:*)", "Bash(grep:*)", "Bash(find:*)",
"Bash(which:*)", "Bash(node:*)", "Bash(npm:*)"
```

**Test strategy:** `tests/cli/init.test.ts` — 8 new/updated tests covering default-adds-nothing,
deny-list-always-on, each permission group, idempotency, user-permissions preservation.

**Docs:**

- `docs/getting-started.md`: add "Reducing permission prompts" section
- `README.md`: update Quick start and Permissions section
- `docs/architecture.md`: document absolute-path/permission-prompt finding in Known Limitations

**Steps:**

- [ ] Write failing tests
- [ ] Implement `--broad-permissions` in `initCommand()` and `src/cli/index.ts`
- [ ] Update docs
- [ ] Verify all tests green

---

### Task 6: Document advisory suppression as known limitation

**Files:** `docs/architecture.md` — Known Limitations section

**Finding:**

First-occurrence advisory suppression (`hasAdvised()`) means each intent type gets one advisory
per session. If the agent ignores or misses the first advisory, rig goes silent for that intent.
Tracked for future work: periodic re-advisory or escalating urgency.

- [ ] Add paragraph to Known Limitations in `docs/architecture.md`

---

## Plan Validation

- [x] Every task has a test strategy
- [x] Platform context (macOS/uvx vs Linux/direct-binary) explicit in test names and code comments
- [x] No task mocks a protected component
- [x] Exact file paths (no TBDs)
- [x] Evidence criteria: 1029+ tests pass, new tests green
- [x] Task ordering: 1 (endsWith fix) → 2 (uvx detection) → 3 (debug+ eval) → 4 (docs)

# Plan: macOS jcodemunch Detection + Advisory Suppression Fixes

**Date:** 2026-05-15  
**Status:** Approved — ready for tdd+

## Problem Statement

On macOS, rig produces 0 jcodemunch queries and the debug+ skill rarely self-invokes. Root causes
identified via debug+ investigation in a live session against the forgd-onboarding project.

## Root Causes

| # | Severity | Root Cause | Impact |
|---|----------|-----------|--------|
| 1 | Critical | `detectJcodemunch()` tries `which jcodemunch` then `which jcodemunch-mcp`. macOS installs via `uvx jcodemunch-mcp` — binary not in PATH. Both `which` fail → `jcodemunchAvailable: false` | Tool router never advises jcodemunch. 0 queries. |
| 2 | Minor | `resolveJcodemunchRepos` uses `r.endsWith(folderName)` — CWD `/x/my-rig` (basename `my-rig`) false-matches repo `local/rig` | Wrong `jcodemunchCwdIndexed` state. Incorrect advisories pointing to wrong repo. |
| 3 | Design | First-occurrence advisory suppression: each intent type gets one advisory per session. Agent ignores it → never reminded. Affects `jcodemunch`, `cwd_path_expand`, all advise-mode intents. | Agents revert to default (absolute paths, native Read) after first miss. Rig goes quiet. |
| 4 | Missing | No eval tests for debug+ skill trigger phrases. "investigate" reliably triggers but "debug", "fix bug", "what's wrong" do not surface the skill reliably. | debug+ underused; scout context harvesting skipped for debugging scenarios. |

## Platform Context

This distinction must be reflected in code comments and test names:

- **Linux (direct binary):** `pip install jcodemunch-mcp` / `pipx install jcodemunch-mcp` → binary
  lands in `~/.local/bin/jcodemunch-mcp` which IS in PATH → `which jcodemunch-mcp` succeeds →
  existing `detectJcodemunchMcp` path works. **Not broken on Linux.**
- **macOS (uvx-managed):** `uvx jcodemunch-mcp` is Claude Code's recommended install →
  uvx manages a cached Python env → binary NOT in PATH → `which jcodemunch-mcp` fails →
  needs new uvx detection path.
- **uvx on Linux:** Same as macOS case — users who install via uvx on Linux also hit this.
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
- "basename match: CWD my-rig does NOT match repo local/rig (endsWith false-positive, platform-agnostic)"
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
- "macOS/uvx: detects jcodemunch when binary not in PATH but uvx is available and CWD is indexed"
- "macOS/uvx: marks jcodemunchAvailable=true but cwdIndexed=false when uvx runs but CWD not in repo list"
- "macOS/uvx: marks jcodemunchAvailable=false when uvx is not installed (which uvx fails)"
- "macOS/uvx: handles uvx jcodemunch-mcp startup failure gracefully (exit nonzero / timeout)"

// Linux/direct-binary regression guard
- "Linux/direct-binary: existing which jcodemunch-mcp path still wins when binary is in PATH — uvx fallback not reached"
```

**Implementation:**

Add `queryJcodemunchViaUvx(exec)` — pipes JSON-RPC init+ready+list_repos to
`uvx jcodemunch-mcp 2>/dev/null`, 15s timeout (uvx may resolve package on first run).

Add `detectJcodemunchViaUvx(cwd, exec)` — parses MCP JSON-RPC response same format as
`detectJcodemunchMcp`, calls `resolveJcodemunchRepos`. Returns `available: false` (not `true`)
when uvx runs but returns no parseable output — uvx not having the package is not "available".

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
- "debug+ trigger phrase coverage: at least 8 of 12 canonical debugging phrases match description vocabulary"
```

Canonical phrases to test coverage against:
`["debug this", "fix this bug", "there is a bug", "why is this failing", "what is wrong with",
"test failure", "unexpected behavior", "something is broken", "trace the issue",
"diagnose the problem", "figure out why", "investigate this"]`

**SKILL.md changes:**
- Update `description` to: `"Invoke when debugging, fixing bugs, diagnosing failures, or when something is broken or not working as expected. Wraps superpowers:systematic-debugging with mandatory scout context harvesting."`
- Update `argument-hint` to: `"[bug description, error output, or what is broken]"`

**Steps:**
- [ ] Write failing tests (red — old description won't cover all phrases)
- [ ] Update SKILL.md description and argument-hint
- [ ] Verify green
- [ ] Verify skill-definitions.test.ts (existing) still passes

---

### Task 4: Remove cwd_path_expand advisory

**Status: DONE** — removed in this session. All associated tests deleted. Finding documented in commit message.

**Rationale:** Claude Code v2.1.97 made absolute path usage unconditional across agent threads and ReadFile. The `cwd_path_expand` advisory actively conflicted with this deliberate Anthropic design decision (absolute paths prevent `cd`-related permission prompt issues and eliminate path ambiguity). Three recent commits (0.3.6–0.3.8) had been iteratively patching detection edge cases — a signal the advisory was fighting the agent's natural behavior rather than correcting a bug.

---

### Task 5: Add `--broad-permissions` install flag

**Files:** `src/cli/init.ts`, `src/cli/templates/settings.json` (or equivalent), `docs/getting-started.md`, `docs/architecture.md`, `README.md`

**Problem:** When agents use absolute paths (as required by Claude Code system prompt), common read-only shell operations (`ls`, `cat`, `grep`, `find`, `which`, `node`, `npm`) trigger permission prompts for each new path pattern. Users see more approval dialogs when rig is installed vs not. This is friction that should be opt-in to eliminate.

**Design:** Add `--broad-permissions` flag to `rig init`. When set, appends pre-authorization entries to `.claude/settings.json` for common read-only operations. Without the flag, the current minimal permission set is preserved (no behavior change for existing installs).

**Permissions added by `--broad-permissions`:**
```json
"Bash(ls:*)",
"Bash(cat:*)",
"Bash(grep:*)",
"Bash(find:*)",
"Bash(which:*)",
"Bash(node:*)",
"Bash(npm:*)",
"Bash(npx:*)"
```

Note: `Bash(npx:*)` and `Bash(rtk:*)` are already added by default init. The `--broad-permissions` flag extends beyond these to cover all common read-only ops that absolute paths will hit.

**Test strategy:** `tests/cli/init.test.ts` — 3 new tests:
- `--broad-permissions flag adds broad bash permission entries to settings.json`
- `default init (no flag) does not add broad bash permissions`
- `--broad-permissions is idempotent on re-init (no duplicates)`

**Docs:**
- `docs/getting-started.md`: add section "Reducing permission prompts" explaining why and when to use `--broad-permissions`
- `README.md`: mention `--broad-permissions` in Quick start and in the permissions section
- `docs/architecture.md`: note that Claude Code's absolute-path requirement means Bash permission prompts fire per-path-pattern; `--broad-permissions` pre-authorizes common read-only ops

**Steps:**
- [ ] Write 3 failing tests
- [ ] Implement `--broad-permissions` in `initCommand()`
- [ ] Update settings template/merge logic to support broad permissions block
- [ ] Update docs (getting-started.md, README.md, architecture.md)
- [ ] Verify all tests green

---

### Task 6 (was Task 4): Document advisory suppression as known limitation

**Files:** `docs/architecture.md` — Known Limitations section

**Note:** Fixing the suppression itself is out of scope for this plan (requires design work on
"remind after N tool calls" semantics). The immediate fix is ensuring the first advisory is
accurate (Tasks 1+2 ensure jcodemunch advisories actually fire when they should).

**Finding to document:**

> First-occurrence advisory suppression (`hasAdvised()`) means each intent type gets one advisory
> per session. If the agent ignores or misses the first advisory, rig goes silent for that intent.
> Affects: `cwd_path_expand` (agent reverts to absolute paths), `jcodemunch` advisories (agent
> uses native Read after first miss). The system prompt default ("use absolute paths") actively
> conflicts with `cwd_path_expand` advisory — this suppression amplifies the conflict.
> Tracked for future work: periodic re-advisory (e.g., every 10 tool calls) or escalating urgency.

- [ ] Add paragraph to Known Limitations in `docs/architecture.md`

---

## Plan Validation

- [x] Every task has a test strategy
- [x] Platform context (macOS/uvx vs Linux/direct-binary) explicit in test names and code comments
- [x] No task mocks a protected component
- [x] Exact file paths (no TBDs)
- [x] Evidence criteria: 1029+ tests pass, new tests green
- [x] Task ordering: 1 (endsWith fix) → 2 (uvx detection) → 3 (debug+ eval) → 4 (docs)

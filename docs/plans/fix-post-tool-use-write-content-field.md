# Plan — Fix PostToolUse Write-content field + refresh stale ai-news harness

- **Branch:** `fix/post-tool-use-write-content-field` (claude-rig)
- **Date:** 2026-06-17
- **Source:** `/verify-harness` findings (brain+ design, approved: _Full fix + refresh ai-news_; cross-OS: _flag, don't hack_)

## Context

`/verify-harness` on the ai-news project reported 4 harness bugs. Investigation
of claude-rig **source** shows 3 are already fixed upstream; ai-news is broken
because its **`dist/` is stale** (built 2026-05-18; source through today —
`grep -c 'result.level' dist/*` = 0) and its **per-project wrappers were
generated 2026-04-21** (old string-sniffing format). Both must refresh together
or the new `{level}`-returning dist silently mismatches the old wrapper's
`typeof result === 'string'` check.

| # | Bug | Source status |
| --- | --- | --- |
| 1 | Advise not surfaced to agent | FIXED `2f247f8` (template emits `additionalContext` JSON to stdout) |
| 2 | Zero-defect dead (no tool_response/execFn) | FIXED `dcbb591` (7th `toolResponse` param + `execFn`) |
| 3 | Write `content` ignored by constitutional check | NOT FIXED — `src/enforcement/post-tool-use.ts:137` |
| 4 | `sed_i` block short-circuited by rtk rewrite | FIXED (hook.ts Step 1 runs file_modify block before Step 3) |

**Only real source change = #3.** Everything else is rebuild + regenerate + verify.

## Constitutional Rules for This Plan

Working in `claude-rig` (a TypeScript tool — no Gmail/Claude/Telegram APIs). Applies claude-rig's own conventions, not ai-news's protected-component rules:

- **Injectable `ExecFn`** for environment detection — never mock env detection.
- **Structural severity** — `EnforcementViolation { level, message }`; level is derived by checks, never sniffed from message text.
- **Coverage gate**: 80% stmt/func/line, 75% branch (vitest.config.ts).
- Cross-OS (user directive): keep changes OS-agnostic; **flag** pre-existing macOS-only failures, fix only what this change broke.

## Mock Policy

- **Unit tests (mocks OK):** all. Fix #3's test calls `handlePostToolUse` directly with hand-built args — **no mocks needed** (pure function), which is ideal.
- **No protected components** in scope (no live APIs touched).

## Tasks

### Task 0: Create branch

**Files:** none (git only).

**Note:** master has uncommitted `package.json`/`package-lock.json` (headroom-ai integration). Carry them onto the branch but **do not stage/commit them** with the fix — `git add` only specific files.

- [ ] `git checkout -b fix/post-tool-use-write-content-field` (from claude-rig master)

### Task 1: RED — failing unit test for Write-content constitutional check

**Files:** `tests/enforcement/post-tool-use.test.ts`.

**Test strategy:** new `it(...)` under the existing constitutional `describe`. Mirror the Edit + `new_string` test at `:165-177` but use **Write + `content`** on a stack-test path with a mock.

**Mock check:** none — pure function call with `new SessionCache()` + `structuredClone(DEFAULT_CONFIG)`.

**Evidence:** scoped run fails (content ignored → no violation; `result` null or lacks `no_mocks`).

- [ ] Add test calling `handlePostToolUse('Write', { file_path: 'tests/router/resolver.stack.test.ts', content: "jest.mock('../x.js');" }, ...)` expecting `no_mocks`.
- [ ] Run scoped; confirm RED.
- [ ] Commit (RED).

### Task 2: GREEN — fix content extraction

**Files:** `src/enforcement/post-tool-use.ts` (line ~137).

**Test strategy:** Task 1 test passes; existing Edit + `new_string` tests stay green (regression).

**Mock check:** none.

**Evidence:** scoped test passes; full suite green (modulo pre-existing macOS flags).

- [ ] Change `(args.new_string as string) ?? ''` to `(args.content as string) ?? (args.new_string as string) ?? ''`.
- [ ] Run scoped; confirm GREEN.
- [ ] Commit (GREEN).

### Task 3: Rebuild dist + verify freshness

**Files:** `dist/*` (gitignored — not committed).

**Evidence:** `npm run build` exits 0; `grep -c 'result.level'` not meaningful on handlers — instead confirm `extractBashOutput` + `toolResponse` + object `level:` returns present in dist.

- [ ] `npm run build`.
- [ ] Verify new-source signatures land in dist.

### Task 4: Full vitest on Linux (cross-OS: flag, don't hack)

**Evidence:** new test passes; no NEW failures introduced. Pre-existing macOS-only failures logged as separate findings (not patched).

- [ ] `npm test` (full suite, with coverage).
- [ ] Classify failures mine vs pre-existing; flag pre-existing; do not OS-hack.

### Task 5: Eval coverage (deterministic)

**Files:** `tests/eval/enforcement-eval.test.ts` (add scenario if gap).

**Test strategy:** deterministic eval (no live `claude -p`) for the Write-content → constitutional path.

**Mock check:** none.

- [ ] Add Write + content scenario mirroring Task 1 if none exists.
- [ ] `npm test -- tests/eval/` green.
- [ ] Commit.

### Task 6: Refresh ai-news installed wrappers

**Files (target repo):** `ai-news/.claude/hooks/scripts/{pre,post}-tool-use.ts` (+ settings.json hook lines).

**Mechanism:** `node dist/cli/index.js init --dir <ai-news>` (no `--force`). `copyGeneratedTemplate` always overwrites hooks; skills/agents/config respect `--force` (default false) → untouched.

**Evidence:** `git -C ai-news status` shows only hook files changed (no skill/config clobber).

- [ ] Branch ai-news (`fix/refresh-rig-hooks`).
- [ ] Run `rig init --dir ai-news`; confirm surgical diff.
- [ ] Diff a regenerated wrapper: header `Generated:` today; body has `result.level` / `additionalContext` / `input.tool_response`.

### Task 7: Verify ai-news harness end-to-end

**Evidence:** direct hook invocation matches source contract.

- [ ] `sed -i 's/a/b/g' src/foo.py` → pre-tool-use → `[BLOCK]` exit 2.
- [ ] `grep -rn x src/` → `additionalContext` JSON (advise) stdout exit 0.
- [ ] Failing test `tool_response` → post-tool-use → zero-defect violation.

## Validation Checklist

- [x] Every task has a test strategy (Tasks 1/2/5) or evidence criteria (3/4/6/7).
- [x] No task mocks a protected component (none in scope).
- [x] Plan references exact file paths (no TBDs).
- [x] Evidence criteria defined per task.
- [x] Constitutional + mock-policy sections present.

## Known Issues (flagged, NOT fixed — per "flag, don't hack")

- `tests/integration/session-start.test.ts > creates session cache file in /tmp`
  times out (5000ms) on this Linux host. Pre-existing and unrelated to this
  change: `git diff master..HEAD` touches only `post-tool-use.ts` (+ test + plan);
  session-start code/test are byte-identical to master. Root cause: when
  jcodemunch is installed on the host (it is here — 77 indexed repos), the
  SessionStart hook auto-indexes the E2E tempDir (per the test's own `afterAll`
  comment), and that real `index_folder` exceeds vitest's 5000ms default.
  Likely green on the macOS dev machine where the timeout was tuned. Suggested
  fix for a separate PR: raise the test timeout or stub auto-index in the
  fixture. Full-suite result on Linux: 1326 passed, 1 failed (this).

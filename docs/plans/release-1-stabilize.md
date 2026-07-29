# Release 1 — Stabilize (Workstreams A + B)  ·  v2 (post-verification)

**Source design:** `brain+` validated design, 2026-07-29 (memory `rig-dep-sync-design`).
**Scope:** Workstream A (Tier 0 correctness) + Workstream B (Tier 1 cleanup). No structural changes — `rtk hook claude` delegation (C) and typed-agent PreToolUse hook (D) are Release 2.
**Goal:** make rig correct and truthful against the current state of its five dependencies. Low-risk, fast to ship.
**Suggested target:** `0.7.4` (patch — all `fix:`/`docs:`/`chore:`; release-please decides).

> **v2 changes:** every dependency-side claim now **verified against actual `~/tools` source** (2026-07-29, 5 adversarial verifiers — see Verification section). Three tasks widened after a rig-side completeness sweep found the v1 file lists incomplete (A3, A4, B2). Task 3 (A1) improved: the correct fix preserves the rewrite rather than sacrificing it.

## Verification (2026-07-29)

Five read-only adversarial verifiers tried to **falsify** each load-bearing claim against the real source. Result: **every claim a task rests on is CONFIRMED; no task invalidated.** One PARTIAL (rtk `cat`) refines rationale, not the fix.

| Claim | Verdict | Evidence |
|---|---|---|
| rtk `Default`(no rule)→exit 3, security test enforces it | CONFIRMED | `permissions.rs:19` ("default to ask"); `rewrite_cmd.rs:58-62` (`_=>Ask`), `:175-185` (test), `:153-156` (security comment, rtk-ai/rtk#1155); CHANGELOG 0.36.0 |
| rtk emits `updatedInput` w/o `permissionDecision` on exit 3 | CONFIRMED | `hook_cmd.rs:390-443` `process_claude_payload` (inserts `permissionDecision:"allow"` only when allow=true); `rtk-rewrite.sh:81-101` |
| rtk `cat` removed; reading is `rtk read`/`rtk smart` | PARTIAL (core✓, mechanism✗) | `main.rs:85-855` no `Cat`; `Read`(101)/`Smart`(120) present; `registry.rs:1333` rewrites `cat`→`rtk read`. But literal `rtk cat` is **not** clap-rejected — `run_fallback`(`main.rs:1290-1423`) passthrough-runs raw `cat`. |
| rtk repo `rtk-ai/rtk`; `gain` cumulative at `summary.total_saved` | CONFIRMED | `Cargo.toml:10`; `gain.rs:517-526` |
| jcodemunch `get_symbol`/`get_symbols`→`get_symbol_source` | CONFIRMED | commit `d040bf1` (2026-03-24); `server.py:1581` registers, `:5406` dispatches; zero hits for old names. (The CHANGELOG lines `:11256,11261` are historical `[1.0.0]` highlights.) |
| jcodemunch repo `jgravelle/jcodemunch-mcp`; no bare `jcodemunch` CLI | CONFIRMED | `pyproject.toml [project.urls]`; `[project.scripts]` = `jcodemunch-mcp`/`gcm`/`munch-bench` only |
| graphify writes no `.rebuild.lock`; no recursion/file cap | CONFIRMED | exhaustive grep: zero `rebuild.lock`/`flock`/`FileLock`/`setrecursionlimit`/`MAX_FILES`/`6000`; only `MAX_NODES_FOR_VIZ=5000` (`export.py:25`), try/except'd (`watch.py:108-118`) |
| headroom `wrap` rtk opt-in on main (102 commits past v0.32.0) | CONFIRMED | `wrap.py:716-856` `_rtk_opt_in`/`_setup_rtk`; `init.py` zero rtk refs; perf schema intact |
| superpowers: 9 skills exact, no typed agents, general-purpose dispatch | CONFIRMED | all `skills/<name>/SKILL.md:2`; no `.claude/agents/`; SDD templates use `Subagent (general-purpose):` |

## Constitutional Rules for This Plan

- **No mocks for environment detection** — injectable `ExecFn` / `ExecRewriteFn` (CLAUDE.md). Unit-test mocks OK for pure logic; the rtk/graphify/jcodemunch seams use injectable fakes, never `vi.mock`.
- **Evidence before claims** — show test output before reporting done.
- **Every source change → corresponding test change** (stale-tests, `grace_period: 0`).
- **Zero-defect** — `npm test` green before commit; a failing RED run during `tdd+` is expected (advisory).

## Mock Policy

- **Unit tests (injectable fakes ok):** all of it. rtk rewrite via injectable `ExecRewriteFn`; graphify/jcodemunch detection via injectable `ExecFn`. No real subprocesses, no network.
- **Protected/real-dep components:** none in this release.

## Independence contract

Serialize within a chain (shared file), parallelize across:

| Chain | Tasks | Shared file(s) forcing serialization |
|-------|-------|--------------------------------------|
| 1 | T1 → T2 | `src/router/rules.ts`, `tests/router/rules.test.ts` |
| 2 | T3 | `src/router/hook.ts`, `src/types.ts`, `templates/hooks/pre-tool-use.ts` |
| 3 | T4 → T5 | `src/session/environment.ts`, `tests/session/environment.test.ts` |
| 4 | T6 | docs + `src/session/start.ts` (start.ts is rig-code, but only T6 touches it) |

No cross-chain file overlap. (T2 also touches README/architecture docs, as does T6 — if run in parallel, serialize the doc commits or have T6 own all doc edits; simplest: T6 after T2.)

---

## Task 1: Rename stale `get_symbol`/`get_symbols` → `get_symbol_source` (A2)

Verified: commit `d040bf1` (2026-03-24) merged both into `get_symbol_source`; old names have no registration/dispatch. **Trap:** the implementation *file* is still `tools/get_symbol.py` (didn't rename) — only the advertised MCP tool name changed. Don't be fooled by the filename.

**Files:** `templates/agents/scout.md`, `templates/agents/code-reviewer.md`, `templates/agents/spec-reviewer.md` (`tools:` line ~4 — replace `mcp__jcodemunch__get_symbol,mcp__jcodemunch__get_symbols` → `mcp__jcodemunch__get_symbol_source`), `src/router/rules.ts:35` (advisory `reason`: `get_symbol` → `get_symbol_source`)
**Test strategy:** `tests/cli/template-content.test.ts` (assert rendered `tools:` has `get_symbol_source`, not bare `get_symbol`/`get_symbols`); `tests/router/rules.test.ts` (advisory text).
**Mock check:** none — string assertions.
- [ ] RED: add the two assertions → fail.
- [ ] Confirm fail.
- [ ] GREEN: rename in the 3 templates + `rules.ts:35`.
- [ ] Confirm pass; commit `fix(agents): rename stale get_symbol→get_symbol_source after jcodemunch consolidation (d040bf1)`.

## Task 2: Retarget `rtk_cat_code` rule → `rtk read`/`rtk smart` (A3)  ·  *widened in v2*

Verified: rtk has no `cat` subcommand; the rewrite engine maps `cat`→`rtk read` (`registry.rs:1333`), so the common path produces `rtk read`, which the current `^rtk\s+cat` rule never catches. A literal `rtk cat <file>` degrades to raw passthrough `cat` (not clap-rejected, as v1 claimed). Retargeting catches the real code-reading path.

**Decision: keep the `rtk_cat_code` intent/config key as-is** (it's a user-facing `.harness.yaml` key — `tool_routing.rtk_cat_code`; renaming breaks user config for no behavioral gain). Only retarget the match regex + message text. Renaming the intent is an optional future cleanup.

**Depends on: Task 1** (shared `rules.ts` + `rules.test.ts`).
**Files (wider than v1):**
- `src/router/rules.ts:70-85` (the rule: regex `^rtk\s+cat\s+(\S+)` → `^rtk\s+(?:read|smart)\s+(\S+)`; refresh `reason` to "rtk read/smart on code files wastes tokens…")
- `src/router/rules.ts:137` (**second stale spot, missed in v1**: the `file_read` rule's rtk resolution advises `tool: 'rtk cat'` → change to `'rtk read'`)
- Tests: `tests/router/rules.test.ts` (the rtk_cat_code cases ~197-209 AND the file_read "advises rtk cat" case ~42-48 → `rtk read`), `tests/router/hook.test.ts:191-202`, `tests/router/rewrite.test.ts:320-324`, `tests/integration/pre-tool-use.test.ts:122-141`, `tests/eval/scenarios.ts:414-417`, `tests/eval/session-state-eval.test.ts:111`, `tests/eval/score.test.ts:28`, `tests/config.test.ts:27`
- Docs: `README.md:46,237`, `docs/architecture.md:38,87` (reword "rtk cat" → "rtk read on code files"; keep the `rtk_cat_code` config key name)
**Test strategy:** `rules.test.ts` — matches `rtk read src/foo.ts` + `rtk smart src/foo.ts` on code, not `rtk read README.md`; file_read rtk resolution advises `rtk read`. Eval/config/hook tests updated to the new tool string.
**Mock check:** none — static rules.
- [ ] RED: update rtk_cat_code + file_read tests to new matchers/strings → fail.
- [ ] Confirm fail.
- [ ] GREEN: retarget regex (`:76`), refresh reason (`:82`), fix file_read advisory (`:137`); update the ~8 test files + 2 docs.
- [ ] Confirm full `npm test` pass; commit `fix(router): retarget rtk_cat_code to rtk read/smart (rtk cat removed; literal rtk cat passthrough-runs raw cat)`.

## Task 3: Stop auto-allowing rtk exit-3 rewrites — preserve rewrite, prompt user (A1)  ·  *improved in v2*

Verified load-bearing: `Default`→exit 3, security-enforced. **v2 improvement:** rtk's own native Claude path (`process_claude_payload`, `hook_cmd.rs:390-443`) emits `updatedInput` **without** `permissionDecision` on Ask/Default (inserts `"allow"` only when `allow==true`). So the correct minimal fix is **not** pass-through (which loses the rewrite) — it's **emit the rewrite without `permissionDecision`**, matching rtk byte-for-byte. This keeps the token optimization *and* prompts the user. Superseded by Release 2 C (`rtk hook claude` delegation) — include only as a bleed-stop.

**Files:** `src/types.ts` (`RewriteResult` + `ExecRewriteFn`), `src/router/hook.ts` (`makeDefaultExecRewrite` ~59-108, `tryRtkRewrite` ~118-131, Step 3 ~268-276), `templates/hooks/pre-tool-use.ts` (~55-64), `tests/router/hook.test.ts`, `tests/router/rewrite.test.ts`, `tests/cli/` (template emission)
**Test strategy:** `hook.test.ts` — injectable `ExecRewriteFn` simulating exit 0 (Allow) vs exit 3 (Ask/Default): returned `RewriteResult` carries `autoAllow:true` (exit 0) vs `autoAllow:false` (exit 3), both with the rewritten `command`. `tests/cli` — emission pairs `permissionDecision:"allow"` only when `autoAllow`; for `autoAllow:false` emits `updatedInput` **without** `permissionDecision`.
**Mock check:** injectable `ExecRewriteFn` (throws `{status:3,stdout}` / returns string) — not a component mock.
- [ ] RED: assert exit-3 `autoAllow===false` + emission omits `permissionDecision` → fail.
- [ ] Confirm fail.
- [ ] **Evidence step (largely pre-answered):** rtk ships exactly this (`process_claude_payload` omits `permissionDecision` on Ask; `test_claude_json_output_structure` comment: "permissionDecision is only set when an explicit allow rule matches"). Still do a scratch CC 2.1.220 check that `updatedInput` without `permissionDecision` prompts-and-applies (not run-original). If it only run-originals, exit-3 rewrites are lost until Release 2 — still safe (no auto-allow).
- [ ] GREEN: add `autoAllow:boolean` to `RewriteResult`; `ExecRewriteFn`/`tryRtkRewrite` return `{command, autoAllow}` (exit 0→true, exit 3→false, exit 1/2→null); thread through Step 3; `pre-tool-use.ts` emits `permissionDecision:"allow"` only when `autoAllow`, else `updatedInput` alone. Keep the `/tmp/rig-rtk-rewrite-failures.log` diag path.
- [ ] Confirm full `npm test` pass; commit `fix(router): stop auto-allowing rtk exit-3 rewrites — emit rewrite without permissionDecision (matches rtk Ask semantics)`.

## Task 4: Remove dead graphify `.rebuild.lock` branch (A4)  ·  *widened in v2*

Verified: graphify writes no `.rebuild.lock` anywhere (no `flock`/`FileLock` either). The lock-based "building" branch is dead; the 5s polling loop remains the race-guard.

**Depends on: Task 5 is its peer in chain 3 (serialize T4→T5).**
**Files (wider than v1):**
- `src/session/environment.ts:7` (drop `rebuildLockPath` import), `:210-224` (delete the lock block + fix the false comment at `:210-212`)
- `src/constants.ts:11` (`REBUILD_LOCK_REL`), `:18` (`rebuildLockPath`) — remove both
- `src/scout/graph-state.ts` (drop any `rebuildLockPath` import/use — verify)
- **`templates/agents/scout.md:76-78, 111, 120`** (missed in v1: a build-state table + notes that reference `.rebuild.lock` — rewrite to drop lock references)
- **`tests/scout/scout-template.test.ts:44-45`** (missed in v1: asserts the template *contains* `.rebuild.lock` — update/remove)
- **`tests/session/environment.test.ts:831, 843, 859`** (missed in v1: three cases asserting lock-based building-state — remove/replace)
**Test strategy:** `environment.test.ts` — assert lock-file presence no longer affects state; `scout-template.test.ts` — assert the scout template no longer mentions `.rebuild.lock`; `npm run lint` confirms no dangling `rebuildLockPath` import.
**Mock check:** injectable `existsCheck`/`statCheck`/`mtimeCheck`.
- [ ] RED: add "lock presence doesn't change state" + "template has no .rebuild.lock" assertions → fail.
- [ ] Confirm fail.
- [ ] GREEN: delete lock block/comment/import/constants; rewrite scout template build-state table (drop lock rows); fix the 3 env tests + scout-template test.
- [ ] Confirm `npm run lint` + `npm test`; commit `fix(graphify): drop dead .rebuild.lock detection (upstream removed it; build emits only graph.json/GRAPH_REPORT.md/graph.html)`.

## Task 5: Remove dead bare-`jcodemunch` CLI probe (B4)  ·  *confirmed dead in v2*

Verified: `[project.scripts]` has only `jcodemunch-mcp`/`gcm`/`munch-bench` — no bare `jcodemunch`. The `which jcodemunch` first probe always fails and falls through. (v1 hedged "verify" — now confirmed, so just remove.)

**Depends on: Task 4** (shared `environment.ts` + `environment.test.ts`).
**Files:** `src/session/environment.ts:248-257` (the `try { exec('which jcodemunch') … }` step-1 block of `detectJcodemunch`), `tests/session/environment.test.ts`
**Test strategy:** `environment.test.ts` — assert detection proceeds to the MCP-config/binary/uvx chain (step 1 gone); transport resolution unchanged.
**Mock check:** injectable `ExecFn` failing `which jcodemunch`.
- [ ] RED: test that step 1 is gone / detection starts at MCP config → fail.
- [ ] GREEN: remove the bare-`jcodemunch` try-block; detection starts at the MCP registration lookup.
- [ ] Confirm pass; commit `chore(session): drop dead bare-jcodemunch CLI probe (only jcodemunch-mcp/gcm/munch-bench exist)`.

## Task 6: Correct stale dependency docs + install URLs (B1 + B2 + B3)  ·  *widened in v2*

Three doc-truth fixes. **v2 adds:** user-facing install URLs in `src/session/start.ts` (code, not just docs) and their tests.

**Files:** `README.md`, `docs/getting-started.md`, `docs/architecture.md`, `docs/troubleshooting.md`, **`src/session/start.ts:273,276`** (+ `tests/session/start.test.ts` asserting the warning text)
**Test strategy:** docs-quality CI lint; `start.test.ts` updated to the new URLs; a grep-assertion test that stale strings are absent and corrected ones present.
**Mock check:** none.
- [ ] **B1 — graphify recursion myth:** `docs/getting-started.md:34`, `docs/troubleshooting.md:178`, `docs/architecture.md:719` — replace "6000+ files … AST recursion limits" with: no file-count/recursion cap; only HTML viz skipped above 5000 nodes (JSON + report always produced).
- [ ] **B2 — repo URLs (widened):** change `franklywatson/rtk`→`rtk-ai/rtk` and `franklywatson/jcodemunch`→`jgravelle/jcodemunch-mcp` in `README.md:8,9,81,82`, `docs/getting-started.md:15,18`, **and `src/session/start.ts:273,276`** (the runtime install-warning URLs) + their `start.test.ts` assertions.
  - **DISCIPLINE — do NOT change:** `franklywatson/claude-rig` (rig's *own* repo — README:3,4,5,135; getting-started:41; design-process:13), `franklywatson/agentic-patterns` (out of scope/unverified — README:57,380; architecture.md:17), or test fixtures (`environment.test.ts:462,478`; `start.test.ts:847`).
- [ ] **B3 — headroom wrap/rtk conflict:** `README.md:103,110` — reword: plain `headroom wrap claude` no longer runs `rtk init --global` by default on main/post-0.33 (rtk opt-in via `--rtk`/`HEADROOM_RTK=1`); `--no-context-tool`/`--no-rtk` are now deprecated no-ops. (Against released 0.32.0 the old behavior still holds — phrase as "recent headroom makes rtk opt-in".)
- [ ] Confirm docs lint + grep test + `start.test.ts` pass; commit `docs: sync rtk/graphify/jcodemunch/headroom references + install URLs to current upstream`.

---

## Validation (Phase C, re-run honestly)

- [ ] Every task has a test strategy ✓
- [ ] No task mocks a protected component ✓ (injectable fakes only)
- [ ] **Plan references complete, exact file paths** ✓ (v1 was incomplete on A3/A4/B2 — now fixed via the rig-side sweep; each widened task lists every test/doc touched)
- [ ] Evidence criteria defined per task ✓ (Task 3's CC-semantics step now largely pre-answered by rtk source)
- [ ] Active enforcement rules section present ✓
- [ ] Independence contract complete ✓ (chain 1 = T1→T2; chain 3 = T4→T5; T3, T6 independent; T6 after T2 if parallel)

## Execution notes

- Feature branch `fix/dep-sync-stabilize`, not `master` (branch-discipline).
- Each task = one conventional commit; release-please bundles into the release PR.
- **Prefer `/tdd+` (sequential) over `/sdd+`** for this release: tdd+ runs in-session with no subagent dispatch, sidestepping the typed-agent→general-purpose revert that Release 2 D fixes. The 4 chains are independent (team-mode candidates post-Release 2).
- `npm test` (1100+ tests) green + `npm run lint` clean before each commit.

## Next

After Release 1 ships, plan Release 2 (Workstreams C + D + E): `rtk hook claude` delegation, typed-agent PreToolUse hook, superpowers detection.

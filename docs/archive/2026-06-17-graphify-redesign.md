# Plan: Graphify Integration Redesign

> **Status:** Executed — all 10 tasks shipped across commits f6c0a42 to 1f5a57f; live in src/scout/graph-state.ts; archived 2026-06-17


## Constitutional Rules for This Plan

- Use injectable `ExecFn` and `ExistsCheck` for all subprocess/filesystem calls — no hardcoded shell commands in source, no real filesystem in tests
- Every source file change requires corresponding test changes
- Show command output before claiming done
- Full-loop assertions: verify state transitions end-to-end, not just individual function returns

## Mock Policy

- **Unit tests (mocks ok):** `exec` calls, `existsCheck` calls, file system reads — these are external dependencies injected for testability
- **No protected components in this plan** — graphify integration is advisory, not constitutional enforcement

## Task Dependency Graph

```
Task 1 (types)
  └─> Task 2 (graph-state module)
       ├─> Task 3 (environment detection)
       ├─> Task 4 (CLI stats capture)
       ├─> Task 5 (session start)
       └─> Task 7 (cross-repo)
  Task 6 (god node filtering)
       └─> Task 5 (session start)
  Task 8 (init placeholder removal) — independent
  Task 9 (scout template) — depends on all above
  Task 10 (eval tests) — depends on all above
```

---

### Task 1: Add GraphState types and update SessionCacheFile

**Files:**

- `src/types.ts` (modify, lines 71-72, 86-93, 102)

**Test strategy:** Type compilation check via `npm run lint`. No runtime tests — this is types only.

**Mock check:** N/A (types only).

- [ ] Step 1: Add `GraphState` type: `'absent' | 'building' | 'ready' | 'failed'`
- [ ] Step 2: Add `GraphBuildInfo` interface: `{ state: GraphState; pid?: number; startedAt?: number; graphPath?: string }`
- [ ] Step 3: Update `Environment` interface: replace `graphifyAvailable: boolean` and `graphifyGraphPath: string | null` with `graphBuildInfo?: GraphBuildInfo`
- [ ] Step 4: Update `MetricsBaseline.graphifyStats` — keep existing shape, unchanged
- [ ] Step 5: Update `SessionCacheFile.metricCounters` — keep `graphifyCalls`, add `graphBuildInfo?: GraphBuildInfo`
- [ ] Step 6: Run `npm run lint` to verify types compile
- [ ] Step 7: Commit

**Evidence:** `npm run lint` passes. Existing tests will break (expected — fixed in subsequent tasks).

---

### Task 2: Create graph-state module

**Files:**

- `src/scout/graph-state.ts` (new)
- `tests/scout/graph-state.test.ts` (new)

**Test strategy:** Unit tests with injectable `exec` and `existsCheck`. Test all state transitions.

**Mock check:** exec and existsCheck are injected — standard pattern.

- [ ] Step 1: Write failing tests for `determineGraphState(cwd, existsCheck)`:
  - No graph.json → returns `{ state: 'absent' }`
  - graph.json < 1KB → returns `{ state: 'absent' }` (placeholder)
  - graph.json >= 1KB → returns `{ state: 'ready', graphPath }`
- [ ] Step 2: Write failing tests for `triggerBuild(cwd, exec)`:
  - Runs `graphify update "<cwd>"` with 120s timeout
  - Returns `{ state: 'building', pid }` when exec succeeds
  - Returns `{ state: 'failed' }` when exec throws
- [ ] Step 3: Write failing tests for `waitForBuild(buildInfo, cwd, existsCheck)`:
  - Returns `{ state: 'ready', graphPath }` when graph.json now exists and >= 1KB
  - Returns `{ state: 'failed' }` when graph.json still absent/small
- [ ] Step 4: Write failing tests for `ensureGraphReady(dir, env, exec, existsCheck)`:
  - Returns null when no graphify CLI detected (env has no graphBuildInfo)
  - If state is `ready` → returns `{ state: 'ready', graphPath }` immediately
  - If state is `absent` → triggers build, waits, returns result
  - If state is `building` → waits, returns result
  - If state is `failed` → returns `{ state: 'failed' }`
- [ ] Step 5: Implement `determineGraphState()`
- [ ] Step 6: Implement `triggerBuild()`
- [ ] Step 7: Implement `waitForBuild()`
- [ ] Step 8: Implement `ensureGraphReady()` — unified entry point
- [ ] Step 9: Verify all tests pass
- [ ] Step 10: Commit

**Evidence:** All `graph-state.test.ts` tests pass. Module exports: `determineGraphState`, `triggerBuild`, `waitForBuild`, `ensureGraphReady`.

---

### Task 3: Rewrite environment detection for graphify

**Files:**

- `src/session/environment.ts` (modify, lines 44-73)
- `tests/session/environment.test.ts` (modify, lines 198-274)

**Test strategy:** Rewrite existing `detectGraphify` tests to test new state-based return value. Keep injectable exec/existsCheck pattern.

**Mock check:** exec and existsCheck injected (existing pattern).

- [ ] Step 1: Rewrite `detectGraphify` tests for new return type:
  - CLI found + graph.json >= 1KB → returns `{ state: 'ready', graphPath }`
  - CLI found + graph.json < 1KB (placeholder) → returns `{ state: 'absent' }`
  - CLI found + no graph.json → returns `{ state: 'absent' }`
  - CLI not found → returns `{ state: 'absent' }` (no graphPath)
  - `graphifyy` binary fallback still works
  - Wired into `detectEnvironment()` correctly
- [ ] Step 2: Verify tests fail (old implementation returns different shape)
- [ ] Step 3: Rewrite `detectGraphify()`:
  - Return `GraphBuildInfo` instead of `{ available: boolean, graphPath: string | null }`
  - Use `fs.statSync` for size check instead of just existence check
  - Accept injectable `existsCheck` and `sizeCheck` for testability
- [ ] Step 4: Update `detectEnvironment()` wiring (lines 20, 29-30)
- [ ] Step 5: Verify tests pass
- [ ] Step 6: Commit

**Evidence:** All environment tests pass with new state-based detection. Old boolean tests replaced.

---

### Task 4: Replace file-based stats capture with CLI-based

**Files:**

- `src/session/metrics.ts` (modify, lines 9-35)
- `tests/session/metrics.test.ts` (modify, lines 287-365)

**Test strategy:** Rewrite `captureGraphifyStats` tests. Test CLI parsing with mock exec.

**Mock check:** exec injected for CLI calls.

- [ ] Step 1: Write failing tests for new `captureGraphifyStatsViaCLI(cwd, exec)`:
  - Parses `graphify benchmark graphify-out/graph.json` output
  - Returns `{ nodes, edges, communities, extractedPct, inferredPct, ambiguousPct }`
  - Returns `null` when exec throws (graphify not available)
  - Returns `null` when output can't be parsed
- [ ] Step 2: Verify tests fail (function doesn't exist yet)
- [ ] Step 3: Implement `captureGraphifyStatsViaCLI()`:
  - Run `graphify benchmark "graphify-out/graph.json"` via exec
  - Parse output for corpus stats, node/edge/community counts
  - If benchmark doesn't provide confidence breakdown, fall back to reading just the confidence fields from graph.json (lightweight — only scan for `"confidence":` values, not the whole file)
- [ ] Step 4: Keep old `captureGraphifyStats` as deprecated fallback (rename to `captureGraphifyStatsFromFile`)
- [ ] Step 5: Verify new tests pass
- [ ] Step 6: Commit

**Evidence:** New CLI-based stats tests pass. Old file-based function preserved but not called from production code.

---

### Task 5: Rewrite session-start for async build + state tracking

**Files:**

- `src/session/start.ts` (modify, lines 8, 20, 29-36, 54, 65-68, 103-109, 119-121)
- `src/session/cache.ts` (modify, lines 21, 85, 131, 150, 185)
- `tests/session/start.test.ts` (modify, lines 352-511)

**Test strategy:** Rewrite session-start tests for new state-based flow. Test async build spawning, READY emission, BUILDING emission.

**Mock check:** exec and existsCheck injected (existing pattern).

- [ ] Step 1: Write failing tests for new session-start graphify flow:
  - `ready` state: emits stats via CLI, emits "graphify: available (N nodes, M edges)"
  - `absent` state with CLI: spawns background build, emits "graphify: building graph..."
  - `building` state from cache: emits "graphify: still building..."
  - `failed` state: emits "graphify: build failed" warning
  - `absent` state without CLI: emits "graphify: not found"
  - Stats stored in session cache when ready
  - MCP tool list emitted only when state is `ready`
- [ ] Step 2: Update `SessionCache` to persist `GraphBuildInfo` (cache.ts lines 21, 85, 131, 150, 185)
- [ ] Step 3: Rewrite `handleSessionStart()`:
  - Replace `env.graphifyAvailable` checks with `graphBuildInfo.state` checks
  - Add async build spawn using `triggerBuild()` from graph-state module
  - Replace `captureGraphifyStats` with `captureGraphifyStatsViaCLI`
  - Emit state-appropriate output lines
  - Persist build state to session cache
- [ ] Step 4: Verify tests pass
- [ ] Step 5: Commit

**Evidence:** Session-start tests pass with state-based flow. Async build spawn tested. Cache persists GraphBuildInfo.

---

### Task 6: Add god node filtering

**Files:**

- `src/scout/mapper.ts` (modify, lines 115-134)
- `tests/scout/mapper.test.ts` (modify or add tests)

**Test strategy:** Unit tests for `parseGodNodes` with filtering. Test that builtin noise is removed.

**Mock check:** N/A (pure string parsing).

- [ ] Step 1: Write failing tests for `parseGodNodes` with filtering:
  - Generic builtins filtered out: `str`, `.get()`, `.strip()`, `.append()`, `int`, `list`, `dict`, `bool`, `None`, `True`, `False`, `len`, `range`, `print`, `type`
  - Architecture-significant nodes preserved: `Platform`, `AIAgent`, `BasePlatformAdapter`
  - Filtered count reported: returns `{ nodes, filteredCount }`
  - Empty list returns empty (no crash)
- [ ] Step 2: Verify tests fail
- [ ] Step 3: Add `GENERIC_NOISE` set to mapper.ts
- [ ] Step 4: Update `parseGodNodes()` to filter noise nodes
- [ ] Step 5: Update return type to include `filteredCount`
- [ ] Step 6: Update `buildGraphContext()` to use filtered results
- [ ] Step 7: Verify tests pass
- [ ] Step 8: Commit

**Evidence:** God node filtering tests pass. Generic builtins excluded. Architecture nodes preserved.

---

### Task 7: Refactor cross-repo to use graph-state module

**Files:**

- `src/scout/cross-repo.ts` (modify, lines 47-81)
- `tests/scout/cross-repo.test.ts` (modify, lines 185-272)

**Test strategy:** Update existing cross-repo tests to use graph-state module. Test delegation.

**Mock check:** exec/existsCheck injected (existing pattern).

- [ ] Step 1: Write failing tests for new `ensureGraphBuilt`:
  - Delegates to `ensureGraphReady()` from graph-state module
  - Returns `{ status: 'ready', graphPath }` when graph exists
  - Returns `{ status: 'build_failed' }` on failure
  - Returns `null` when graphify unavailable
- [ ] Step 2: Rewrite `ensureGraphBuilt()` to delegate to `ensureGraphReady()`
- [ ] Step 3: Remove inline build logic (lines 63-80)
- [ ] Step 4: Keep `GraphBuildResult` interface for backward compatibility
- [ ] Step 5: Verify tests pass
- [ ] Step 6: Commit

**Evidence:** Cross-repo tests pass. `ensureGraphBuilt` is a thin wrapper around `ensureGraphReady`.

---

### Task 8: Remove placeholder from init command

**Files:**

- `src/cli/init.ts` (modify, lines 102-108)
- `tests/cli/init.test.ts` (modify, lines 60-81)

**Test strategy:** Update init tests: verify directory is created, verify no placeholder graph.json.

**Mock check:** N/A (filesystem operations).

- [ ] Step 1: Write failing tests:
  - Creates `graphify-out/` directory
  - Does NOT create `graphify-out/graph.json`
  - Still adds `graphify-out/` to `.gitignore`
  - Still adds `mcp__graphify__*` to permissions
- [ ] Step 2: Remove placeholder creation code (init.ts lines 102-108)
- [ ] Step 3: Replace with `mkdirSync('graphify-out', { recursive: true })` only
- [ ] Step 4: Verify tests pass
- [ ] Step 5: Commit

**Evidence:** Init creates directory but no placeholder graph.json. Gitignore and permissions unchanged.

---

### Task 9: Update scout agent template for state-aware triggering

**Files:**

- `templates/agents/scout.md` (modify, lines 4, 38-47, 93-97, 108-121, 138-144)

**Test strategy:** Template content assertions in `tests/scout/scout-template.test.ts` (lines 9-29).

**Mock check:** N/A (template text).

- [ ] Step 1: Update template content tests:
  - Template mentions `graphBuildInfo` / graph state
  - Template includes on-demand build trigger procedure
  - Template handles `absent`, `building`, `ready`, `failed` states
  - Template still includes MCP tool names
- [ ] Step 2: Update scout.md Step 2.5:
  - Check `graphBuildInfo.state` from session cache
  - If `absent`: run `graphify update <dir>` synchronously, wait for completion
  - If `building`: wait for completion
  - If `ready`: proceed with MCP tools
  - If `failed`: fall back to jcodemunch-only, emit warning
- [ ] Step 3: Update cross-repo Step 1.5:
  - Use `ensureGraphReady()` pattern (check state, trigger if absent)
  - Handle `building` state (concurrent build already running)
- [ ] Step 4: Update output format to include graph state
- [ ] Step 5: Verify template tests pass
- [ ] Step 6: Commit

**Evidence:** Scout template tests pass with state-aware language. Template handles all four states.

---

### Task 10: Update eval tests for graphify redesign

**Files:**

- `tests/eval/graphify-eval.test.ts` (modify, lines 1-407)
- `tests/eval/scenarios.ts` (modify, lines 20-21, 48-49)
- `tests/eval/session-state-eval.test.ts` (modify, lines 17-18, 62-63, 90-127)
- `tests/eval/config-override-eval.test.ts` (modify, lines 17-18)
- `tests/eval/determinism-eval.test.ts` (modify, line 59)
- `tests/eval/first-occurrence-eval.test.ts` (modify, lines 15-16)
- `tests/eval/python-eval.test.ts` (modify, lines 18-19)

**Test strategy:** Eval tests validate end-to-end integration. Run as final validation.
All files that construct inline `Environment` objects must be updated from
`graphifyAvailable`/`graphifyGraphPath` to `graphBuildInfo`.

**Mock check:** Uses env presets with injected functions.

- [ ] Step 1: Update `ENV_PRESETS` in scenarios.ts:
  - Replace `graphifyAvailable: boolean` + `graphifyGraphPath` with `graphBuildInfo: GraphBuildInfo`
  - "full" preset: `{ state: 'ready', graphPath: 'graphify-out/graph.json' }`
  - "jm_only" preset: no graphBuildInfo
  - Other presets: no graphBuildInfo
- [ ] Step 2: Update `GRAPHIFY_SCENARIOS`:
  - `graphify_mcp_call`: verify metric counter with state-based env
  - `graphify_mcp_god_nodes`: verify god node query with state-based env
  - `graphify_no_effect_on_routing`: update env preset shape
  - `cross_repo_graph_exists`: update to use graph-state module
  - `cross_repo_graph_build`: update build trigger flow
  - `env_preset_graphify_consistency`: verify state consistency across presets
- [ ] Step 3: Add new scenarios:
  - `graph_state_transitions`: absent → building → ready
  - `graph_state_failed`: absent → building → failed
  - `placeholder_detection`: small file treated as absent
  - `god_node_filtering`: generic builtins excluded from results
  - `async_build_spawn`: session start spawns background build
- [ ] Step 4: Update `TEMPLATE_SCENARIOS`:
  - `scout_template_lists_graphify_tools`: unchanged (tools still listed)
  - `scout_template_step_2_5_graphify`: verify state-aware language
  - `session_start_gates_graphify_on_env`: update for state-based gating
- [ ] Step 5: Update inline env objects in other eval files:
  - `session-state-eval.test.ts`: 3 scenarios with `graphifyAvailable`/`graphifyGraphPath`
    (lines 17-18, 62-63, 101-102, 126-127) and `graphifyStats` in cache (line 108)
    — replace with `graphBuildInfo`
  - `config-override-eval.test.ts`: inline env (lines 17-18) — replace with `graphBuildInfo: undefined`
  - `determinism-eval.test.ts`: `setEnvironment()` call (line 59) — verify shape still valid
  - `first-occurrence-eval.test.ts`: inline env (lines 15-16) — replace with `graphBuildInfo: undefined`
  - `python-eval.test.ts`: inline env (lines 18-19) — replace with `graphBuildInfo: undefined`
- [ ] Step 6: Verify all eval tests pass (`npm test -- tests/eval/`)
- [ ] Step 7: Commit

**Evidence:** All eval tests pass. New scenarios cover state transitions, placeholder detection, filtering, async build. All five additional eval files updated for new `graphBuildInfo` shape.

---

## Notes

- **graphify benchmark output:** If `graphify benchmark` doesn't provide node/edge/community
  counts in its output, Task 4 falls back to parsing GRAPH_REPORT.md (153 KB) instead
  of graph.json (74 MB). The benchmark output format will be verified during implementation.
- **cluster-only bug:** graphify v0.4.16 has a broken `cluster-only` command.
  Not our concern, but the integration should handle build failures gracefully regardless of cause.
- **Backward compatibility:** `Environment.graphifyAvailable` consumers (router/hook.ts,
  router/rules.ts) will need updates to check `graphBuildInfo?.state === 'ready'` instead
  of `graphifyAvailable`. These are simple boolean replacements.

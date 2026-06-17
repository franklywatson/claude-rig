# Plan: Multi-Project Graphify Stats

> **Status:** Executed — shipped in PR #11 / commit 294e3c1; Record type + accessors live; archived 2026-06-17


**Branch:** `fix/multi-project-graphify-stats`
**Date:** 2026-04-23

## Problem

Graphify stats are captured and reported for the CWD project only. When the agent
scouts an external repo (e.g., `~/projects/meridian`), the savings report shows
CWD stats (claude-rig), not the scouted project's stats. Two gaps:

1. **No graphify build triggered for external repos** — `ensureGraphBuilt` exists
   but is only called by the scout agent template, not by any programmatic hook.
2. **Single-project stats model** — `MetricsBaseline.graphifyStats` holds one set
   of stats. No mechanism to track or report per-project graphify data.

## Design

### Model change: per-project graph stats in session cache

Replace the singleton `graphifyStats` with a map keyed by directory path:

```typescript
// Before (types.ts)
graphifyStats?: { nodes, edges, communities, ... } | null;

// After
graphifyStats?: Record<string, { nodes, edges, communities, ... }>;
```

The key is the absolute directory path. CWD uses its own absolute path as key.
External directories use theirs. This preserves backward compatibility — old cache
files with the singleton format are migrated on load.

### Stats capture on external directory index

When `mcp__jcodemunch__index_folder` is called for an external directory (detected
by the post-tool-use hook), the system:

1. Triggers `graphify update <dir>` if no graph exists
2. Captures stats via `captureGraphifyStatsViaReport(dir, execFn)`
3. Stores them in the per-project map in session cache

This is a new function in `src/session/metrics.ts` that the post-tool-use hook
calls when it detects an `index_folder` call for a non-CWD directory.

### Report format

The savings skill reads the multi-project map and reports per-project:

```
[rig] Session Savings
  rtk: 6.6M saved (3 calls, +0 this session)
  jcodemunch: 6.0M saved (18 queries, 195.9M total all-time)
  graphify:
    claude-rig: 287 nodes, 385 edges, 52 communities (84% EXTRACTED, 16% INFERRED, 0% AMBIGUOUS)
    meridian: 420 nodes, 891 edges, 67 communities (91% EXTRACTED, 9% INFERRED, 0% AMBIGUOUS)
```

Single-project sessions report on one line (backward compatible):

```
  graphify: 287 nodes, 385 edges, 52 communities (84% EXTRACTED, 16% INFERRED, 0% AMBIGUOUS)
```

## Constitutional Rules for This Plan

- Use real dependencies in stack/E2E tests — mocks are appropriate in unit tests
- Every source file change requires corresponding test changes

## Mock Policy

Stack/E2E (real deps): filesystem operations (existsSync, statSync)
Unit tests (mocks ok): execSync (shell commands), external CLI tools (graphify, rtk)

---

### Task 1: Extend MetricsBaseline type to support per-project graphify stats

**Files:** `src/types.ts`
**Test strategy:** Type guard tests in `tests/types.test.ts`
**Mock check:** No protected components

- [ ] Step 1: Add `GraphifyProjectStats` interface and update `MetricsBaseline.graphifyStats` to `Record<string, GraphifyProjectStats> | null`
- [ ] Step 2: Add migration helper: `normalizeGraphifyStats(raw)` that converts old singleton format to `Record<string, Stats>` keyed by `"cwd"`
- [ ] Step 3: Update `SessionCacheFile` type to match
- [ ] Step 4: Write tests for `normalizeGraphifyStats` covering: null input, old singleton format, new map format, empty record
- [ ] Step 5: Verify tests pass

### Task 2: Update SessionCache to handle multi-project stats

**Files:** `src/session/cache.ts`, `tests/session/cache.test.ts`
**Test strategy:** Unit tests for load/save round-trip with both formats
**Mock check:** No protected components (mocks ok for filesystem)

- [ ] Step 1: Write failing tests for: loading old singleton format → migration,
      loading new map format → passthrough, saving new map format,
      `getGraphifyStats(dir)` accessor, `setGraphifyStats(dir, stats)` mutator
- [ ] Step 2: Verify tests fail
- [ ] Step 3: Add `getGraphifyStats(dir)` and `setGraphifyStats(dir, stats)` methods to SessionCache
- [ ] Step 4: Update `load()` to call `normalizeGraphifyStats()` on deserialized baseline
- [ ] Step 5: Verify tests pass

### Task 3: Update session-start to capture per-project stats

**Files:** `src/session/start.ts`, `tests/session/start.test.ts`
**Test strategy:** Unit tests with injectable execFn
**Mock check:** No protected components

- [ ] Step 1: Write failing test: session-start captures CWD stats under its absolute path key
- [ ] Step 2: Write failing test: session-start preserves existing stats for other directories when recapturing
- [ ] Step 3: Verify tests fail
- [ ] Step 4: Update `handleSessionStart` to store stats under `resolve(cwd)` key instead of singleton
- [ ] Step 5: Update the session-start output line to show project name (basename of directory)
- [ ] Step 6: Verify tests pass

### Task 4: Add external directory graphify build + stats capture

**Files:** `src/session/metrics.ts`, `src/enforcement/post-tool-use.ts`, `tests/session/metrics.test.ts`
**Test strategy:** Unit tests for new `captureExternalGraphifyStats` function; integration test for post-tool-use triggering
**Mock check:** No protected components (mock execSync for graphify CLI)

- [ ] Step 1: Write failing test for `captureExternalGraphifyStats(directory, execFn)` — should call `graphify update` if no graph exists, then capture stats via `captureGraphifyStatsViaReport`
- [ ] Step 2: Write failing test for `captureExternalGraphifyStats` — should return null when graphify build fails
- [ ] Step 3: Verify tests fail
- [ ] Step 4: Implement `captureExternalGraphifyStats` in `src/session/metrics.ts` — calls `triggerBuild` then `captureGraphifyStatsViaReport` for the external dir
- [ ] Step 5: Wire into `handlePostToolUse`: detect `mcp__jcodemunch__index_folder` calls, extract directory from args, call `captureExternalGraphifyStats`, store via `cache.setGraphifyStats(dir, stats)`
- [ ] Step 6: Verify tests pass

### Task 5: Update formatSavingsReport for multi-project output

**Files:** `src/session/metrics.ts`, `tests/session/metrics.test.ts`
**Test strategy:** Unit tests for new multi-project format
**Mock check:** No protected components

- [ ] Step 1: Write failing test: single-project stats produce single-line output
- [ ] Step 2: Write failing test: multi-project stats produce indented per-project lines
- [ ] Step 3: Write failing test: empty stats record produces no graphify line
- [ ] Step 4: Verify tests fail
- [ ] Step 5: Update `formatSavingsReport` signature to accept `Record<string, GraphifyProjectStats>` instead of singleton; format single-entry as one line, multi-entry as indented per-project
- [ ] Step 6: Verify tests pass

### Task 6: Update savings skill template

**Files:** `templates/skills/savings/SKILL.md`
**Test strategy:** Manual verification (skill templates are prose, not code)
**Mock check:** N/A

- [ ] Step 1: Update the savings skill procedure to read the multi-project map from session cache
- [ ] Step 2: Update the output format section with single-project and multi-project examples
- [ ] Step 3: Verify template references `graphifyStats` as a per-directory record

### Task 7: Integration test — full round-trip

**Files:** `tests/integration/session-start.test.ts`
**Test strategy:** Integration test with real filesystem (tmpdir), injectable exec
**Mock check:** No protected components (real filesystem via tmpdir)

- [ ] Step 1: Write integration test: session start captures CWD stats → post-tool-use captures external dir stats → savings report shows both
- [ ] Step 2: Verify test passes
- [ ] Step 3: Commit all changes

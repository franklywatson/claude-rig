# Savings Cache Discovery Fix

> **Status:** Executed — shipped in PR #12 / commits a80e723, 31fdbac; cwd + resolveGraphifyStats live; archived 2026-06-17


## Problem

Two bugs prevent `/savings` from working on multi-project hosts:

1. **No `cwd` in cache file** — Agent can't identify which `/tmp/rig-session-*.json`
   belongs to its project. The savings skill template uses "most recent by mtime"
   which picks the wrong project's cache when multiple sessions are active.

2. **graphifyStats format mismatch** — Hooks import code from `dist/` which may
   differ from the skill template version. Master writes singleton `{nodes, edges, ...}`
   but future branches may write `Record<string, {nodes, ...}>`. The savings skill
   template needs to handle both defensively.

## Tasks

### Task 1: Add `cwd` to SessionCacheFile

**Files:** `src/types.ts`, `src/session/cache.ts`
**Test strategy:** Unit tests in `tests/session/cache.test.ts` — verify serialize includes `cwd`, load restores it

- [ ] Add `cwd: string | null` to `SessionCacheFile` interface in `src/types.ts`
- [ ] Add `cwd` to `SessionCache.serialize()` output
- [ ] Restore `cwd` from loaded data (no-op — informational field for consumers)

### Task 2: Update savings skill template

**Files:** `templates/skills/savings/SKILL.md`
**Test strategy:** Manual verification — skill template is prose, not code

- [ ] Change cache discovery from "most recent by mtime" to "match by `cwd` field"
- [ ] Add defensive handling for both singleton and Record graphifyStats formats

### Task 3: Add `resolveGraphifyStats` helper

**Files:** `src/session/metrics.ts`
**Test strategy:** Unit tests in `tests/session/metrics.test.ts` — verify both formats resolve

- [ ] Add helper that normalizes graphifyStats (singleton passthrough, Record extraction
      by cwd key, null fallback)
- [ ] Wire into `formatSavingsReport` so it handles both formats

## Acceptance

- `SessionCache` serializes `cwd` field
- Savings skill template finds correct cache by `cwd` match
- Both graphifyStats formats handled without errors
- All existing tests pass

# Nuanced jcodemunch advisory (precision divert) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the router divert high-value Bash read/search commands (big-file `cat`, identifier `grep`) to jcodemunch instead of rewriting them to rtk, with shape-keyed higher-frequency advisory suppression.

**Architecture:** A new pure heuristic module (`src/router/jcodemunch-value.ts`) scores a Bash command for jcodemunch value. A new Step 2.5 in `handlePreToolUse` calls it before the rtk rewrite (Step 3); on a high-value shape it returns a jcodemunch advisory (divert), otherwise it falls through to rtk unchanged. Suppression uses a new `DIVERT_READVISE_PERIOD = 3`, keyed by shape, via an optional `period` param on `shouldAdvise`.

**Tech Stack:** TypeScript, vitest, rig's injectable-`ExecFn`/`existsCheck` pattern (no module mocks).

**Spec:** `docs/superpowers/specs/2026-08-05-jcodemunch-nuanced-advisory-design.md`

## Global Constraints

- TypeScript strict; `npm run lint` (`tsc --noEmit`) must pass.
- Coverage gate: ≥80% statements/functions/lines, ≥75% branches.
- No mocks for environment/filesystem — use injectable `existsCheck` / `statCheck` / `execRewrite` seams (project convention; also the `no_mocks: advise` constitutional rule).
- Severity is structural: advisories carry `level: 'advise' | 'block'`; never sniff message text.
- Conventional commit messages (`feat:` / `test:` / `docs:`).

## Constitutional Rules for This Plan

From active `.harness.yaml` enforcement (skill templates anchor on session-start output):

- **no_mocks (advise):** use injectable fakes for the filesystem and environment in unit tests; do not `vi.mock`/`jest.mock` the fs or config modules. Mocks are appropriate only for pure seams already designed for injection.
- **evidence_only (block):** show real command/test output before claiming a task is done.
- **stale_tests (advise):** every source-file change in this plan ships with its corresponding test change in the same task.

## Mock Policy

- **Stack/E2E (real deps):** none in this plan — no DB/payment/logger components.
- **Unit tests (injectable fakes ok):** `scoreJcodemunchValue` (inject `existsCheck`/`statCheck`); `handlePreToolUse` Step 2.5 (inject `execRewrite`, `existsCheck`, `statCheck`, and `cache.setEnvironment(...)` for the env gate). These are designed injection seams, not mocks of protected components.

## File Structure

- **NEW** `src/router/jcodemunch-value.ts` — pure heuristic: `CODE_EXTENSIONS`, `DivertDecision`, `DivertOptions`, `scoreJcodemunchValue(command, opts)`. One responsibility: decide whether a Bash command is a high-value jcodemunch opportunity.
- **NEW** `tests/router/jcodemunch-value.test.ts` — unit tests for both shapes + all no-divert cases.
- `src/session/cache.ts` — add `DIVERT_READVISE_PERIOD`, optional `period` param on `shouldAdvise`.
- `src/types.ts` — `ToolRoutingRules` gains `jcodemunch_divert`, `jcodemunch_divert_outline_bytes`.
- `src/config.ts` — `DEFAULT_CONFIG.rules.tool_routing` gains the two keys (auto-flows into generated `.harness.yaml` via `init.ts:118` `yamlStringify(DEFAULT_CONFIG, …)`).
- `src/router/hook.ts` — Step 2.5 wiring; `HookOptions` gains `statCheck?`.
- `docs/architecture.md`, `README.md` — document the new Step 2.5 + divert heuristic.

**Spec deviation (flagged for review):** the spec's "session-start active-rules output lists `jcodemunch_divert`" is **dropped**. `formatActiveRules` (`src/session/start.ts:351-373`) emits only `constitutional` + `branch_discipline`, not `tool_routing` rules; surfacing one `tool_routing` key there would be inconsistent. The divert is discoverable via its runtime advisories and the generated `.harness.yaml` defaults.

---

### Task 1: Divert re-advisory period on SessionCache

**Files:**
- Modify: `src/session/cache.ts:13` (new constant near `ADVISORY_READVISE_PERIOD`) and `src/session/cache.ts:247-265` (`shouldAdvise` signature/body)
- Test: `tests/session/cache.test.ts` (extend the `shouldAdvise` describe at `:158`)

**Interfaces:**
- Produces: `export const DIVERT_READVISE_PERIOD = 3;` and `shouldAdvise(intent: string, period: number = ADVISORY_READVISE_PERIOD): boolean`. Existing single-arg callers are unchanged (default preserves the 1, 11, 21, … cycle).
- Consumes: nothing new.

**Depends on:** none. Parallelizable with Task 2 (disjoint files).

- [ ] **Step 1: Write the failing tests**

Append to `tests/session/cache.test.ts` inside the `shouldAdvise` describe block:

```ts
  describe('shouldAdvise (divert period)', () => {
    it('advises on the 1st call, suppresses 2-3, re-advises on the 4th when period=3', () => {
      expect(cache.shouldAdvise('jm_divert:outline', 3)).toBe(true);   // 1
      expect(cache.shouldAdvise('jm_divert:outline', 3)).toBe(false);  // 2
      expect(cache.shouldAdvise('jm_divert:outline', 3)).toBe(false);  // 3
      expect(cache.shouldAdvise('jm_divert:outline', 3)).toBe(true);   // 4 (re-advise)
      expect(cache.shouldAdvise('jm_divert:outline', 3)).toBe(false);  // 5
    });

    it('keeps the default period at 10 when no period is passed', () => {
      expect(cache.shouldAdvise('native_grep')).toBe(true);            // 1
      for (let i = 0; i < 9; i++) expect(cache.shouldAdvise('native_grep')).toBe(false);
      expect(cache.shouldAdvise('native_grep')).toBe(true);            // 11
    });

    it('tracks divert shape keys independently', () => {
      expect(cache.shouldAdvise('jm_divert:outline', 3)).toBe(true);
      expect(cache.shouldAdvise('jm_divert:symbol', 3)).toBe(true);    // independent first call
      expect(cache.shouldAdvise('jm_divert:outline', 3)).toBe(false);
      expect(cache.shouldAdvise('jm_divert:symbol', 3)).toBe(false);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/session/cache.test.ts -t "divert period"`
Expected: FAIL — `DIVERT_READVISE_PERIOD` is not exported and `shouldAdvise` accepts no `period` arg (the `period=3` cases advise on the wrong cadence).

- [ ] **Step 3: Write minimal implementation**

In `src/session/cache.ts`, beside `ADVISORY_READVISE_PERIOD` (line 13):

```ts
/**
 * Divert advisory re-advisory cycle length. Divert advisories surface more
 * often than generic ones (every 3rd suppressed vs every 10th) because a
 * high-value jcodemunch opportunity is worth re-surfacing through a session.
 */
export const DIVERT_READVISE_PERIOD = 3;
```

Change the `shouldAdvise` signature and use the param (lines 247-265):

```ts
  shouldAdvise(intent: string, period: number = ADVISORY_READVISE_PERIOD): boolean {
    if (!this.advisedIntents.has(intent)) {
      this.advisedIntents.add(intent);
      this.save();
      return true;
    }
    const suppressed = (this.advisorySuppressCounts.get(intent) ?? 0) + 1;
    if (suppressed >= period) {
      this.advisorySuppressCounts.set(intent, 0);
      this.save();
      return true;
    }
    this.advisorySuppressCounts.set(intent, suppressed);
    this.save();
    return false;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/session/cache.test.ts`
Expected: PASS (all `shouldAdvise` cases, old and new).

- [ ] **Step 5: Commit**

```bash
git add src/session/cache.ts tests/session/cache.test.ts
git commit -m "feat(cache): add DIVERT_READVISE_PERIOD + period param to shouldAdvise"
```

---

### Task 2: Config keys + types for the divert

**Files:**
- Modify: `src/types.ts:204-217` (`ToolRoutingRules`)
- Modify: `src/config.ts:14-27` (`DEFAULT_CONFIG.rules.tool_routing`)
- Test: `tests/config.test.ts` (`DEFAULT_CONFIG` describe at `:9`; native-keys test at `:23`)
- Test: `tests/cli/init.test.ts` (generated `.harness.yaml` contains the keys)

**Interfaces:**
- Produces: `ToolRoutingRules.jcodemunch_divert?: EnforcementLevel` and `ToolRoutingRules.jcodemunch_divert_outline_bytes?: number`; defaults `'advise'` and `8192`. Generated `.harness.yaml` includes them automatically (Task 5 reads them; `init.ts:118` serializes `DEFAULT_CONFIG`).
- Consumes: nothing new.

**Depends on:** none. Parallelizable with Task 1.

- [ ] **Step 1: Write the failing tests**

In `tests/config.test.ts`, beside the native-keys test:

```ts
  it('has jcodemunch divert config keys', () => {
    expect(DEFAULT_CONFIG.rules.tool_routing.jcodemunch_divert).toBe('advise');
    expect(DEFAULT_CONFIG.rules.tool_routing.jcodemunch_divert_outline_bytes).toBe(8192);
  });

  it('merges jcodemunch_divert override over defaults', () => {
    const merged = mergeConfigs(structuredClone(DEFAULT_CONFIG), {
      rules: { tool_routing: { jcodemunch_divert: 'block' } },
    });
    expect(merged.rules.tool_routing.jcodemunch_divert).toBe('block');
    expect(merged.rules.tool_routing.jcodemunch_divert_outline_bytes).toBe(8192); // preserved
  });
```

In `tests/cli/init.test.ts`, add (adjust to that file's temp-project scaffold idiom):

```ts
  it('writes jcodemunch_divert keys into the generated .harness.yaml', () => {
    // scaffold a temp project, run init, then read the generated config
    const yaml = readFileSync(join(tmpDir, '.harness.yaml'), 'utf-8');
    expect(yaml).toContain('jcodemunch_divert:');
    expect(yaml).toContain('jcodemunch_divert_outline_bytes:');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/config.test.ts tests/cli/init.test.ts -t "jcodemunch"`
Expected: FAIL — the keys do not exist on `ToolRoutingRules` / `DEFAULT_CONFIG`.

- [ ] **Step 3: Write minimal implementation**

In `src/types.ts`, add two fields to `ToolRoutingRules` (after `read_line_threshold?: number;`):

```ts
  jcodemunch_divert?: EnforcementLevel;
  jcodemunch_divert_outline_bytes?: number;
```

In `src/config.ts`, add two lines inside `DEFAULT_CONFIG.rules.tool_routing` (after `read_line_threshold: 100,`):

```ts
      jcodemunch_divert: 'advise',
      jcodemunch_divert_outline_bytes: 8192,
```

(No `init.ts` edit — it serializes `DEFAULT_CONFIG` via `yamlStringify` at line 118.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/config.test.ts tests/cli/init.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/config.ts tests/config.test.ts tests/cli/init.test.ts
git commit -m "feat(config): add jcodemunch_divert + outline_bytes config keys"
```

---

### Task 3: Heuristic module — Shape A (big-file `cat` outline)

**Files:**
- Create: `src/router/jcodemunch-value.ts`
- Create: `tests/router/jcodemunch-value.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DivertDecision { shape: 'outline' | 'symbol'; jmTool: string; reason: string; target: string; }
  export interface DivertOptions { existsCheck: (p: string) => boolean; statCheck: (p: string) => { size: number; isFile: boolean }; outlineBytes: number; }
  export const CODE_EXTENSIONS: ReadonlySet<string>;
  export function scoreJcodemunchValue(command: string, opts: DivertOptions): DivertDecision | null;
  ```
  For Shape A, returns `{ shape: 'outline', jmTool: 'mcp__jcodemunch__get_file_outline', target: <path>, reason: <…> }`.
- Consumes: nothing (pure).

**Depends on:** none. Parallelizable with Tasks 1, 2.

- [ ] **Step 1: Write the failing tests**

`tests/router/jcodemunch-value.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { scoreJcodemunchValue } from '../../src/router/jcodemunch-value.js';

const opts = (overrides: Partial<{ size: number; exists: boolean }> = {}) => ({
  existsCheck: () => overrides.exists ?? true,
  statCheck: () => ({ size: overrides.size ?? 20000, isFile: true }),
  outlineBytes: 8192,
});

describe('scoreJcodemunchValue — Shape A (cat outline)', () => {
  it('diverts a big cat of a code file to get_file_outline', () => {
    const d = scoreJcodemunchValue('cat /x/src/big.ts', opts({ size: 20000 }));
    expect(d).toMatchObject({ shape: 'outline', jmTool: 'mcp__jcodemunch__get_file_outline', target: '/x/src/big.ts' });
  });

  it('does not divert a file below the outline byte threshold', () => {
    expect(scoreJcodemunchValue('cat /x/src/small.ts', opts({ size: 100 }))).toBeNull();
  });

  it('does not divert a non-code file extension', () => {
    expect(scoreJcodemunchValue('cat /x/notes.md', opts({ size: 20000 }))).toBeNull();
  });

  it('does not divert a missing file', () => {
    expect(scoreJcodemunchValue('cat /x/missing.ts', opts({ exists: false }))).toBeNull();
  });

  it('does not divert multi-file cat', () => {
    expect(scoreJcodemunchValue('cat /x/a.ts /x/b.ts', opts({ size: 20000 }))).toBeNull();
  });

  it('does not divert head or tail (slice reads)', () => {
    expect(scoreJcodemunchValue('head /x/big.ts', opts({ size: 20000 }))).toBeNull();
    expect(scoreJcodemunchValue('tail -n 50 /x/big.ts', opts({ size: 20000 }))).toBeNull();
  });

  it('does not divert a sed -n range print', () => {
    expect(scoreJcodemunchValue("sed -n '10,20p' /x/big.ts", opts({ size: 20000 }))).toBeNull();
  });

  it('returns null for unrelated commands', () => {
    expect(scoreJcodemunchValue('find . -name "*.ts"', opts())).toBeNull();
    expect(scoreJcodemunchValue('git status', opts())).toBeNull();
  });

  it('diverts cat -n (line-number flag does not change whole-file semantics)', () => {
    expect(scoreJcodemunchValue('cat -n /x/big.ts', opts({ size: 20000 }))).toMatchObject({ shape: 'outline' });
  });

  it('does not divert at exactly the byte threshold (strict >)', () => {
    expect(scoreJcodemunchValue('cat /x/big.ts', opts({ size: 8192 }))).toBeNull();
  });

  it('diverts one byte above the threshold', () => {
    expect(scoreJcodemunchValue('cat /x/big.ts', opts({ size: 8193 }))).toMatchObject({ shape: 'outline' });
  });

  it('does not divert a quoted path with spaces (quote-naive parse — known v1 limitation)', () => {
    expect(scoreJcodemunchValue('cat "src/my file.ts"', opts({ size: 20000 }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/router/jcodemunch-value.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`src/router/jcodemunch-value.ts` (Shape A only this task; Shape B is Task 4):

```ts
import { extname } from 'node:path';

const CODE_EXTENSIONS = new Set<string>([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java',
  '.kt', '.scala', '.rb', '.php', '.cs', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.swift', '.vue', '.svelte', '.elixir', '.ex', '.exs', '.clj', '.cljs',
  '.hs', '.ml', '.fs', '.dart', '.lua', '.pl', '.r', '.jl',
]);

export interface DivertDecision {
  shape: 'outline' | 'symbol';
  jmTool: string;
  reason: string;
  target: string;
}

export interface DivertOptions {
  existsCheck: (p: string) => boolean;
  statCheck: (p: string) => { size: number; isFile: boolean };
  outlineBytes: number;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Tokenize a command into the binary + non-flag args + flag set (quote-naive, sufficient for v1). */
function parse(command: string): { binary: string; positional: string[]; flags: Set<string> } {
  const tokens = command.trim().split(/\s+/);
  return {
    binary: tokens[0] ?? '',
    positional: tokens.slice(1).filter(t => !t.startsWith('-')),
    flags: new Set(tokens.slice(1).filter(t => t.startsWith('-')).map(t => t.replace(/=.*$/, ''))),
  };
}

export function scoreJcodemunchValue(command: string, opts: DivertOptions): DivertDecision | null {
  const { binary, positional } = parse(command);

  // Shape A — big-file structural read (`cat` only)
  if (binary === 'cat') {
    if (positional.length !== 1) return null;
    const target = positional[0];
    if (!opts.existsCheck(target)) return null;
    const stat = opts.statCheck(target);
    if (!stat.isFile) return null;
    if (!CODE_EXTENSIONS.has(extname(target))) return null;
    if (stat.size <= opts.outlineBytes) return null;
    return {
      shape: 'outline',
      jmTool: 'mcp__jcodemunch__get_file_outline',
      target,
      reason: `${target} is large; the outline gives its structure for far fewer tokens than reading the whole file (rtk would still return every line).`,
    };
  }

  return null; // Shape B added in Task 4
}
```

(`IDENT` is defined here for Task 4; leaving it unused this task is fine — or defer its addition to Task 4. Prefer adding it in Task 4 to avoid an unused-symbol lint here.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/router/jcodemunch-value.test.ts`
Expected: PASS (all Shape A cases).

- [ ] **Step 5: Commit**

```bash
git add src/router/jcodemunch-value.ts tests/router/jcodemunch-value.test.ts
git commit -m "feat(router): jcodemunch-value heuristic — Shape A (big-file cat outline)"
```

---

### Task 4: Heuristic module — Shape B (identifier `grep` symbol search)

**Files:**
- Modify: `src/router/jcodemunch-value.ts` (extend `scoreJcodemunchValue`)
- Modify: `tests/router/jcodemunch-value.test.ts` (add Shape B cases)

**Interfaces:**
- Produces: Shape B returns `{ shape: 'symbol', jmTool: 'mcp__jcodemunch__search_symbols', target: <pattern>, reason: <…> }`. Exports `IDENT` regex (or keeps it module-local).
- Consumes: Task 3's `scoreJcodemunchValue`, `DivertOptions`, `parse`.

**Depends on: Task 3** (same files — not parallelizable).

- [ ] **Step 1: Write the failing tests**

Add to `tests/router/jcodemunch-value.test.ts`:

```ts
describe('scoreJcodemunchValue — Shape B (identifier grep symbol search)', () => {
  it('diverts a single-identifier grep to search_symbols', () => {
    const d = scoreJcodemunchValue('grep -r calculateScore src/', opts());
    expect(d).toMatchObject({ shape: 'symbol', jmTool: 'mcp__jcodemunch__search_symbols', target: 'calculateScore' });
  });

  it('still diverts with --word-regexp (-w)', () => {
    expect(scoreJcodemunchValue('grep -rw FooBar .', opts())).toMatchObject({ shape: 'symbol' });
  });

  it('still diverts with rg and case-insensitive (-i)', () => {
    expect(scoreJcodemunchValue('rg -i MyType src/', opts())).toMatchObject({ shape: 'symbol', target: 'MyType' });
  });

  it('does not divert a regex pattern (contains metacharacters)', () => {
    expect(scoreJcodemunchValue('grep "foo.bar" src/', opts())).toBeNull();
    expect(scoreJcodemunchValue('grep -r "a|b" .', opts())).toBeNull();
  });

  it('does not divert a multi-token / literal phrase pattern', () => {
    expect(scoreJcodemunchValue('grep "some phrase" .', opts())).toBeNull();
    expect(scoreJcodemunchValue('grep -r TODO .', opts())).toBeNull();
  });

  it('does not divert --files-with-matches (-l)', () => {
    expect(scoreJcodemunchValue('grep -rl FooBar .', opts())).toBeNull();
  });

  it('diverts --regexp=PATTERN (the = form)', () => {
    expect(scoreJcodemunchValue('grep --regexp=FooBar src/', opts())).toMatchObject({ shape: 'symbol', target: 'FooBar' });
  });

  it('does not divert multiple -e patterns (an OR query search_symbols cannot express)', () => {
    expect(scoreJcodemunchValue('grep -e Foo -e Bar baz.ts', opts())).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/router/jcodemunch-value.test.ts -t "Shape B"`
Expected: FAIL — `grep`/`rg` currently fall through to `null`.

- [ ] **Step 3: Write minimal implementation**

In `src/router/jcodemunch-value.ts`, extend `scoreJcodemunchValue` (and use `flags` from `parse`). Add a `REGEX_METACHAR` test and the Shape B branch before the final `return null`:

```ts
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REGEX_METACHAR = /[.*+?^${}()|[\]\\/]/;

export function scoreJcodemunchValue(command: string, opts: DivertOptions): DivertDecision | null {
  const { binary, positional, flags } = parse(command);

  if (binary === 'cat') { /* …Shape A unchanged… */ }

  // Shape B — symbol-shaped search (grep / rg, single identifier token)
  if (binary === 'grep' || binary === 'rg' || binary === 'greprx') {
    if (flags.has('-l') || flags.has('--files-with-matches')) return null;
    // Collect every pattern source: space form (-e P / --regexp P) and the
    // attached `=` form (--regexp=P). Multiple patterns form an OR query that
    // search_symbols can't express → stay rtk (no divert).
    const tokens = command.trim().split(/\s+/);
    const patterns: string[] = [];
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === '-e' || t === '--regexp') {
        const v = tokens[i + 1];
        if (v !== undefined && !v.startsWith('-')) patterns.push(v);
      } else if (t.startsWith('--regexp=')) {
        patterns.push(t.slice('--regexp='.length));
      }
    }
    const pattern = patterns.length === 1
      ? patterns[0]
      : (patterns.length === 0 ? positional[0] : undefined);
    if (!pattern) return null;                        // multi-pattern OR, or none → rtk
    if (REGEX_METACHAR.test(pattern)) return null;    // regex/literal scan → rtk
    if (!IDENT.test(pattern)) return null;            // multi-token / phrase → rtk
    return {
      shape: 'symbol',
      jmTool: 'mcp__jcodemunch__search_symbols',
      target: pattern,
      reason: `${pattern} looks like a symbol; mcp__jcodemunch__search_symbols ranks definitions/references better than a text grep.`,
    };
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/router/jcodemunch-value.test.ts`
Expected: PASS (Shape A + Shape B).

- [ ] **Step 5: Commit**

```bash
git add src/router/jcodemunch-value.ts tests/router/jcodemunch-value.test.ts
git commit -m "feat(router): jcodemunch-value heuristic — Shape B (identifier grep symbol search)"
```

---

### Task 5: Hook Step 2.5 — divert before the rtk rewrite

**Files:**
- Modify: `src/router/hook.ts` — `HookOptions` (add `statCheck?`), and insert Step 2.5 between Step 2 (`:271-280`) and Step 3 (`:282-290`)
- Test: `tests/router/hook.test.ts` (new describe; reuse `makeEnv`/`SessionCache` idiom at `:30-66`)

**Interfaces:**
- Consumes: `scoreJcodemunchValue` (Task 3/4), `DIVERT_READVISE_PERIOD` (Task 1), `config.rules.tool_routing.jcodemunch_divert` + `.jcodemunch_divert_outline_bytes` (Task 2), `cache.shouldAdvise(key, period)`, `isCompoundCommand` (already imported).
- Produces: on a high-value shape the hook returns an `EnforcementViolation` (`{ level: 'advise' | 'block', message }`) naming the jm tool and **does not** reach the rtk `execRewrite`. Suppressed turns fall through to Step 3 (rtk runs).

**Depends on: Tasks 1, 2, 3, 4.** (Integration point — run after all of them.)

- [ ] **Step 1: Write the failing tests**

Add to `tests/router/hook.test.ts`:

```ts
import { statSync } from 'node:fs';
import { scoreJcodemunchValue } from '../../src/router/jcodemunch-value.js'; // only if referenced

describe('handlePreToolUse — jcodemunch divert (Step 2.5)', () => {
  const bigExists = (p: string) => p === '/x/big.ts';
  const bigStat = () => ({ size: 20000, isFile: true });

  it('diverts a big cat to a jcodemunch advisory and does NOT call rtk', () => {
    const cache = new SessionCache();
    cache.setEnvironment(makeEnv({ rtkAvailable: true, rtkPath: '/usr/bin/rtk', jcodemunchAvailable: true, jcodemunchCwdIndexed: true }));
    const rtkShouldNotRun = (): never => { throw new Error('rtk execRewrite must not be called on a divert'); };
    const result = handlePreToolUse('Bash', { command: 'cat /x/big.ts' }, cache, config, undefined, {
      execRewrite: rtkShouldNotRun,
      existsCheck: bigExists,
      statCheck: bigStat,
    });
    expect(result).toMatchObject({ level: 'advise' });
    expect(JSON.stringify(result)).toContain('mcp__jcodemunch__get_file_outline');
  });

  it('falls through to rtk on a suppressed divert turn', () => {
    const cache = new SessionCache();
    cache.setEnvironment(makeEnv({ rtkAvailable: true, rtkPath: '/usr/bin/rtk', jcodemunchAvailable: true, jcodemunchCwdIndexed: true }));
    const opts = { execRewrite: () => ({ command: 'rtk cat /x/big.ts', autoAllow: true }), existsCheck: bigExists, statCheck: bigStat };
    expect(handlePreToolUse('Bash', { command: 'cat /x/big.ts' }, cache, config, undefined, opts)).toMatchObject({ level: 'advise' }); // 1st: divert
    // 2nd + 3rd suppressed → rtk rewrite returned
    for (let i = 0; i < 2; i++) {
      const r = handlePreToolUse('Bash', { command: 'cat /x/big.ts' }, cache, config, undefined, opts) as { type?: string };
      expect(r?.type).toBe('rewrite');
    }
  });

  it('blocks at jcodemunch_divert: block', () => {
    const cache = new SessionCache();
    cache.setEnvironment(makeEnv({ rtkAvailable: true, rtkPath: '/usr/bin/rtk', jcodemunchAvailable: true, jcodemunchCwdIndexed: true }));
    const blockConfig = { ...config, rules: { ...config.rules, tool_routing: { ...config.rules.tool_routing, jcodemunch_divert: 'block' as const } } };
    const result = handlePreToolUse('Bash', { command: 'cat /x/big.ts' }, cache, blockConfig, undefined, { existsCheck: bigExists, statCheck: bigStat });
    expect(result).toMatchObject({ level: 'block' });
  });

  it('falls through to rtk when jcodemunch_divert is silent', () => {
    const cache = new SessionCache();
    cache.setEnvironment(makeEnv({ rtkAvailable: true, rtkPath: '/usr/bin/rtk', jcodemunchAvailable: true, jcodemunchCwdIndexed: true }));
    const silentConfig = { ...config, rules: { ...config.rules, tool_routing: { ...config.rules.tool_routing, jcodemunch_divert: 'silent' as const } } };
    const result = handlePreToolUse('Bash', { command: 'cat /x/big.ts' }, cache, silentConfig, undefined, {
      execRewrite: () => ({ command: 'rtk cat /x/big.ts', autoAllow: true }), existsCheck: bigExists, statCheck: bigStat,
    }) as { type?: string };
    expect(result?.type).toBe('rewrite');
  });

  it('does not divert when jcodemunch is not ready (rtk runs)', () => {
    const cache = new SessionCache();
    cache.setEnvironment(makeEnv({ rtkAvailable: true, rtkPath: '/usr/bin/rtk', jcodemunchAvailable: true, jcodemunchCwdIndexed: false }));
    const result = handlePreToolUse('Bash', { command: 'cat /x/big.ts' }, cache, config, undefined, {
      execRewrite: () => ({ command: 'rtk cat /x/big.ts', autoAllow: true }), existsCheck: bigExists, statCheck: bigStat,
    }) as { type?: string };
    expect(result?.type).toBe('rewrite');
  });

  it('does not divert a low-value grep (rtk runs)', () => {
    const cache = new SessionCache();
    cache.setEnvironment(makeEnv({ rtkAvailable: true, rtkPath: '/usr/bin/rtk', jcodemunchAvailable: true, jcodemunchCwdIndexed: true }));
    const result = handlePreToolUse('Bash', { command: 'grep -r TODO .' }, cache, config, undefined, {
      execRewrite: () => ({ command: 'rtk grep TODO .', autoAllow: true }),
    }) as { type?: string };
    expect(result?.type).toBe('rewrite');
  });

  it('does not divert a compound command (Step 2.5 skipped → pass-through)', () => {
    const cache = new SessionCache();
    cache.setEnvironment(makeEnv({ rtkAvailable: true, rtkPath: '/usr/bin/rtk', jcodemunchAvailable: true, jcodemunchCwdIndexed: true }));
    const result = handlePreToolUse('Bash', { command: 'cat /x/big.ts && cat /y/big.ts' }, cache, config, undefined, { existsCheck: bigExists, statCheck: bigStat });
    expect(result).toBeNull();
  });

  it('block level is never suppressed (blocks on every call)', () => {
    const cache = new SessionCache();
    cache.setEnvironment(makeEnv({ rtkAvailable: true, rtkPath: '/usr/bin/rtk', jcodemunchAvailable: true, jcodemunchCwdIndexed: true }));
    const blockConfig = { ...config, rules: { ...config.rules, tool_routing: { ...config.rules.tool_routing, jcodemunch_divert: 'block' as const } } };
    const first = handlePreToolUse('Bash', { command: 'cat /x/big.ts' }, cache, blockConfig, undefined, { existsCheck: bigExists, statCheck: bigStat });
    const second = handlePreToolUse('Bash', { command: 'cat /x/big.ts' }, cache, blockConfig, undefined, { existsCheck: bigExists, statCheck: bigStat });
    expect(first).toMatchObject({ level: 'block' });
    expect(second).toMatchObject({ level: 'block' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/router/hook.test.ts -t "jcodemunch divert"`
Expected: FAIL — Step 2.5 doesn't exist; big `cat` currently rewrites to rtk (the "does NOT call rtk" test throws / the rewrite-type assertions see rtk output).

- [ ] **Step 3: Write minimal implementation**

In `src/router/hook.ts`:

1. Add to imports:
```ts
import { scoreJcodemunchValue } from './jcodemunch-value.js';
import { DIVERT_READVISE_PERIOD } from '../session/cache.js';
```

2. Extend `HookOptions` (around `:17-22`) with a `statCheck`:
```ts
export interface HookOptions {
  execRewrite?: ExecRewriteFn;
  existsCheck?: ExistsCheckFn;
  statCheck?: (p: string) => { size: number; isFile: boolean };
  branchExec?: ExecFn;
}
```

3. Insert Step 2.5 between Step 2 (`:271-280`) and Step 3 (`:282-290`):
```ts
  // Step 2.5: jcodemunch divert — for high-value Bash read/search shapes,
  // advise jcodemunch INSTEAD of rewriting to rtk (Step 3). Suppressed turns
  // and silent level fall through to Step 3 so rtk still optimizes them.
  if (tool === 'Bash' && typeof args.command === 'string' && !isCompoundCommand(args.command)) {
    if (env.jcodemunchAvailable && env.jcodemunchCwdIndexed) {
      const outlineBytes = config.rules.tool_routing?.jcodemunch_divert_outline_bytes ?? 8192;
      const exists = resolvedOptions.existsCheck ?? ((p) => { try { return existsSync(p); } catch { return false; } });
      const stat = resolvedOptions.statCheck ?? ((p) => { try { const s = statSync(p); return { size: s.size, isFile: s.isFile() }; } catch { return { size: 0, isFile: false }; } });
      const decision = scoreJcodemunchValue(args.command, { existsCheck: exists, statCheck: stat, outlineBytes });
      if (decision) {
        const level = config.rules.tool_routing?.jcodemunch_divert ?? 'advise';
        if (level !== 'silent') {
          const key = `jm_divert:${decision.shape}`;
          if (level === 'advise' && !cache.shouldAdvise(key, DIVERT_READVISE_PERIOD)) {
            // suppressed this turn — fall through to rtk
          } else {
            const prefix = level === 'block' ? '[BLOCK]' : '[ADVISE]';
            return {
              level,
              message: [
                `${prefix} Tool Router: high-value jcodemunch opportunity (${decision.shape === 'outline' ? 'big-file outline' : 'symbol search'})`,
                `advise: use ${decision.jmTool} — ${decision.reason}`,
                level === 'block'
                  ? 'This operation is blocked by .harness.yaml. Use the recommended tool instead.'
                  : 'Consider using the recommended tool for better efficiency.',
              ].join('\n'),
            };
          }
        }
      }
    }
  }
```

(Add `import { appendFileSync, statSync, existsSync } from 'node:fs';` to `hook.ts` (only `appendFileSync` is imported today). The default `exists`/`stat` closures must not throw on missing paths — both are wrapped in try/catch; `stat` returns `{ size: 0, isFile: false }` on failure so a missing file reads as "not a code file / below threshold" rather than throwing.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/router/hook.test.ts`
Expected: PASS (existing router tests + the new divert cases). Also run the full suite: `npm test`.

- [ ] **Step 5: Commit**

```bash
git add src/router/hook.ts tests/router/hook.test.ts
git commit -m "feat(router): Step 2.5 jcodemunch divert for high-value Bash shapes"
```

---

### Task 6: Documentation

**Files:**
- Modify: `docs/architecture.md` (Layer 1 flow + intent/routing table)
- Modify: `README.md` (tool-routing description)

**Interfaces:** none (docs only).

**Depends on: Tasks 1–5** (describes the finished behavior).

- [ ] **Step 1: Update `docs/architecture.md` Layer 1**

In the Layer 1 flow diagram, add a "Step 2.5: jcodemunch divert" box between the python-env rewrite (Step 2) and the rtk rewrite (Step 3), with a one-line note: "high-value Bash shapes (big-file `cat`, identifier `grep`) → advise jcodemunch instead of rtk; suppressed/silent fall through to rtk." Add a row to the intent table for the divert (shapes `jm_divert:outline` / `jm_divert:symbol`, suppression period 3).

- [ ] **Step 2: Update `README.md`**

In the Tool Router bullet, note that high-value Bash read/search commands divert to jcodemunch (configurable via `tool_routing.jcodemunch_divert`), and add the two keys to the example `.harness.yaml` block.

- [ ] **Step 3: Verify build + lint + full suite**

Run: `npm run lint && npm test`
Expected: lint clean; all tests pass; coverage gate met.

- [ ] **Step 4: Commit**

```bash
git add docs/architecture.md README.md
git commit -m "docs: document jcodemunch divert (Step 2.5) in architecture + README"
```

---

## Self-Review (run after writing, fixed inline)

- **Spec coverage:** Shape A (Task 3) + Shape B (Task 4) ✓; Step 2.5 data flow (Task 5) ✓; config keys + defaults (Task 2) ✓; `DIVERT_READVISE_PERIOD = 3` shape-keyed suppression (Task 1) ✓; advisory message format (Task 5) ✓; testing strategy (every task) ✓; affected modules (File Structure) ✓. The spec's "session-start active-rules" item is intentionally dropped (documented deviation above).
- **Placeholder scan:** none — every code step has concrete code; file paths are exact (`cache.ts:247`, `types.ts:204-217`, `config.ts:14-27`, `hook.ts:271-290`, `start.ts:351`).
- **Type consistency:** `DivertDecision.shape` is `'outline' | 'symbol'` in Tasks 3/4/5; `shouldAdvise(intent, period)` signature consistent across Tasks 1 and 5; `jm_divert:${decision.shape}` keys (`jm_divert:outline` / `jm_divert:symbol`) consistent with Task 1 tests.
- **Known implementation nuance for Task 5:** the default `exists`/`stat` closures must not throw on missing paths (the heuristic already guards via `existsCheck`, but the closure passed in should use `existsSync` + try/catch around `statSync`). Flagged in the task body.

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-08-05-jcodemunch-nuanced-advisory.md`. Per the user's instruction, the next step is a review sub-agent (spec + plan vs current implementation), then implementation via `/tdd+` (inline) or `/sdd+` (subagent-driven) — Task 4 depends on Task 3, and Task 5 depends on 1–4, so most of this plan is sequential; Tasks 1, 2, and 3 are the only parallelizable trio.

# Nuanced jcodemunch advisory (precision divert)

- **Date:** 2026-08-05
- **Status:** Approved design (awaiting implementation plan)
- **Approach:** Approach 1 — precision divert, advise-level
- **Originating investigation:** debug+ root-cause trace of `jcodemunch: 0 queries` in `/savings`

## Background

A debug+ investigation traced why jcodemunch's per-session query count sits at 0
across many sessions despite the tool being installed and indexed. Root cause:

- jcodemunch detection is healthy (`jcodemunchAvailable && jcodemunchCwdIndexed`
  both true; transport resolved as `uvx jcodemunch-mcp` via Claude config).
- The router rewrites every Bash `grep`/`find`/`cat`/`head`/`tail` command to rtk
  and **short-circuits** (`src/router/hook.ts:286-288`) before the jcodemunch
  advisory step (`src/router/hook.ts:304-333`). The resolver also gives rtk
  strict priority over jcodemunch for the Bash intents
  (`src/router/resolver.ts:27-35`).
- jcodemunch advisories are therefore reachable **only** through the native
  Read/Grep/Glob tools (or through Bash intents when rtk declines a rewrite,
  which it normally doesn't), and those are first-occurrence suppressed
  (`ADVISORY_READVISE_PERIOD = 10`, `src/session/cache.ts:13`, `:247-265`).
- In Bash-heavy sessions (which rtk actively rewards by auto-allowing and
  token-optimizing), the agent rarely uses native tools, so no
  `mcp__jcodemunch__*` call ever fires. The counter only increments on an actual
  MCP call (`src/session/metrics.ts:221`); the `/savings` line reads jcodemunch's
  own `session_calls` (`templates/skills/savings/SKILL.md:50-54`).

This is by-design behavior, not a crash. The cost is real: in a Bash-heavy
workflow the agent gets *cheaper grep* (rtk) but not *smarter indexed/symbol
search* (jcodemunch).

## Goal

Make the router surface jcodemunch at genuinely high-value moments throughout a
session — when jcodemunch is unambiguously the better tool than an rtk-rewritten
Bash command — without nagging on commands where rtk is the right choice.

## Non-goals

- Do not remove or demote rtk. rtk keeps owning every Bash command that is not a
  high-value divert.
- Do not change the native-tool (Read/Grep/Glob) advisory path or its suppression.
- No model-driven intent classification, no session-behavior state machine in v1
  (deferred — see "Future").
- No change to the `/savings` computation or the counter increment rule.

## Core decision: divert, not add

For high-value Bash shapes the router advises jcodemunch **instead of**
rewriting to rtk, mirroring how native Read/Grep/Glob are handled today. This
reuses the existing advisory emission path (no hook-protocol change) and is
architecturally consistent.

Consequence accepted by design: at `advise` level a divert *suppresses the rtk
rewrite*, so if the agent ignores a fired nudge the **original** command runs
unoptimized (no rtk). This cost is bounded — see "Suppression."

## Architecture & data flow

New **Step 2.5** in `handlePreToolUse` (`src/router/hook.ts`), placed after the
python-rewrite (Step 2) and **before the rtk rewrite (Step 3)**, so a divert
wins over rtk for high-value shapes. The heuristic lives in a new pure module
`src/router/jcodemunch-value.ts`; the hook only calls it.

```
Bash cmd → Step 1 / 1.5 / 1.6  (blocks, test-scope, branch)   …unchanged
         → Step 2    python rewrite                             …unchanged
         → Step 2.5  NEW: if env.jcodemunchAvailable && env.jcodemunchCwdIndexed:
                       decision = scoreJcodemunchValue(command, existsCheck, statCheck)
                       if decision:
                         level = config.rules.tool_routing.jcodemunch_divert   // advise|block|silent
                         if level === 'silent': fall through → Step 3
                         if level === 'advise' && !shouldAdvise(key, DIVERT_READVISE_PERIOD):
                           fall through → Step 3          // suppressed: rtk still runs
                         return advisory(level, decision)  // DIVERT; Step 3 skipped
                       else: fall through → Step 3
         → Step 3    rtk rewrite                                …unchanged
         → Step 4/5  …unchanged
```

Gates and guards:

- Only `tool === 'Bash'` with a string `args.command`.
- **Compound commands skip divert** (same `isCompoundCommand` guard as Step 3).
- Gate on `env.jcodemunchAvailable && env.jcodemunchCwdIndexed` — identical to
  the resolver's jcodemunch branch. If jcodemunch is not ready, no divert and rtk
  runs as today (graceful degradation unchanged).
- Divert is a **pre-rewrite check parallel to python-rewrite**, not a new entry
  in the rules array. The rules table stays clean.

Key property: on suppressed turns rtk **still rewrites** the command (no token
penalty). The unoptimized-command cost is paid only on turns where the advisory
actually fires.

## The heuristic — `scoreJcodemunchValue`

Pure function:

```ts
interface DivertDecision {
  shape: 'outline' | 'symbol';
  jmTool: string;        // 'mcp__jcodemunch__get_file_outline' | '...__search_symbols'
  reason: string;        // human-readable, used in the advisory message
  target: string;        // file path or pattern, for the message
}
function scoreJcodemunchValue(
  command: string,
  existsCheck: (p: string) => boolean,
  statCheck: (p: string) => { size: number; isFile: boolean },
): DivertDecision | null
```

It returns a decision only for two high-confidence shapes. Everything else
returns `null` (fall through to rtk).

### Shape A — big-file structural read (`cat` only)

Diverts to `mcp__jcodemunch__get_file_outline` when **all** hold:

1. The command is a non-compound `cat` (the `file_read` intent). `head` and
   `tail` are deliberately excluded — they imply the agent wants a slice (the
   top or bottom of the file), not the whole file, so the outline is not the
   better tool. `sed -n` range prints are likewise excluded (not `cat`).
2. There is **exactly one** target file argument. Path resolves via
   `existsCheck` to an existing **file** (not a dir, not missing). Multiple file
   arguments (e.g. `cat a.ts b.ts`) do not divert.
3. The target is a **code file** — extension in the code-extension set:
   `.ts .js .tsx .jsx .mjs .cjs .py .go .rs .java .kt .scala .rb .php .cs .c .cc .cpp .h .hpp .swift .vue .svelte .elixir .ex .exs .erlang .clj .cljs .hs .ml .fs .dart .lua .pl .r .jl`.
4. `statCheck(path).size > jcodemunch_divert_outline_bytes` (default **8192**
   bytes ≈ 300 lines).

Why it is a clear win: `cat` outputs the entire file; rtk would cheaply return
all of it as undifferentiated text, while the outline gives the symbol skeleton
for a fraction of the tokens and conveys structure.

### Shape B — symbol-shaped search (`grep` / `rg`)

Diverts to `mcp__jcodemunch__search_symbols` when **all** hold:

1. The command is a non-compound `grep` or `rg` (the `text_search` intent).
2. The search pattern is a **single identifier token**: matches
   `^[A-Za-z_][A-Za-z0-9_]*$`. No spaces, no regex metacharacters
   (`. * [ ] ( ) | \ + ? { } $ ^ /`). The `-w` / `--word-regexp` flag
   reinforces symbol intent (still divert).
3. The pattern is **not** the `--files-with-matches` case: neither `-l` nor
   `--files-with-matches` is present (that wants a file list — low value; rtk /
   `get_file_tree` territory).

The pattern is identified from every pattern source — the first non-flag
positional argument, the value of `-e` / `--regexp` (space form), and the
attached `--regexp=PATTERN` (`=`) form. **Exactly one** pattern must be
specified: multiple `-e` / `--regexp` flags form a multi-pattern OR query that
`search_symbols` cannot express, so those do not divert. Other flags (`-r`,
`-i`, `--color`, `-n`, etc.) do not block the divert.

Why it is a clear win: the agent is looking for a symbol definition/references;
`search_symbols` (BM25 + embeddings + AST) ranks and locates it, versus rtk
returning raw matching lines.

### Explicitly never divert (stay rtk)

Resolved unambiguously by the predicates above: literal/regex scans (`TODO`,
`console.log`, `password`, multi-token patterns, patterns with metacharacters),
`find` / `ls` / `fd` discovery, git operations, `head` / `tail` (slice reads),
`sed -n` range prints, small-file reads, non-code files, multi-file `cat`, and
compound commands.

## Config & suppression

### Config (`.harness.yaml`)

New keys under the existing `rules.tool_routing` block:

```yaml
rules:
  tool_routing:
    jcodemunch_divert: advise                 # advise | block | silent (default advise)
    jcodemunch_divert_outline_bytes: 8192     # file-size threshold for Shape A
```

Extension points:

- `src/types.ts` — `ToolRoutingRules` (lines 204-217): add
  `jcodemunch_divert?: EnforcementLevel;` and
  `jcodemunch_divert_outline_bytes?: number;`.
- `src/config.ts` — `DEFAULT_CONFIG.rules.tool_routing` (lines 14-27): add
  `jcodemunch_divert: 'advise'` and `jcodemunch_divert_outline_bytes: 8192`.
  Layered merge already spreads `tool_routing` shallowly (line 79), so the new
  keys merge correctly.
- The divert step reads `config.rules.tool_routing.jcodemunch_divert` directly
  (it is **not** an intent in the rules array, so it does not go through
  `INTENT_CONFIG_KEYS` / `getEffectiveEnforcement` in `hook.ts:338-364`). A
  small local resolver with the same `advise | block | silent` semantics is fine.

Note: `read_line_threshold: 100` already exists for an unrelated purpose (native
Read advising). `jcodemunch_divert_outline_bytes` is distinct and applies only
to Shape A.

### Suppression — "throughout a session"

Divert advisories use a **separate, higher-frequency cycle** than generic
advisories, and are **keyed by shape** so the two nudges track independently:

- New constant `DIVERT_READVISE_PERIOD = 3` in `src/session/cache.ts` (alongside
  `ADVISORY_READVISE_PERIOD = 10`).
- Extend `shouldAdvise(intent: string, period = ADVISORY_READVISE_PERIOD): boolean`
  with an optional `period` parameter (existing callers unaffected — default
  preserves today's cycle of 1, 11, 21, …).
- Shape keys: `jm_divert:outline` and `jm_divert:symbol`. The divert step calls
  `shouldAdvise('jm_divert:outline', DIVERT_READVISE_PERIOD)` etc., producing a
  cycle of 1, 4, 7, … for each shape independently.
- `block` level is never suppressed (mirrors Step 5 behavior: only `advise`
  calls `shouldAdvise`).

The generic advisory cycle (`native_read` etc.) is untouched.

## Advisory message format

Advise-level (emitted as `additionalContext`, exit 0):

```
[ADVISE] Tool Router: high-value jcodemunch opportunity (big-file outline)
advise: use mcp__jcodemunch__get_file_outline — <file> is large; the outline
gives its structure for far fewer tokens than reading the whole file (rtk would
still return every line).
Consider using the recommended tool for better efficiency.
```

Block-level (stderr, exit 2): same content with the block framing used by the
existing Step 5 messages (`This operation is blocked by .harness.yaml. Use the
recommended tool instead.`).

Severity remains structural (the hook switches on `level`, never on the
`[ADVISE]`/`[BLOCK]` prefix — consistent with the existing contract documented
at `src/router/hook.ts:153-165`).

## Testing strategy

No mocks for environment/filesystem — injectable `existsCheck` / `statCheck`
(project convention: "No mocks for environment detection -- use injectable
ExecFn").

- **`scoreJcodemunchValue` unit tests** (new `tests/router/jcodemunch-value.test.ts`):
  - Shape A divert (large `.ts` file, plain `cat`).
  - Shape A no-divert: small file (< threshold), non-code extension, missing
    file, multi-file `cat a.ts b.ts`, `head` / `tail` (excluded),
    `sed -n '10,20p'` print.
  - Shape B divert (single identifier token, `grep FooBar src/`, with and
    without `-w`).
  - Shape B no-divert: regex metachar (`grep "foo.bar"`), multi-token
    (`grep "foo bar"`), literal scan (`grep TODO`), `-l` present.
  - Never-divert intents: `find`, `ls`, `git`, compound commands.
- **Hook integration** (`tests/router/hook.test.ts`):
  - High-value `cat` with jm ready → returns `{ level: 'advise', … }` naming the
    jm tool, and the rtk `execRewrite` is **not** invoked.
  - Suppressed turn (second occurrence) → rtk rewrite is returned (rtk runs).
  - `jcodemunch_divert: 'block'` → block path (exit-2 semantics).
  - `jcodemunch_divert: 'silent'` → falls through, rtk runs.
  - jm not ready (`jcodemunchCwdIndexed: false`) → no divert, rtk runs.
  - Compound command → no divert.
- **Suppression** (`tests/session/cache.test.ts`): `shouldAdvise(key, 3)`
  advises on 1, 4, 7, …; the default period still advises on 1, 11, 21, …;
  `jm_divert:outline` and `jm_divert:symbol` counters are independent.
- **Config** (`tests/config.test.ts`): new keys parsed, merged with defaults,
  absent-key falls back to defaults (`advise` / `8192`).
- **Coverage gate:** maintain ≥80% statements/functions/lines, ≥75% branches.

## Affected modules

- NEW `src/router/jcodemunch-value.ts` — the heuristic + `DivertDecision`.
- `src/router/hook.ts` — Step 2.5 wiring; reuse existing advisory return shape.
- `src/session/cache.ts` — `DIVERT_READVISE_PERIOD`, optional `period` param on
  `shouldAdvise`.
- `src/types.ts` — `ToolRoutingRules` additions.
- `src/config.ts` — `DEFAULT_CONFIG.rules.tool_routing` additions.
- `templates/` — `.harness.yaml` template gains the two keys; session-start
  active-rules output lists `jcodemunch_divert`; docs:
  `docs/architecture.md` "Layer 1" (new Step 2.5 + the divert heuristic) and the
  intent/routing table; `README.md` routing description.
- `tests/` mirror of the above.

## Tradeoffs & accepted costs

- **Ignored advise-level diverts run unoptimized.** Bounded by suppression: only
  ~1 of every 3 high-value-shape occurrences pays it; suppressed turns get rtk.
  Set `jcodemunch_divert: block` to eliminate the unoptimized fallback (at the
  cost of interrupting the cheap loop on every high-value shape).
- **Two shapes only in v1.** Semantic/phrase search ("how is X used") and
  reference/call-hierarchy questions are not detected; those remain rtk or
  reachable via native tools / scout. This is a deliberate precision choice to
  avoid false-positive diversions.
- **File-size proxy for "large".** Bytes, not lines; threshold tunable via
  `jcodemunch_divert_outline_bytes`.
- **Quote-naive command parsing.** `scoreJcodemunchValue` tokenizes on
  whitespace, so quoted paths with spaces (`cat "src/my file.ts"`) are not
  recognized as a single target and do not divert — a safe miss (no false
  positive), accepted as a v1 limitation. Multi-pattern OR queries (`grep -e Foo
  -e Bar`) and the `--regexp=PATTERN` form are handled.

## Future (deferred)

- **Approach 3 — behavioral scout-nudge layer.** A session-cache signal that,
  after >K read/search ops in one module area, emits a one-time "dispatch the
  scout agent (uses jcodemunch + graphify)" nudge. Catches the exploration
  pattern per-command shape cannot see. Clean seam: additive on top of this v1.
- **Phrase / reference queries** as additional divert shapes once v1's
  precision is validated in dogfooding.
- **Telemetry:** a divert counter (`jmDiverts`) in `metricCounters` to make the
  divert hit-rate observable in `/savings` (the existing `jmCalls` already
  rises when the agent follows a divert, which is the primary signal).

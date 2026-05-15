# Architecture

## Design principles

Rig is a **layered middleware** system. Each layer has one responsibility and
communicates through typed interfaces. Layers compose but don't couple -- the
tool router works without the enforcement pipeline, the skill chain works
without the scout agent.

**Key decisions:**

1. **Hooks over prompts** -- Enforcement runs as code (Claude Code hooks), not as persuasive text. Hooks can't be ignored by the agent.
2. **Typed over unstructured** -- `CodebaseMap`, `Resolution`, `IntentType` are typed data structures, not prose. Downstream code queries them programmatically.
3. **Config over convention** -- `.harness.yaml` controls enforcement levels. Users adjust thresholds without touching code.
4. **Compose over inherit** -- Enforcement checks are independent functions composed in `handlePostToolUse()`. Each check is testable in isolation.

These principles come from the [agentic-patterns](https://github.com/franklywatson/agentic-patterns) L2 and L3 levels. Rig is their working implementation.

---

## Layer 1: Tool Router

The tool router intercepts shell commands before Claude Code executes them.

```
User types: grep -r "TODO" src/
     |
PreToolUse Hook (handlePreToolUse)
     |
  +--------------------------------------+
  | Step 1: Resolution blocks            |
  |   file_modify, rtk_cat_code -> block |
  +--------------------------------------+
     |
  +--------------------------------------+
  | Step 2: Python env rewrite           |
  |   .py file in args?                  |
  |   .venv/bin/<cmd> exists? -> rewrite |
  |   uv available? -> uv run <cmd>      |
  +--------------------------------------+
     |
  +--------------------------------------+
  | Step 3: rtk transparent rewrite      |
  |   rtk available? -> redirect rtk     |
  +--------------------------------------+
     |
  +--------------------------------------+
  | Step 4: No match -> pass through     |
  +--------------------------------------+
     |
  +--------------------------------------+
  | Step 5: Enforcement-level resolves   |
  |   jcodemunch ready? -> advise jm     |
  +--------------------------------------+
     |
HookResult: { decision, reason } | { type: "rewrite", command }
```

**Files:** `src/router/intent.ts`, `src/router/rules.ts`, `src/router/resolver.ts`, `src/router/hook.ts`

### Intent types

| Intent | Matches | Resolution |
| ------ | ------- | ---------- |
| `native_read` | `Read` tool on code files (no offset/limit) | jcodemunch `get_file_outline` or `get_symbol` |
| `native_grep` | `Grep` tool | jcodemunch `search_text` |
| `native_glob` | `Glob` tool on code file patterns | jcodemunch `get_file_tree` |
| `rtk_cat_code` | `rtk cat` on code files | Block, redirect to jcodemunch |
| `text_search` | Bash `grep`, `rg` | rtk or jcodemunch `search_text` |
| `file_discovery` | Bash `find`, `fd` | jcodemunch `get_file_tree` |
| `file_read` | Bash `cat`, `head`, `tail` | rtk or jcodemunch `get_symbol` |
| `file_modify` | Bash `sed -i`, `awk >` | Block, redirect to Edit tool |

### Python environment detection

When a Bash command references a `.py` file, the router resolves the command
binary through the Python environment. No hardcoded tool names — the `.py`
file in args is the trigger.

Resolution chain:

1. `.venv/bin/<binary>` exists → rewrite to absolute venv path
2. `uv` available → rewrite to `uv run <command>`
3. Neither → pass through (no rewrite)

Python environment is detected at session start (`detectPythonEnv`) and cached
in `SessionCache`. Detection checks for `.venv/` directory and `which uv`.

**Files:** `src/router/python-rewrite.ts`, `src/session/python-env.ts`

### Priority chain

`_` (wildcard) -> `rtk` -> `jcodemunch` -> `claudeTool` -> `fallback` -> allow

The resolver checks each priority level. First match wins. The wildcard `_` always wins if present. If nothing matches, the command is allowed.

Native tool rules (Read, Grep, Glob) are placed before broader intent rules in the
rule array, so `findMatchingRule` returns the native-specific rule first. This prevents
circular advice where the router would suggest "use Grep" when the agent is already
on the Grep tool.

---

## Layer 2: Enforcement Pipeline

The enforcement pipeline runs after each tool use, checking for quality violations.

```
PostToolUse Hook (handlePostToolUse)
     |
+------------------+
| checkStaleTests   |  Source edited without test update?
+------------------+
| checkConstitutional| Mocks in test files?
+------------------+
| checkZeroDefect   |  Test output shows failures?
+------------------+
     |
Each check returns a violation message or null
     |
Combined violations joined as advisory output
     |
HookResult: { decision, reason }
```

> **Note:** `checkTestScope` exists in `src/enforcement/test-scope.ts` but is not
> yet wired into the pipeline. It redirects full-suite runs to scoped tests during
> `tdd+` phase when implemented.

### Enforcement levels

| Level | Behavior | Exit code |
| ----- | -------- | -------- |
| `block` | Hook exits nonzero, tool call rejected | 2 |
| `advise` | Warning printed, tool call proceeds | 0 |
| `silent` | Logged only, no output | 0 |

### Stale test detection

`FileTracker` records source/test edits with turn numbers. After a configurable
grace period, source edits without corresponding test edits trigger a warning.
The source's creation turn is exempt -- you don't get flagged for the edit you
just made.

### Test scope control

During `tdd+` phase, running the full test suite (e.g., `npm test`) is redirected to scoped runs targeting only the affected test file. This keeps iteration fast during red-green-refactor cycles.

### Constitutional rules

Regex-based detection of mocking patterns (`jest.mock`, `vi.mock`, `sinon.stub`, etc.) in
stack/E2E test files only. Unit test mocks are permitted for isolation.
All constitutional rules are configurable via `.harness.yaml` -- set `no_mocks: silent`
to disable no-mock enforcement, or `evidence_only: silent` to disable evidence-only
enforcement. Active rules are emitted in session-start output so skill templates can
reference them dynamically instead of hardcoding assumptions.

### Zero-defect check

Parses test output (vitest, jest, pytest patterns) for failure indicators. Classifies as pass, fail,
or unknown. Supports pre-existing failure classification via `git diff` — failures in untouched
files are reported separately from regressions based on `zero_defect.unrelated_errors` config.

**Files:** `src/enforcement/file-tracker.ts`, `src/enforcement/stale-test.ts`, `src/enforcement/test-scope.ts`, `src/enforcement/constitutional.ts`, `src/enforcement/zero-defect.ts`, `src/enforcement/post-tool-use.ts`

---

## Layer 3: Skill Chain Pipeline

Skills are ordered workflow stages. The `SkillPhaseTracker` enforces valid transitions.

```
brain+ -> plan+ -> tdd+ -> verify+ -> review+
   |        |       |        |          |
   |        |       |        |          +-- accessible from any phase
   |        |       |        +-- requires tdd+ visit
   |        |       +-- free transition
   |        +-- free transition
   +-- free transition

debug+ -- standalone, accessible from any phase
```

**Phase transition rules:**

- `review+` and `debug+` are accessible from any phase (no prerequisite)
- `verify+` requires a prior `tdd+` visit
- All other phases (`brain+`, `plan+`, `tdd+`) allow free transitions

Each skill wraps a `superpowers:*` skill with enforcement overlays. Skills are
SKILL.md files with YAML frontmatter. Templates reference active enforcement rules
from session-start context rather than hardcoding constitutional assumptions -- this
keeps template prose in sync with `.harness.yaml` configuration.

**Files:** `src/skills/phase-tracker.ts`, `templates/skills/`

### Standalone skills

`debug+` wraps `superpowers:systematic-debugging` with mandatory scout agent
context harvesting. It maps the affected code area before debugging, ensuring
the agent has full structural context. Accessible from any phase via `/debug+`.
`investigate` is a backward-compatible alias for `/debug+`.

`savings` reports rtk and jcodemunch token savings for the current session.
It has no phase prerequisite and is accessible at any time via `/savings`.
The session-start hook captures a `MetricsBaseline` (rtk's cumulative
saved-token count), and the post-tool-use hook increments rtk/jcodemunch
call counters. The `/savings` skill computes the delta and formats the report
via `formatSavingsReport()`. Graphify stats are tracked per-project in
`MetricsBaseline.graphifyStats` (a `Record<string, GraphifyProjectStats>`
keyed by absolute directory path). Single-project sessions render one line;
multi-project sessions render indented per-project lines with directory
basename labels.

**Files:** `src/session/metrics.ts`, `templates/skills/savings/SKILL.md`

---

## Layer 4: Scout Agent

The scout agent builds a typed `CodebaseMap` from jcodemunch indexes, enriched
with relationship context from graphify when available.

```
Scout agent invoked
     |
ensureIndexed(directory) -> jcodemunch auto-index
     |
ensureGraphBuilt(directory) -> graphify auto-build (if graphify available)
     |
buildCodebaseMap(index) -> CodebaseMap
     |
buildGraphContext() -> GraphContext (if graphify available)
     |
CodebaseMap: {
  structure: { path, type, symbolCount? }[],
  entryPoints: string[],
  keyExports: SymbolSummary[],
  dependencies: string[],
  languages: Record<string, number>,
  symbols: { functions, classes, types }
}
     |
GraphContext: {
  godNodes: { label, degree }[],
  communities: { id, label, nodeCount }[],
  stats: { nodes, edges, communities }
}
     |
Formatted as structured context for the agent
```

**jcodemunch** provides symbol search (BM25, embeddings, AST extraction).
**Graphify** provides relationship traversal (communities, dependency paths, god nodes).
They're complementary — jcodemunch answers "what exists?" and graphify answers "how do things connect?".

### Graphify integration

When graphify is installed, the scout agent and session-start hook gain three
additional capabilities:

**God nodes** — high-degree nodes in the knowledge graph, representing core
abstractions that many other modules depend on. These surface the most
architecturally important symbols in the codebase (e.g., a shared config module
or a base class that many components extend).

**Communities** — clustered groups of related nodes detected by graphify's
community detection algorithm. Each community represents a logical module or
subsystem, providing a higher-level view of code organization beyond directory
structure.

**Graph MCP tools** — session-start emits available graphify MCP tools for the
agent to use directly:

- `mcp__graphify__query_graph` — relationship queries between symbols
- `mcp__graphify__god_nodes` — core abstractions ranked by connection density
- `mcp__graphify__get_community` — module clustering for a specific community
- `mcp__graphify__shortest_path` — dependency path between two symbols

**Auto-building:** `ensureGraphBuilt()` automatically runs `graphify update
<directory>` when no graph exists for a directory. This happens for both the
main project and external directories referenced during cross-repo indexing.
If graphify is not installed, the scout agent falls back to jcodemunch-only
analysis (symbol search without relationship data).

**Confidence levels:** Graph edges carry confidence labels — `EXTRACTED`
(verified by AST analysis), `INFERRED` (heuristic), `AMBIGUOUS`. Session-start
reports these percentages (e.g., "90% EXTRACTED, 10% INFERRED") so agents can
gauge graph reliability.

**Cross-repo support:** `ensureIndexed()` indexes external directories on first
reference. `ensureGraphBuilt()` auto-builds graphify knowledge graphs for external
directories (runs `graphify update <dir>` if `<dir>/graphify-out/graph.json` doesn't
exist). `ScoutCache` with 30-min TTL prevents redundant indexing.

**Per-project stats:** Graphify stats are tracked per-directory in the session cache
as `Record<string, GraphifyProjectStats>`. The CWD project stats are captured at
session start. External directory stats are captured when `mcp__jcodemunch__index_folder`
is called on a non-CWD directory — the post-tool-use hook triggers a graphify build
if needed and stores the results. The `/savings` skill reports all projects.

**Entry point detection:** Derives from filename patterns: `index.*`, `main.*`, `cli.*`, `app.*`, `server.*`.

**Files:** `src/scout/mapper.ts`, `src/scout/cross-repo.ts`, `src/scout/scout-cache.ts`, `templates/agents/scout.md`

---

## Supporting modules

### Config (`src/config.ts`)

Loads `.harness.yaml` with layered merge (base config + local override). `getEnforcementLevel()` resolves level per rule.

### Session (`src/session/`)

`detectEnvironment()` checks for rtk, jcodemunch, graphify, and other tools via
injectable `ExecFn`. `SessionCache` with 30-min TTL persists to
`/tmp/rig-session-{cwd-hash}.json` for cross-process state sharing between hook
invocations. Environment detection results, edited file tracking, phase, metrics
baseline (including per-project graphify stats keyed by directory path), tool call
counters, and a `toolsWarned` flag all persist. `handleSessionStart()` auto-indexes
the project, captures a metrics baseline on first session, emits active enforcement
rules from `.harness.yaml` (so skill templates can reference them dynamically),
captures graphify graph stats for the CWD project when available, and emits a
one-time warning if rtk or jcodemunch are not installed (suppressed for the rest
of the session via the `toolsWarned` cache flag). A `[HINT]` is emitted when
graphify is not installed. `SessionCache` provides `getGraphifyStats(dir)` and
`setGraphifyStats(dir, stats)` accessors for per-directory graphify data.

### CLI (`src/cli/`)

`initCommand()` generates hooks, skills, agents, and config from templates via
`renderTemplate()` (`{{VAR}}` substitution). Registers hooks in
`.claude/settings.json` via `updateSettingsJson()` (idempotent, preserves
existing settings).

---

## Data flow: init command

```
npx rig init
     |
initCommand(options)
     |
copyTemplate() for each:
  - hooks/pre-tool-use.ts
  - hooks/post-tool-use.ts
  - hooks/session-start.ts
  - skills/brain-plus/SKILL.md
  - skills/plan-plus/SKILL.md
  - skills/tdd-plus/SKILL.md
  - skills/verify-plus/SKILL.md
  - skills/review-plus/SKILL.md
  - skills/verify-harness/SKILL.md
  - skills/savings/SKILL.md
  - agents/scout.md
     |
renderTemplate() replaces {{VAR}} placeholders
     |
updateSettingsJson() registers hooks in .claude/settings.json
     |
Writes .harness.yaml with default enforcement config
```

---

## Design decisions

Key design decisions:

| Decision | Rationale |
| -------- | ---------- |
| Hooks over preamble text | GStack uses persuasive instructions; we use programmatic hooks that can't be skipped |
| Typed CodebaseMap over prose context | Composable, queryable by downstream code |
| File-backed cache in /tmp | Cross-process state sharing; hooks are separate processes that need shared state. OS cleans /tmp automatically. |
| `npx` over global install | Lower barrier, no global package management |
| Separate `.harness.yaml` over CLAUDE.md injection | Cleaner separation of concerns, version-controllable |
| Static SKILL.md templates over resolver pipeline | Simpler for 5 skills; resolver pipeline deferred |

---

## Known limitations

- No auto-test generation for coverage gaps
- No mode-aware enforcement (same thresholds regardless of workflow phase)
- No multi-agent specialist review pattern (single review+ pass)
- No REPO_MODE awareness (solo vs collaborative)
- jcodemunch silently caps indexing at 2000 files per folder (`max_folder_files`
  in `~/.code-index/config.jsonc`). Session-start emits a `[WARNING]` when files
  are skipped, but search quality may be degraded for large projects until the
  limit is increased.
- graphify build may fail on very large codebases (6000+ files) due to Python
  AST recursion limits during tree-sitter traversal. The scout agent falls back
  to jcodemunch-only analysis and reports the failure.
- **Absolute paths and permission prompts**: Claude Code's system prompt (since
  v2.1.97) requires agents to use absolute paths unconditionally. Each new
  absolute path in a Bash command triggers a permission prompt unless pre-authorized.
  `rig init --broad-permissions` pre-authorizes common read-only operations to
  reduce this friction. Without the flag, users will see more approval dialogs —
  this is intentional (opt-in rather than silently granting broad access).
- **First-occurrence advisory suppression**: The tool router advises jcodemunch/scout
  once per intent type per session via `hasAdvised()`. If the agent ignores the first
  advisory, it receives no further reminders for that session. The jcodemunch detection
  fix (uvx support) ensures the advisory fires in the first place; suppression
  behavior itself is tracked for future work (periodic re-advisory or escalating urgency).

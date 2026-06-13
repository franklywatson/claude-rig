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
  | Step 0: Scout explore advisory       |
  |   Agent(Explore) + jcodemunch ready  |
  |   -> advise scout subagent           |
  +--------------------------------------+
     |
  +--------------------------------------+
  | Step 1: Resolution blocks            |
  |   file_modify, rtk_cat_code -> block |
  +--------------------------------------+
     |
  +--------------------------------------+
  | Steps 1.5 + 1.6: Bash preflight      |
  |   1.5: test scope (tdd+/sdd+ phase)  |
  |   1.6: branch discipline (git        |
  |        commit/push, protected branch)|
  |   collect-then-pick: any block wins  |
  |   over any advisory                  |
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
  |   4b: compound command -> skip       |
  |       advisory (blocks already won)  |
  +--------------------------------------+
     |
  +--------------------------------------+
  | Step 5: Enforcement-level resolves   |
  |   jcodemunch ready? -> advise jm     |
  +--------------------------------------+
     |
Emitted via hook protocol: advisory -> additionalContext JSON (exit 0)
                           block    -> stderr + exit 2
                           rewrite  -> updatedInput JSON (exit 0)
```

**Files:** `src/router/intent.ts`, `src/router/rules.ts`, `src/router/resolver.ts`, `src/router/hook.ts`, `src/router/branch-discipline.ts`

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
| `scout_explore` | `Agent` tool dispatching the `Explore` subagent | Advise scout subagent (jcodemunch + graphify) |

Git `commit`/`push` interception is not an intent type — it is handled by the
branch-discipline step (Step 1.6, see "Branch discipline (commit-time)" below).

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

### rtk rewrite diagnostics

`rtk rewrite` follows a four-code permission protocol (rtk
`src/hooks/rewrite_cmd.rs`): exit 0 + stdout = rewrite (safe to auto-allow),
exit 1 = no RTK equivalent, exit 2 = deny rule matched, exit 3 + stdout =
"Ask" verdict (rewrite valid, must not be auto-allowed). Rig uses exit-0 and
exit-3 rewrites identically because it never auto-allows — the hook emits
`updatedInput` without a `permissionDecision`, so Claude Code's own
permission flow applies to the rewritten command. Exits 1 and 2 fall through
silently to rig's own rules by design (stdout is never used on exit 2).
Anything outside the protocol (exit 3 without output, other exit codes,
signals, ENOENT) is appended as a JSON line to
`/tmp/rig-rtk-rewrite-failures.log` so silent fallthroughs are
debuggable in the field. Set `RIG_DEBUG=1` to log expected declines too.
Compound commands (pipes, `&&`, `;`) skip the rewrite entirely — the router
cannot safely rewrite one segment of a pipeline. Blocks are different:
destructive operations (`sed -i`, awk redirects) are detected in **every**
quote-aware segment of a compound command, so `echo ok && sed -i ...` is
blocked even though it would never be rewritten.

### Branch discipline (commit-time)

A Step 1.6 check (`src/router/branch-discipline.ts`, between the test-scope
check and the rewrite steps) intercepts `git commit` and `git push` when the
live branch is in `rules.workflow.protected_branches`. Like the destructive-op
blocks, it scans **every** quote-aware compound segment, so
`cd /tmp && git commit -m "x"` is still caught while `echo "git commit"`
(quoted) is not. At `advise` level (the default) the recommendation — a
worktree or a feature branch, resolved by `isolation_strategy` (`auto` picks
worktree when the working tree is dirty) — reaches the agent via the
agent-visible `additionalContext` channel on the **first occurrence and every
10th suppressed occurrence thereafter** (`SessionCache.shouldAdvise()`); the
commit proceeds.
At `block` level the command is rejected (exit 2) with remediation text every
time; `silent` disables the check. It runs before the rewrite steps because a
block must win over a rewrite. Git probes use the injectable `ExecFn`; any
git failure (not a repo, git missing) makes the check a no-op.

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
Combined violations joined; advise-level output emitted as
agent-visible additionalContext JSON, block-level as exit 2 + stderr
```

The handler also persists state the PreToolUse hook depends on: source/test
edits are recorded in the session cache (`addEditedFile`), and `Skill` tool
invocations of the chain skills (`tdd-plus`, `sdd-plus`, etc.) set the current
phase (`setPhase`). Hooks run as separate processes, so the session cache is
the only channel that crosses invocations.

A fourth check, `checkTestScope` (`src/enforcement/test-scope.ts`), runs in
the **PreToolUse** hook rather than this pipeline: its output is a scoped-run
redirect, which is only actionable before the full suite executes (see "Test
scope control" below).

### Enforcement levels

| Level | Behavior | Exit code |
| ----- | -------- | -------- |
| `block` | PreToolUse: tool call rejected, stderr shown to agent. PostToolUse: stderr fed back to agent as an error (tool already ran) | 2 |
| `advise` | Advisory emitted as agent-visible `additionalContext` JSON on stdout; tool call proceeds | 0 |
| `silent` | Logged only, no output | 0 |

Advise-level output uses the hook protocol's `hookSpecificOutput.additionalContext`
channel — Claude Code injects it next to the tool result so the **agent** sees
it. Plain text on exit 0 only reaches the human UI, which is why earlier
versions' advisories were invisible to the agent.

### Stale test detection

`FileTracker` records source/test edits with turn numbers. After a configurable
grace period, source edits without corresponding test edits trigger a warning.
The source's creation turn is exempt -- you don't get flagged for the edit you
just made.

**Turn model (cross-process):** hooks run as separate processes, so each
invocation builds a fresh `FileTracker` — an in-memory turn counter alone
would never advance and the creation-turn exemption would apply forever. A
"turn" is therefore defined as **one PostToolUse Edit/Write invocation**: the
counter and a turn-stamped edit history persist in the session cache, and the
handler hydrates the fresh tracker from that history before running the
check. With `grace_period: 0`, a source file edited in one invocation and
still uncovered by a matching test edit fires on the next Edit/Write
invocation — and keeps firing on subsequent ones until a covering test edit
is recorded. Entering `tdd+`/`sdd+` from another phase clears the history
along with the edited-file sets (the counter stays monotonic).

### Test scope control

During `tdd+` or `sdd+` phase, running the full test suite (e.g., `npm test`,
`npx vitest run`, `pytest`) triggers a redirect suggestion listing scoped test
files derived from the session's recorded source edits. This keeps iteration
fast during red-green-refactor cycles. The check runs in the **PreToolUse**
hook (before the suite executes); the phase comes from the session cache,
set when a chain skill is invoked. `rules.test_scope.enforcement` controls the
level (default `advise`; `block` rejects the command), and `allowed_unscoped`
patterns (e.g. `vitest watch`) are exempt. Unlike router advisories, test-scope
advisories are not first-occurrence-suppressed — every unscoped run is flagged.

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
brain+ -> plan+ -> tdd+|sdd+ -> verify+ -> review+
   |        |        |             |          |
   |        |        |             |          +-- accessible from any phase
   |        |        |             +-- requires tdd+ or sdd+ visit
   |        |        +-- free transition
   |        +-- free transition
   +-- free transition

debug+ -- standalone, accessible from any phase
```

**Phase transition rules:**

- `review+` and `debug+` are accessible from any phase (no prerequisite)
- `verify+` requires a prior `tdd+` or `sdd+` visit
- `sdd+` is a peer of `tdd+` (free transition; executes plans via typed
  subagents: `implementer`, `spec-reviewer`, `code-reviewer` from
  `.claude/agents/`)
- All other phases (`brain+`, `plan+`, `tdd+`, `sdd+`) allow free transitions

Each skill wraps a `superpowers:*` skill with enforcement overlays. Skills are
SKILL.md files with YAML frontmatter. Templates reference active enforcement rules
from session-start context rather than hardcoding constitutional assumptions -- this
keeps template prose in sync with `.harness.yaml` configuration.

**Files:** `src/skills/phase-tracker.ts`, `templates/skills/`

### Chain alternatives and standalone skills

`sdd+` wraps `superpowers:subagent-driven-development` with typed agent
dispatch: a fresh `implementer` subagent per plan task, followed by
`spec-reviewer` and `code-reviewer` subagents. Typed definitions live in
`.claude/agents/` (installed by `rig init`) and carry tool restrictions --
reviewers have no Edit/Write tools. Where the wrapped superpowers skill says
"general-purpose", the rig skill dispatches the typed agent with payload-only
prompts, falling back to general-purpose if the definition is missing.
`brain+` and `plan+` load `references/agent-loops.md` for the opt-in
signal-stack / maintainer-loop trajectory.

When Claude Code's experimental agent-teams feature is detected
(`Environment.agentTeamsAvailable`, from the `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`
flag) and `rules.workflow.team_execution` is not `never`, `sdd+`'s Phase A
preflight computes task independence from the plan's contract — disjoint
`**Files:**` lists and no `Depends on:` marker either way. If two or more tasks
are pairwise independent it offers team mode (at `offer`, asks once; at `auto`,
proceeds without asking), entering a parallel `Phase B-team`: at most three
worktree-isolated `implementer` teammates implement unblocked tasks on
`<plan-branch>-task-N` branches while the session acts as lead — running the
two-stage spec/code review on each completed branch and merging approved
branches into the plan branch in dependency order, re-running the suite after
each merge. The independence contract that gates this is authored in `plan+`
(every task's `**Files:**` list exhaustive; `Depends on:` markers for
order-only coupling). Absent the flag, at `never`, when declined, or with no
independent pair, `sdd+` uses the sequential dispatch unchanged — the team path
is strictly additive (the full parallelism model and worktree hook-coverage
behavior are in "Subagent operations" below).

### Subagent operations

Rig tunes the superpowers workflows for Claude Code's subagent hierarchy —
the orchestrator session dispatches typed agents, and the operational rules
below are what make that hierarchy reliable in practice:

- **Turn budgets are runaway backstops, not task estimates.** Each typed
  agent's `maxTurns` is set 5–10× expected usage (implementer 150, reviewers
  75/50, scout 30). A cap near expected usage truncates legitimate work
  silently — the agent's last narration line becomes its "result", which an
  orchestrator can mistake for completion. Every agent's prompt instructs it
  to stop at a safe point and report partial status when the budget nears,
  and truncated agents can be resumed with their context intact.
- **Code-writing subagents get isolated worktrees.** A long-running
  implementer shares the checkout's HEAD with the orchestrator — branch
  state is shared mutable state, and commits land wherever HEAD points at
  commit time. Dispatch implementers into a worktree; read-only agents
  (scout, reviewers) don't need isolation.
- **One implementer per branch/worktree — not one globally.** Within a single
  plan on a single branch, implementers run sequentially: tasks routinely
  share files and a merge chain, and two writers on one branch race. Across
  *orthogonal work items* — different branches, disjoint files, no
  merge-order dependency — implementers may run concurrently, each in its
  own worktree. The parallelization heuristic: read-only agents (scout,
  reviewers) are always parallelizable; implementers are parallelizable
  across branches; serialize only within a branch or across a merge chain.
- **Enforcement reaches subagents the same way it reaches the orchestrator**:
  advisories via `additionalContext`, blocks via exit 2, and the typed
  agents' system prompts instruct reading `.harness.yaml` at runtime.

**Hook coverage in worktrees (empirically probed).** Hooks fire for
subagent/teammate tool calls regardless of the command's working directory:
they run in the session process via `${CLAUDE_PROJECT_DIR}`, so a
`cd <worktree> && sed -i ...` issued from a worktree-isolated agent is
blocked by the router exactly as in the main checkout (observed: `[BLOCK]
Tool Router: file_modify operation blocked`, command never executed).
Config resolution inside a worktree cwd falls back to built-in defaults:
`.harness.yaml` is gitignored, so worktrees lack it, and `loadConfig`
resolves (rather than rejecting) with a config equal to `DEFAULT_CONFIG` —
enforcement still runs, at default levels, unless a `.harness.yaml` is
copied into the worktree. Session-cache writes from a worktree cwd land in a
per-worktree fragment (observed: a fresh `/tmp/rig-session-*.json` with
`"cwd"` set to the worktree path), invisible to `/savings` same-cwd matching
— the same fragmentation already documented for subdirectory contexts.
Teammates additionally carry enforcement in their typed system prompts, so
the hook layer and the prompt layer overlap rather than depend on each other.

**Agent teams.** Claude Code's experimental agent-teams feature maps onto
`sdd+`, and rig wires it per the cockpit pattern — detect, offer, degrade:

- **Detect.** Session start reads `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` (via
  the injectable env record in `detectEnvironment`) into
  `Environment.agentTeamsAvailable`, and the panel emits `agent-teams:
  available (experimental)` when set. `rules.workflow.team_execution`
  (`offer` | `auto` | `never`, default `offer`) gates use independently of
  detection.
- **Offer.** `sdd+`'s Phase A preflight derives task independence from the
  plan's contract — a task pair is independent when their `**Files:**` lists
  are disjoint and neither carries a `Depends on:` marker (the contract is
  authored in `plan+`, which requires exhaustive `**Files:**` lists). With two
  or more pairwise-independent tasks and `team_execution` not `never`: at
  `offer` rig asks once, at `auto` it proceeds silently.
- **Execute (Phase B-team).** A team named for the plan carries a shared task
  list mirroring the plan, `Depends on:` encoded as blocked-by edges so only
  unblocked tasks are claimable. At most three `implementer` teammates — never
  more than the count of currently-unblocked independent tasks — run
  worktree-isolated, each claiming one task and pushing a
  `<plan-branch>-task-N` branch. The session is **lead**: it runs the
  two-stage spec/code review on each completed branch, routes findings back as
  blocked tasks for a fresh implementer dispatch, and merges approved branches
  into the plan branch in dependency order, re-running the suite after each
  merge. On completion it shuts down teammates, deletes the team, and
  continues to Phase C as in sequential mode.
- **Degrade.** Absent the flag, at `never`, when the offer is declined, or
  with no independent pair, `sdd+` falls back to sequential
  implementer → spec-reviewer → code-reviewer dispatch, byte-for-byte
  unchanged. Team mode is strictly additive.

Turn budgets, worktree isolation, and enforcement apply to teammates exactly
as to any typed implementer dispatch — including the hook-coverage behavior in
worktrees recorded above (hooks fire session-level regardless of command cwd;
config falls back to defaults inside a worktree lacking `.harness.yaml`;
session-cache writes fragment per worktree cwd), so the parallelization
heuristic is unchanged: read-only agents always parallelizable, implementers
parallelizable across branches, serialized within a branch or a merge chain.

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

**Build-state reliability:** a valid `graph.json` (>1KB) means `ready` even
when the graphify CLI is off the hook PATH — the CLI is only needed for
rebuilding. graphify leaves `.rebuild.lock` behind after completed builds, so
detection compares mtimes: graph newer than lock = ready (stale lock), lock
newer = building. `graphify update` can return before `graph.json` lands, so
session-start polls up to 5s for the output instead of caching a false
failure, and a cached `failed` state is re-validated against the disk before
being trusted. Build failures carry an `errorReason` (timeout vs AST
recursion vs missing CLI), rendered as `build failed (<reason>)` at session
start. Stats capture is timeout-bounded and warns on `GRAPH_REPORT.md`
format drift; building a graph via `Bash(graphify update <dir>)` also
triggers per-project stats capture in the PostToolUse hook.

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
injectable `ExecFn`. `SessionCache` with a 4-hour env TTL persists to
`/tmp/rig-session-{hash}.json` (hash of cwd + session id) for cross-process
state sharing between hook invocations. Environment detection results, edited
file tracking, phase, metrics baseline (including per-project graphify stats
keyed by directory path), tool call counters, and a `toolsWarned` flag all
persist. Deleting `/tmp/rig-session-*.json` forces immediate re-detection.

**jcodemunch detection** (`environment.ts` + `claude-config.ts`) resolves a
working transport in priority order:

1. `jcodemunch` CLI binary on PATH
2. **The MCP server command registered in Claude Code's own config** —
   `~/.claude.json` (local scope `projects[cwd].mcpServers`, then user scope)
   and `<cwd>/.mcp.json` (project scope). This is ground truth: it handles
   installs a PATH probe can never find, e.g. `uvx --from <wheel-url>
   jcodemunch-mcp` from a GitHub release.
3. `jcodemunch-mcp` binary on PATH
4. Bare `uvx jcodemunch-mcp` (PyPI installs only)

The winning transport is recorded on `Environment.jcodemunchTransport` and
reused verbatim for session-start auto-indexing — it is never re-derived.
CWD-to-repo matching prefers exact `source_root` paths from `list_repos`,
falling back to strict basename equality. The MCP `initialize` response's
`protocolVersion` is validated (warn-only), and rtk/graphify versions are
probed for diagnostics (graphify warns outside its tested range).

**Headroom detection** (`headroom.ts`): session start records whether the
[Headroom](https://github.com/chopratejas/headroom) compression proxy is
configured for the project (`headroom-init-claude` hook marker or a localhost
`ANTHROPIC_BASE_URL` in project, local, or user settings scope) as
`Environment.headroomInitialized`. When set, the `/savings` skill runs
`headroom perf --format json` (timeout-bounded, schema-validated) and reports
context-layer compression on its own line — never summed with tool-layer
savings, which it overlaps at the rtk boundary.

`handleSessionStart()` auto-indexes the project through the detected
transport, captures a metrics baseline on first session (with `rtk gain`
schema validation — format drift warns instead of silently zeroing savings),
emits active enforcement rules from `.harness.yaml` (so skill templates can
reference them dynamically), captures graphify graph stats for the CWD
project when available (parse-drift and benchmark-fallback warnings
surfaced), and emits a one-time warning if rtk or jcodemunch are not
detected — including a pointer to `claude mcp list` and an orphaned-index
warning when `~/.code-index` holds data but no transport works. A `[HINT]`
is emitted when graphify is not installed. `SessionCache` provides
`getGraphifyStats(dir)` and `setGraphifyStats(dir, stats)` accessors for
per-directory graphify data.

Session start also runs `checkBranchDiscipline` (`src/session/worktree.ts`):
when the session opens on a branch listed in
`rules.workflow.protected_branches` (default `master`/`main`), it emits a
one-line hint naming the active level and the recommended isolation —
worktree vs feature branch, resolved by `isolation_strategy` (`worktree` and
`branch` force the answer; `auto` recommends a worktree when `git status
--porcelain` shows a dirty tree, a plain branch otherwise). `silent` level
suppresses the hint; outside a git repo it is a no-op. The same
`rules.workflow` config drives the tool router's commit-time check (Layer 1,
Step 1.6). `checkWorktreeSuggestion` remains as a deprecated wrapper over the
default config.

### CLI (`src/cli/`)

`initCommand()` generates hooks, skills, agents, and config from templates via
`renderTemplate()` (`{{VAR}}` substitution). Registers hooks in
`.claude/settings.json` via `updateSettingsJson()` (idempotent, preserves
existing settings).

---

## Behavioral eval harness (`evals/`)

The deterministic test suite is **model-independent by construction** — it never
runs through a model, so it cannot observe model-driven behavior change. The
`evals/` harness closes that gap: it drives the real skill chain through a real
model via `claude -p` and asserts on observable behavior.

In the agent-loops vocabulary it is the **L2 (evaluation-quality) instrument**
for rig's own skills — frozen reference scenarios (fixture project briefs) with
human-validated expected behavior, re-evaluated by the current model+prompt.

```
npm run eval [--model M] [--scenario ID] [--runs K]
     |
runner.main()
     |
for each scenario (N-of-M runs):
  session-driver.ts: scaffold temp project -> rig init -> write brief
            -> claude -p <prompt> --model M --output-format stream-json
            -> capture transcript -> track temp dir + session fragments
  grade.ts: extractAssistantText (visible output only) -> structural match
            (loop-specific tokens; judge fallback on the negative case)
  reduce.ts: majority vote -> EvalReport
  teardown: remove exactly the tracked paths
```

**Separation from `npm test`:** `evals/` is excluded from the vitest run
(`vitest.config.ts`); its live `claude -p` runs are the harness's *output*, not
part of the deterministic suite. The harness's own pure logic (matchers, the
N-of-M reducer, the report builder) **is** unit-tested under `tests/evals/`
with canned recorded transcripts — no live model in the unit tests.

**Model robustness:** invariants assert facts a correct system produces under
any model; the opt-in is keyed on `agent-loop pattern` / `maintainer
trajectory` (not the ambient `signal stack`); grading uses visible text only;
the judge is confined to one binary fact on the negative case. Running the
suite under two models and diffing the reports is the drift check the
deterministic suite cannot produce.

**Deferred (operator-gated):** a nightly, non-gating CI lane with an
`ANTHROPIC_API_KEY` secret is specified in `evals/README.md` but not built —
it commits credentials and recurring spend. Until then, run `npm run eval`
locally before releases and after model changes.

See `evals/README.md` for usage and the full design.

## Data flow: init command

```
npx rig init
     |
initCommand(options)
     |
copyTemplate() for each:
  - hooks: pre-tool-use.ts, post-tool-use.ts, session-start.ts
  - skills (10): brain-plus, plan-plus, tdd-plus, sdd-plus,
    verify-plus, review-plus, debug-plus, verify-harness,
    savings, investigate
  - agents (4): scout.md, code-reviewer.md, spec-reviewer.md,
    implementer.md
  - references: agent-loops.md installed into
    skills/brain-plus/references/ and skills/plan-plus/references/
     |
renderTemplate() replaces {{VAR}} placeholders
     |
updateSettingsJson() registers hooks in .claude/settings.json
     |
Writes .harness.yaml with default enforcement config
  (only if absent — never reset, even with --force)
     |
Creates graphify-out/ (graph built on demand)
     |
Updates .gitignore with the rig-managed section
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
| Static SKILL.md templates over resolver pipeline | Simpler for 10 skills; resolver pipeline deferred |

---

## Known limitations

- No auto-test generation for coverage gaps
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
- **Advisory suppression with periodic re-advisory**: The tool router advises
  jcodemunch/scout on the first occurrence per intent type, then suppresses
  repeats — but re-advises on every 10th suppressed occurrence
  (`SessionCache.shouldAdvise()`; calls 1, 11, 21, ... advise). Branch-discipline
  advisories follow the same cycle. An ignored advisory therefore resurfaces
  periodically instead of disappearing for the session, at the cost of the
  agent occasionally seeing a reminder it has already dismissed. The cycle
  length is fixed (not configurable). For deterministic routing (demos, strict
  projects), set the `tool_routing` rules to `block` in `.harness.yaml` —
  blocks cannot be ignored.
- **Cache fragmentation across cwd/session-id**: session cache files are keyed
  by (cwd, session id), so hooks running from a subdirectory or a subagent
  context write advisory state and savings counters to separate files.
  `/savings` recovers the same-cwd counter fragments (subagent contexts,
  different session ids): it aggregates every `/tmp/rig-session-*.json` whose
  `cwd` matches the project, summing `metricCounters` across them and taking
  the baseline/environment from the most recent file. Staleness is anchored
  to the most recent file's `metricsBaseline.capturedAt` (session-start
  recaptures the baseline every session), with 24 hours as an outer bound.
  Subdirectory-context fragments are **not** recovered — a hook running from
  a subdirectory writes a cache keyed by that different `cwd`, which never
  matches the project directory, so its counters stay invisible to
  `/savings`. Advisory-state fragmentation also remains: a fragmented cache
  can repeat an advisory sooner than the periodic re-advisory cycle intends
  (see "Advisory suppression with periodic re-advisory" above).

# Graphify Integration Redesign — Design Context

> **Status:** Executed — investigation/design context consumed by the shipped graphify redesign; archived 2026-06-17


## Investigation Results

### Graphify CLI Lifecycle (exercised on ~/tools/hermes-agent)

**Build command:** `graphify update <path>` (not "build")

**Timing:**

- Full build: ~28 seconds for 1360 files (~3M words)
- Incremental update: ~23 seconds (no incrementality observed — re-extracts all files)
- Query commands: ~1 second on 41K-node graph

**Output artifacts:**

| File | Size | Contents |
| --- | --- | --- |
| `graphify-out/graph.json` | 74 MB | NetworkX node-link-data format |
| `graphify-out/GRAPH_REPORT.md` | 154 KB | Human-readable corpus stats, communities, god nodes |
| `graphify-out/cache/` | 54 MB | Per-file AST extraction cache (1360 JSON files) |

**hermes-agent graph stats:** 40,994 nodes, 129,501 edges, 439 communities

**No LLM needed** — entire pipeline is AST-based. Token cost: 0 input / 0 output.

**Broken commands in v0.4.16:**

- `cluster-only` crashes with `KeyError: 'total_files'`
- `watch` requires optional `watchdog` package

**Package name:** `graphifyy` (double-y) on PyPI, binary may be `graphify` or `graphifyy` depending on install method.

---

### Graphify Build Pipeline (source review)

Six-step pipeline orchestrated in `_rebuild_code()` (watch.py:15-93):

1. **Detect** (detect.py:337) — classify files, count words, emit corpus warnings
2. **Extract** (extract.py:3030) — two-pass AST extraction via tree-sitter (30+ languages)
3. **Build** (build.py:29/69) — merge extractions into NetworkX graph with three-layer dedup
4. **Cluster** (cluster.py:59) — Leiden community detection (falls back to Louvain)
5. **Analyze** (analyze.py) — god nodes, surprising connections, suggested questions
6. **Export** (export.py:282) — write graph.json, GRAPH_REPORT.md

**Confidence levels on edges:** EXTRACTED (AST-verified, score 1.0), INFERRED (heuristic, 0.8), AMBIGUOUS (0.5)

**MCP tools exposed** (serve.py:150-368): query_graph, get_node, get_neighbors, get_community, god_nodes, graph_stats, shortest_path

---

### Current Rig Integration — Problems Found

#### 1. Placeholder graph fools detection

`rig init` creates `{"nodes": [], "links": []}` (init.ts:102-108). `detectGraphify()`
(environment.ts:67-69) returns `available: true` when graph.json exists, regardless of content.
Agent sees "graphify available" but all MCP queries return empty results.

#### 2. No auto-build at session start

`ensureGraphBuilt()` (cross-repo.ts:57-81) only runs for external directories via the scout agent.
Session-start hook (start.ts) only reads existing stats — never triggers a build.
First session after `rig init` always has an empty graph.

#### 3. Stats via 74 MB file read

`captureGraphifyStats()` (metrics.ts:9-35) shells out `cat graphify-out/graph.json` and parses the entire file. For hermes-agent, this reads 74 MB on every session start.

#### 4. buildGraphContext() never called from TypeScript

`buildGraphContext()` exists in mapper.ts:151-168 but is never invoked from TypeScript code.
It would be called by the scout agent (markdown template) via MCP tools — meaning
GraphContext construction is ad-hoc, not programmatic.

#### 5. Noisy god nodes

hermes-agent god nodes are dominated by generic builtins: `.get()` (2,853 degree), `str` (2,441),
`strip()` (1,253), `append()`. Architecture-significant nodes (`Platform`, `AIAgent`,
`BasePlatformAdapter`) are buried in noise. INFERRED edges (58% of total) are the source.

#### 6. Stats preservation fallback is fragile

If rtk is unavailable, stale graphify stats persist across sessions via the preservation fallback (start.ts:34-36).

#### 7. Binary detection doesn't verify functionality

`detectGraphify()` checks `which graphify` / `which graphifyy` but never runs the binary to confirm it works.

---

### Edge Relations Distribution (hermes-agent)

| Relation | Count | Notes |
| --- | --- | --- |
| calls | 51,827 | Function/method invocations |
| uses | 38,574 | Generic usage (type refs, variable refs) |
| method | 14,299 | Class-to-method membership |
| contains | 12,438 | File/module-to-symbol containment |
| rationale_for | 11,901 | Symbol-to-its-docstring |
| imports_from | 282 | Import statements |
| inherits | 177 | Class inheritance |

**Confidence:** 42% EXTRACTED (54,758 edges) vs 58% INFERRED (74,743 edges)

---

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Build timing | Async at session start + on-demand agent trigger | User requirement: both needed |
| Stats capture | CLI-based via `graphify benchmark` | Avoids 74 MB file read; ~1s execution |
| Placeholder handling | Eliminate placeholder; use size-based detection | 1KB threshold distinguishes real from empty |
| State model | 4-state machine: absent → building → ready/failed | Replaces binary available/not |
| God node filtering | Builtin noise set | Filter `.get()`, `str`, `strip()` etc. before emitting |
| Graph state module | New `src/scout/graph-state.ts` | Unified logic for CWD and cross-repo |

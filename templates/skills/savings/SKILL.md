---
name: savings
description: "Report rtk and jcodemunch token savings for the current session."
argument-hint: ""
user-invocable: true
---

<!-- rig-generated -->

# savings — Session Savings Report

Report token savings from rtk and jcodemunch usage during this session.

## Procedure

1. Run `rtk gain --format json` to get current savings data. If rtk is not
   available, skip rtk reporting.
2. Gather the session cache files (aggregate, do not pick one):
   - Use `Bash(ls /tmp/rig-session-*.json)` to list candidates (or the Glob tool
     with pattern `/tmp/rig-session-*.json`).
   - For each candidate path, use the **Read tool** (not `cat` or `grep`) to load
     the JSON and check the `cwd` field. Collect ALL files whose `cwd` matches
     the current project directory (`$CLAUDE_PROJECT_DIR` or `pwd`) — hooks
     running from subagent contexts or under different session ids write
     separate cache files keyed by (cwd, session id), and each holds part of
     this session's tool-call counters.
   - Anchor staleness to session start: session-start recaptures the metrics
     baseline every session, so the most recent matching file's (highest
     `updatedAt`) `metricsBaseline.capturedAt` is the session-start anchor.
     Discard matching files whose `updatedAt` predates the anchor, and as an
     outer bound discard any file older than 24 hours — files from earlier
     sessions today (same cwd, different session ids) hold a previous
     session's work and would inflate "this session" counts.
   - Sum `metricCounters` (rtkCalls, jmCalls, efficientCalls, graphifyCalls)
     across the remaining matching files. These summed values are the session
     call counts used in the report.
   - Take `metricsBaseline` and `environment` (rtkAvailable,
     jcodemunchAvailable) from the most recent matching file (highest
     `updatedAt`) — baselines and environment snapshots must not be summed.
   - If no file has a matching `cwd`, fall back to the single most recent
     file by modification time.
   - `rig init` auto-allows `Bash(ls /tmp/rig-session-*)` and
     `Read(/tmp/rig-session-*.json)`, so this flow should not prompt for
     permission. If it does, `.claude/settings.json` is out of date — re-run
     `rig init --force`.
3. Compute the rtk session delta: `current total_saved - baseline totalSaved`.
4. For jcodemunch: call `mcp__jcodemunch__get_session_stats` and read
   `session_tokens_saved`, `session_calls`, `total_tokens_saved`, and
   `tool_breakdown` directly. These are reliable per-session counters
   maintained by the MCP server process. If jcodemunch MCP is not available,
   skip jcodemunch reporting.
5. For graphify: check the most recent matching cache file for `graphifyStats` in the
   `metricsBaseline` field. This is a per-directory record mapping absolute
   paths to `GraphifyProjectStats` objects. If present, include the graphify
   section in the report (see Output Format below). Alternatively, if graphify
   MCP is available, call `mcp__graphify__graph_stats` to get live stats.
   If graphify is not available, skip graphify reporting.
6. For headroom (context-compression proxy): check the most recent matching
   cache file's
   `environment.headroomInitialized` field. If true, run
   `headroom perf --format json --hours 24` and read `tokens_saved`,
   `savings_pct`, `total_requests`, and `cache_hit_pct`. Include the headroom
   line only when `total_requests > 0`. These are context-layer savings — they
   overlap tool-layer (rtk/jcodemunch) savings at the boundary, so report them
   on their own line and NEVER add them to the rtk/jcodemunch numbers. If
   `headroomInitialized` is false/absent or the command fails, skip headroom
   reporting.
7. Format and print the report (see Output Format below). Do NOT write any
   explanatory text before or after the report — output ONLY the report lines.

## Output Format

With session data (baseline + delta available), single project:

```
[rig] Session Savings
  rtk: X.XM saved (N calls, +XK this session)
  jcodemunch: XK saved (N queries, 150M total all-time)
  headroom: XK saved (context layer — N requests, X% compression, X% cache hits; not summed with tool-layer savings)
  graphify: N nodes, M edges, K communities (X% EXTRACTED, X% INFERRED, X% AMBIGUOUS)
```

The headroom line appears only when the proxy is initialized for this project
and had requests in the window — omit it otherwise.

With session data, multi-project (scouted external repos):

```
[rig] Session Savings
  rtk: X.XM saved (N calls, +XK this session)
  jcodemunch: XK saved (N queries, 150M total all-time)
  graphify:
    project-a: N nodes, M edges, K communities (X% EXTRACTED, X% INFERRED, X% AMBIGUOUS)
    project-b: N nodes, M edges, K communities (X% EXTRACTED, X% INFERRED, X% AMBIGUOUS)
```

Without session data (no cache file or baseline is null):

```
[rig] Session Savings (all-time)
  rtk: X.XM saved (N commands, XX.X% avg savings)
  jcodemunch: XM saved all-time (N queries)
  graphify: N nodes, M edges, K communities (X% EXTRACTED, X% INFERRED, X% AMBIGUOUS)
```

When baseline is missing, still call `mcp__jcodemunch__get_session_stats` for all-time
totals and `mcp__graphify__graph_stats` for live graph stats. Only skip a line if the
tool is genuinely unavailable.

If rtk is not installed:

```
[rig] Session Savings
  rtk: not installed
```

## Formatting Rules

- Format token counts: >=1M as `X.XM`, >=1K as `XK`, else raw number.
- Round percentages to 1 decimal.
- jcodemunch `session_tokens_saved` and `session_calls` come directly from
  `get_session_stats`. `total_tokens_saved` is the all-time cumulative.
- graphify `graphifyStats` is a `Record<string, GraphifyProjectStats>` —
  keys are absolute directory paths, values are stats objects with
  `nodes`, `edges`, `communities`, `extractedPct`, `inferredPct`, `ambiguousPct`.
  Single-entry records render as one line; multi-entry records render as
  indented per-project lines with directory basename as label.
- Output the report and nothing else.

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
2. Find the session cache file:
   - Use `Bash(ls /tmp/rig-session-*.json)` to list candidates (or the Glob tool
     with pattern `/tmp/rig-session-*.json`).
   - For each candidate path, use the **Read tool** (not `cat` or `grep`) to load
     the JSON and check the `cwd` field. Use the file whose `cwd` matches the
     current project directory (`$CLAUDE_PROJECT_DIR` or `pwd`). If no file has
     a matching `cwd`, fall back to the most recent by modification time.
   - The cache file contains `metricsBaseline`, `metricCounters` (rtkCalls,
     jmCalls, efficientCalls), and `environment` (rtkAvailable,
     jcodemunchAvailable).
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
5. For graphify: check the session cache file for `graphifyStats` in the
   `metricsBaseline` field. This is a per-directory record mapping absolute
   paths to `GraphifyProjectStats` objects. If present, include the graphify
   section in the report (see Output Format below). Alternatively, if graphify
   MCP is available, call `mcp__graphify__graph_stats` to get live stats.
   If graphify is not available, skip graphify reporting.
6. Format and print the report (see Output Format below). Do NOT write any
   explanatory text before or after the report — output ONLY the report lines.

## Output Format

With session data (baseline + delta available), single project:

```
[rig] Session Savings
  rtk: X.XM saved (N calls, +XK this session)
  jcodemunch: XK saved (N queries, 150M total all-time)
  graphify: N nodes, M edges, K communities (X% EXTRACTED, X% INFERRED, X% AMBIGUOUS)
```

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

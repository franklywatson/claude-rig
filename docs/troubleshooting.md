# Troubleshooting

## Repeated permission prompts for `/tmp/rig-session-*.json`

### Symptom

When running `/savings` or any skill that reads session cache files, you get
permission prompts for `Bash(ls /tmp/rig-session-*.json)`,
`Read(/tmp/rig-session-*.json)`, or similar — even after running `rig init`.

### Cause

Earlier versions of `rig init` only auto-allowed `Bash(cat /tmp/rig-session-*)`
but not the `ls` listing step or `Read` tool reads of those same files. The
savings skill's own procedure uses all three. The README's claim that this was
"auto-permissioned" was incomplete.

### Diagnosis

Starting in rig 0.3.5+, the session-start hook emits this warning when
`.claude/settings.json` is missing any required entries:

```
[WARNING] .claude/settings.json is missing rig-required permission entries.
  Missing: Bash(ls /tmp/rig-session-*), Read(/tmp/rig-session-*.json)
  Fix: rig init --force
```

To check manually, look at `.claude/settings.json` and confirm `permissions.allow`
contains all of:

- `mcp__jcodemunch__*`
- `mcp__graphify__*`
- `Bash(cat /tmp/rig-session-*)`
- `Bash(ls /tmp/rig-session-*)`
- `Read(/tmp/rig-session-*.json)`
- `Read(/private/tmp/rig-session-*.json)` *(macOS: /tmp resolves to /private/tmp before permission matching)*
- `Bash(npx:*)`

### Fix

```bash
rig init --force
```

`rig init --force` is idempotent — it only adds missing entries and preserves
existing user customizations (other allow entries, deny rules, hook configs).

## Graphify MCP not available

### What's happening

The graphify CLI can be installed and have a valid `graphify-out/graph.json`
without the `mcp__graphify__*` tools being available to Claude Code. When this
happens, the scout agent silently falls back to parsing `graph.json` directly
rather than using the MCP server. You lose relationship query tools
(`god_nodes`, `get_community`, `shortest_path`, `query_graph`) and instead get
only static JSON analysis.

As of rig 0.3.4+, the session-start hook detects this automatically and prints
an actionable `[WARNING]` with the exact fix command.

### How to diagnose

**In a Claude Code session**, check the session-start output (printed when the
session begins). Look for lines like:

```
[WARNING] graphify CLI present but no graph built. Run: graphify update .
[WARNING] graphify MCP server unavailable: missing Python "mcp" dependency.
  Fix: uv tool install graphifyy --with mcp --force
[WARNING] graphify CLI present but MCP server not registered with Claude Code.
  Scout will fall back to parsing graph.json instead of using mcp__graphify__* tools.
  Fix: claude mcp add graphify <python-path> -m graphify.serve <graph-path>
```

**From a terminal**, run:

```bash
claude mcp list
```

If `graphify` does not appear in the output, the MCP server is not registered.
If it does appear, check that the tools are visible in Claude Code by looking
for `mcp__graphify__*` in the available tools list at session start.

### Failure mode 1: Missing Python `mcp` dependency

**Symptom:** `graphify CLI present but MCP server not installed` warning, or
running `python3 -m graphify.serve` manually fails with:

```
ModuleNotFoundError: No module named 'mcp'
```

**Cause:** graphifyy (the PyPI package name for graphify) does not declare
`mcp` as a dependency. The MCP server module ships with graphifyy but the
Python MCP SDK must be installed alongside it.

**Fix:**

```bash
uv tool install graphifyy --with mcp --force
```

This reinstalls the graphifyy uv-tool with the `mcp` package included in its
virtual environment. The `--force` flag ensures the existing install is replaced.

**Verify:**

```bash
~/.local/share/uv/tools/graphifyy/bin/python3 -c "import mcp; print('ok')"
```

### Failure mode 2: Server not registered with Claude Code

**Symptom:** `mcp` module loads successfully but `claude mcp list` does not
include `graphify`.

**Cause:** The graphify MCP server must be explicitly registered with Claude
Code before it will be available in sessions. The server takes a specific
`graph.json` path as an argument, making it project-scoped.

**Fix (per-project):**

```bash
claude mcp add graphify \
  ~/.local/share/uv/tools/graphifyy/bin/python3 \
  -m graphify.serve \
  /path/to/your/project/graphify-out/graph.json
```

Where:

- `~/.local/share/uv/tools/graphifyy/bin/python3` — the Python interpreter
  inside graphifyy's uv-tool virtual environment (use this, not system python3,
  to ensure the `mcp` module is on the path)
- `/path/to/your/project/graphify-out/graph.json` — the absolute path to the
  project's graph file

**Alternative (project `.mcp.json`):**

A per-project `.mcp.json` is the architecturally cleaner approach because the
server path includes the project-specific `graph.json`. Add to your project
root:

```json
{
  "mcpServers": {
    "graphify": {
      "command": "/home/youruser/.local/share/uv/tools/graphifyy/bin/python3",
      "args": ["-m", "graphify.serve", "graphify-out/graph.json"]
    }
  }
}
```

**Verify:**

```bash
claude mcp list
# graphify should appear in the output
```

### Failure mode 3: No graph built yet

**Symptom:** `graphify CLI present but no graph built` warning.

**Cause:** The graphify CLI is installed but `graphify update` has not been run
in this project, so `graphify-out/graph.json` does not exist or is a placeholder.

**Fix:**

```bash
graphify update .
```

Run this from the project root. For large projects (6000+ files), graphify may
hit Python AST recursion limits — the scout agent falls back to jcodemunch-only
analysis in that case and reports the failure.

### Rig's automatic self-check

Starting with rig 0.3.4, the session-start hook calls `checkGraphifyMcpReadiness()`
which runs these checks in order:

1. Is `graphify` or `graphifyy` on PATH? → `cli_missing` if not
2. Does `graphify-out/graph.json` exist (size > 1 KB)? → `no_graph` if not
3. Does `python3 -c "import mcp"` succeed in the graphifyy venv? → `cli_only_mcp_dep_missing` if not
4. Does `claude mcp list` include "graphify"? → `cli_only_not_registered` if not
5. All checks pass → `ready`

Status `cli_missing` is silent (graphify is optional). All other non-ready
statuses emit a `[WARNING]` with the exact fix command.

The probe uses `python3 -c "import mcp"` rather than actually starting the
stdio server (`python3 -m graphify.serve`) because the server blocks waiting
for JSON-RPC input and would hang the session-start hook.

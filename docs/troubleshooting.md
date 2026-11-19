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

## Enforcement level not matching `.harness.yaml`

### Symptom

A rule behaves at a different level than `.harness.yaml` specifies — e.g. a
rule set to `block` only advises, or one your colleagues don't see fires only
on your machine.

### Cause

A `.harness.yaml.local` in the project root (gitignored, machine-local) is
merged over `.harness.yaml` with higher precedence. It may be left over from
an experiment you forgot about, or contain a typo'd key that changes a
different rule than intended.

### Diagnosis / fix

```bash
ls .harness.yaml.local
```

If it exists, read it against the effective behavior you want. Delete it to
return to the project-wide config — hooks re-read the config on every
invocation, no restart needed. To see each config layer as it loads, run any
hook with `RIG_DEBUG=1`; skipped layers (absent, unreadable, or not a rules
document) are named on stderr.

## Permission prompts for Python commands

### Symptom

`pytest`, `python`, `pip` or another Python tool asks for permission, even
though you have an allow rule for it, or it did not ask before you updated rig.

### Cause

When the tool exists in the project's `.venv/bin`, or `uv` is installed, rig
rewrites these commands to `.venv/bin/<tool> ...` or `uv run <command>`. rig
does not approve the rewritten command itself, and Claude Code matches your
allow rules against the rewritten form, so a rule such as `Bash(pytest:*)`
does not match it. When `uv` itself is not in the venv, a command that already
starts with `uv` is wrapped as well: `uv run pytest` arrives as
`uv run uv run pytest`, and a rule has to match that form too. In auto mode,
Claude Code's hooks reference says the rewritten call can be denied instead of
prompting.

### Fix

Add an allow rule that matches the rewritten form, for example
`Bash(.venv/bin/pytest:*)` or `Bash(uv run pytest:*)`, or approve the prompt
when it appears. If it offers a "don't ask again" option, check the pattern
that option would save: it can cover every use of that tool, so approve once
instead if that is broader than you want. Keep the rule you already have: it
still applies to commands rig does not rewrite.

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

Run this from the project root. graphify has no file-count or AST-recursion
limit; only the HTML visualization is skipped above 5000 nodes (graph.json
and GRAPH_REPORT.md are always produced).

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

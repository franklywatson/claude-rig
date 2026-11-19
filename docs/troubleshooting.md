# Troubleshooting

## Repeated permission prompts for `/tmp/rig-session-*.json`

### Symptom

When running `/savings` or any skill that reads session cache files, you get
permission prompts for `ls /tmp/rig-session-*.json`, for reading a
`/tmp/rig-session-*.json` file, or similar — even after running `rig init`.

### Cause

Session-cache allow entries are opt-in. Plain `rig init` and `rig init --force`
add no allow entries.

Earlier versions wrote the two `Read` entries with one leading slash. In project
settings Claude Code reads that form as a path inside the project, so those entries
did not match the session cache. The entries below use two slashes, which is an
absolute path. The one-slash entries can be deleted.

### Diagnosis

When the project settings file can be read and parsed, the session-start hook checks the
combined allow list. If required entries are missing, it lists them in a warning.

```
[WARNING] .claude/settings.json is missing rig-required permission entries.
  Missing: Read(//tmp/rig-session-*.json), Read(//private/tmp/rig-session-*.json)
  Fix: rig init --broad-permissions
```

To check manually, look for each of these entries in `permissions.allow` across
`.claude/settings.json`, `.claude/settings.local.json`, and `~/.claude/settings.json`.

- `mcp__jcodemunch__*`
- `mcp__graphify__*`
- `Bash(cat /tmp/rig-session-*)`
- `Bash(ls /tmp/rig-session-*)`
- `Read(//tmp/rig-session-*.json)`
- `Read(//private/tmp/rig-session-*.json)` *(macOS: /tmp resolves to /private/tmp before permission matching)*
- `Bash(npx:*)`

### Fix

```bash
rig init --broad-permissions
```

`rig init --broad-permissions` is idempotent for allow entries. It adds missing
entries to the project's allow list and preserves existing ones.

The flag adds more than the entries listed above: it also pre-authorizes the
broader shell patterns in the README's [Permissions](../README.md#permissions)
section, such as `Bash(node:*)` and `Bash(npm:*)`. To allow only the entries
above, add them to `permissions.allow` by hand.

With these entries, in a session where you have trusted the folder, reading a
cache file with the Read tool or `cat` no longer prompts. Listing with
`ls /tmp/rig-session-*.json` may still prompt, because a listing needs read
access to `/tmp` itself and rig does not pre-authorize that. Approve that prompt,
or add a wider rule yourself (for example `Read(//tmp/**)`) if you accept Claude
reading everything in `/tmp`.

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
does not match it. Tools that manage their own environment (`uv`, `poetry`,
`hatch`, `tox`, `nox`) are never wrapped in `uv run`. In auto mode,
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

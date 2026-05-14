import { join } from 'node:path';
import type { ExecFn } from './environment.js';
import type { Environment, GraphifyMcpReadiness } from '../types.js';

/**
 * Probes whether the graphify MCP server is reachable from Claude Code.
 *
 * Two failure modes prevent `mcp__graphify__*` tools from appearing in a
 * Claude Code session even when the graphify CLI is installed:
 *
 * 1. Missing `mcp` Python dependency — `python3 -m graphify.serve` throws
 *    `ModuleNotFoundError: No module named 'mcp'`. Fix: reinstall graphifyy
 *    via uv with the mcp extra.
 *
 * 2. Server not registered with Claude Code — `claude mcp list` doesn't
 *    mention graphify. Fix: `claude mcp add graphify ...`.
 *
 * Detection strategy:
 * - We probe the mcp module with `python3 -c "import mcp"` (a safe, fast
 *   import check) rather than starting the server (`python3 -m graphify.serve`)
 *   which would block waiting for stdio JSON-RPC input. The uv-tool python
 *   path is tried first because graphifyy ships its own interpreter.
 * - We check `claude mcp list` output for the substring "graphify" to detect
 *   registration. If `claude` itself isn't on PATH we treat the status as
 *   cli_only_not_registered (conservative — better to advise than to assume).
 */
export function checkGraphifyMcpReadiness(
  cwd: string,
  env: Environment,
  exec: ExecFn,
): GraphifyMcpReadiness {
  // Step 1: Is the CLI present at all?
  const cliPath = resolveGraphifyCli(exec);
  if (!cliPath) {
    return { status: 'cli_missing' };
  }

  // Step 2: Does a graph exist (state 'ready')? Any other state means no graph.
  const buildInfo = env.graphBuildInfo;
  if (!buildInfo || buildInfo.state !== 'ready') {
    return { status: 'no_graph', fixCommand: 'graphify update .' };
  }

  // Step 3: Probe the mcp Python module using the uv-tool interpreter if
  // available, falling back to the system python3.
  const pythonPath = resolveUvToolPython(exec) ?? resolveSystemPython3(exec);
  const mcpModuleOk = pythonPath ? probeMcpModule(pythonPath, exec) : false;

  if (!mcpModuleOk) {
    return {
      status: 'cli_only_mcp_dep_missing',
      fixCommand: 'uv tool install graphifyy --with mcp --force',
    };
  }

  // Step 4: Is the server registered with Claude Code?
  const registered = isRegisteredWithClaude(exec);
  if (!registered) {
    const graphJsonPath = join(cwd, 'graphify-out', 'graph.json');
    const fixCommand = buildMcpAddCommand(pythonPath!, graphJsonPath);
    return { status: 'cli_only_not_registered', fixCommand };
  }

  return { status: 'ready' };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function resolveGraphifyCli(exec: ExecFn): string | null {
  try {
    return exec('which graphify').trim();
  } catch {
    // graphifyy (double-y) is the PyPI package name
    try {
      return exec('which graphifyy').trim();
    } catch {
      return null;
    }
  }
}

/**
 * Returns the python3 inside the graphifyy uv-tool virtual environment,
 * which is the interpreter that ships with the package. This is the correct
 * python to use for `python3 -m graphify.serve`.
 */
function resolveUvToolPython(exec: ExecFn): string | null {
  // uv installs tools under ~/.local/share/uv/tools/<name>/bin/
  try {
    const home = exec('echo $HOME').trim();
    const uvPython = `${home}/.local/share/uv/tools/graphifyy/bin/python3`;
    // Verify the file exists by probing it
    exec(`test -f "${uvPython}"`);
    return uvPython;
  } catch {
    return null;
  }
}

function resolveSystemPython3(exec: ExecFn): string | null {
  try {
    return exec('which python3').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Checks whether the `mcp` Python package is importable in the given
 * interpreter. Uses `python3 -c "import mcp"` — a fast, side-effect-free
 * probe that avoids actually starting the stdio server.
 */
function probeMcpModule(pythonPath: string, exec: ExecFn): boolean {
  try {
    exec(`${pythonPath} -c "import mcp"`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true when `claude mcp list` output mentions "graphify" (case-insensitive).
 * Returns false on any error (claude not found, command fails, etc.) — conservative
 * default so we advise rather than silently assume registration.
 */
function isRegisteredWithClaude(exec: ExecFn): boolean {
  try {
    const output = exec('claude mcp list', { timeout: 10_000 });
    return /graphify/i.test(output);
  } catch {
    return false;
  }
}

/**
 * Builds the `claude mcp add` fix command. The server is project-scoped
 * because it takes a specific graph.json path — a per-project .mcp.json
 * is the architecturally clean approach, but `claude mcp add` with
 * explicit args works for a quick fix instruction.
 */
function buildMcpAddCommand(pythonPath: string, graphJsonPath: string): string {
  return `claude mcp add graphify ${pythonPath} -m graphify.serve ${graphJsonPath}`;
}

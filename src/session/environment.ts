import { execSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import type { Environment, GraphBuildInfo } from '../types.js';

export interface ExecFn {
  (command: string, options?: { encoding?: string; timeout?: number }): string;
}

const defaultExec: ExecFn = (cmd, opts) =>
  execSync(cmd, { encoding: 'utf-8', ...opts } as Parameters<typeof execSync>[1]) as string;

export async function detectEnvironment(
  cwd: string,
  exec: ExecFn = defaultExec,
  existsCheck: (path: string) => boolean = existsSync,
  statCheck: (path: string) => { size: number } | undefined = defaultStatCheck,
): Promise<Environment> {
  const rtkResult = detectRtk(exec);
  const jmResult = detectJcodemunch(cwd, exec);
  const graphifyResult = detectGraphify(cwd, exec, existsCheck, statCheck);

  return {
    rtkAvailable: rtkResult.available,
    rtkPath: rtkResult.path,
    jcodemunchAvailable: jmResult.available,
    jcodemunchCwdIndexed: jmResult.cwdIndexed,
    jcodemunchCwdRepo: jmResult.cwdRepo,
    jcodemunchKnownRepos: jmResult.knownRepos,
    graphifyAvailable: graphifyResult.state === 'ready',
    graphifyGraphPath: graphifyResult.state === 'ready' ? graphifyResult.graphPath ?? null : null,
    graphBuildInfo: graphifyResult.state === 'absent' && !graphifyResult._cliFound ? undefined : graphifyResult,
    detectedAt: Date.now(),
  };
}

function detectRtk(exec: ExecFn): { available: boolean; path: string | null } {
  try {
    const path = exec('which rtk').trim();
    return { available: true, path };
  } catch {
    return { available: false, path: null };
  }
}

const PLACEHOLDER_THRESHOLD = 1024; // bytes

const defaultStatCheck = (path: string): { size: number } | undefined => {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
};

export interface GraphifyDetectResult extends GraphBuildInfo {
  _cliFound: boolean;
}

export function detectGraphify(
  cwd: string,
  exec: ExecFn,
  existsCheck: (path: string) => boolean = existsSync,
  statCheck: (path: string) => { size: number } | undefined = defaultStatCheck,
): GraphifyDetectResult {
  // Check for graphify CLI — package installs as 'graphifyy' (double-y)
  let cliAvailable = false;
  try {
    exec('which graphify');
    cliAvailable = true;
  } catch {
    try {
      exec('which graphifyy');
      cliAvailable = true;
    } catch {
      // Neither binary found — MCP server may still be running via uvx
    }
  }

  if (!cliAvailable) {
    return { state: 'absent', _cliFound: false };
  }

  const graphPath = join(cwd, 'graphify-out', 'graph.json');
  if (existsCheck(graphPath)) {
    const stat = statCheck(graphPath);
    if (stat && stat.size >= PLACEHOLDER_THRESHOLD) {
      return { state: 'ready', graphPath: 'graphify-out/graph.json', _cliFound: true };
    }
    // Placeholder or tiny file — treat as absent
    return { state: 'absent', _cliFound: true };
  }

  return { state: 'absent', _cliFound: true };
}

function detectJcodemunch(cwd: string, exec: ExecFn): {
  available: boolean;
  cwdIndexed: boolean;
  cwdRepo: string | null;
  knownRepos: string[];
} {
  // Try CLI binary first
  try {
    exec('which jcodemunch');
    return detectJcodemunchCli(cwd, exec);
  } catch {
    // CLI not found — try MCP server binary
  }

  try {
    const mcpPath = exec('which jcodemunch-mcp').trim();
    if (mcpPath) {
      return detectJcodemunchMcp(cwd, mcpPath, exec);
    }
  } catch {
    // MCP binary not found either
  }

  // macOS/uvx install: jcodemunch-mcp is managed by uvx and not in PATH.
  // Claude Code's recommended install (command: "uvx", args: ["jcodemunch-mcp"])
  // works but `which jcodemunch-mcp` fails. Pipe JSON-RPC via uvx directly.
  // This also applies to Linux users who install via uvx instead of pip/pipx.
  try {
    exec('which uvx');
    return detectJcodemunchViaUvx(cwd, exec);
  } catch {
    // uvx not available
  }

  return { available: false, cwdIndexed: false, cwdRepo: null, knownRepos: [] };
}

function detectJcodemunchCli(cwd: string, exec: ExecFn): {
  available: boolean;
  cwdIndexed: boolean;
  cwdRepo: string | null;
  knownRepos: string[];
} {
  try {
    const raw = exec('jcodemunch list_repos').trim();
    const parsed = JSON.parse(raw);
    return resolveJcodemunchRepos(cwd, parsed.repos ?? []);
  } catch {
    return { available: true, cwdIndexed: false, cwdRepo: null, knownRepos: [] };
  }
}

function detectJcodemunchMcp(cwd: string, mcpPath: string, exec: ExecFn): {
  available: boolean;
  cwdIndexed: boolean;
  cwdRepo: string | null;
  knownRepos: string[];
} {
  try {
    const output = queryJcodemunchMcp(mcpPath, exec);
    if (!output) return { available: true, cwdIndexed: false, cwdRepo: null, knownRepos: [] };

    // Parse JSON-RPC responses — find the list_repos response (id:2)
    const lines = output.trim().split('\n');
    const reposLine = lines.find(l => l.includes('"id":2'));
    if (!reposLine) return { available: true, cwdIndexed: false, cwdRepo: null, knownRepos: [] };

    const rpcResponse = JSON.parse(reposLine);
    const textContent = rpcResponse?.result?.content?.[0]?.text;
    if (!textContent) return { available: true, cwdIndexed: false, cwdRepo: null, knownRepos: [] };

    const reposData = JSON.parse(textContent);
    // MCP returns repos as objects with a "repo" field; extract repo names
    const repoNames: string[] = (reposData.repos ?? []).map((r: { repo: string }) => r.repo);
    return resolveJcodemunchRepos(cwd, repoNames);
  } catch {
    return { available: true, cwdIndexed: false, cwdRepo: null, knownRepos: [] };
  }
}

function queryJcodemunchMcp(mcpPath: string, exec: ExecFn): string | null {
  const init = '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"rig","version":"1.0"}},"id":1}';
  const ready = '{"jsonrpc":"2.0","method":"notifications/initialized"}';
  const listRepos = '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_repos","arguments":{}},"id":2}';

  const cmd = `printf '%s\\n' '${init}' '${ready}' '${listRepos}' | '${mcpPath}' 2>/dev/null`;
  try {
    return exec(cmd, { timeout: 10000 });
  } catch {
    return null;
  }
}

function detectJcodemunchViaUvx(cwd: string, exec: ExecFn): {
  available: boolean;
  cwdIndexed: boolean;
  cwdRepo: string | null;
  knownRepos: string[];
} {
  const output = queryJcodemunchViaUvx(exec);
  if (!output) return { available: false, cwdIndexed: false, cwdRepo: null, knownRepos: [] };

  try {
    const lines = output.trim().split('\n');
    const reposLine = lines.find(l => l.includes('"id":2'));
    if (!reposLine) return { available: true, cwdIndexed: false, cwdRepo: null, knownRepos: [] };

    const rpcResponse = JSON.parse(reposLine);
    const textContent = rpcResponse?.result?.content?.[0]?.text;
    if (!textContent) return { available: true, cwdIndexed: false, cwdRepo: null, knownRepos: [] };

    const reposData = JSON.parse(textContent);
    const repoNames: string[] = (reposData.repos ?? []).map((r: { repo: string }) => r.repo);
    return resolveJcodemunchRepos(cwd, repoNames);
  } catch {
    return { available: true, cwdIndexed: false, cwdRepo: null, knownRepos: [] };
  }
}

function queryJcodemunchViaUvx(exec: ExecFn): string | null {
  const init = '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"rig","version":"1.0"}},"id":1}';
  const ready = '{"jsonrpc":"2.0","method":"notifications/initialized"}';
  const listRepos = '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_repos","arguments":{}},"id":2}';

  const cmd = `printf '%s\\n' '${init}' '${ready}' '${listRepos}' | uvx jcodemunch-mcp 2>/dev/null`;
  try {
    return exec(cmd, { timeout: 15000 });
  } catch {
    return null;
  }
}

/**
 * Call a jcodemunch MCP tool via JSON-RPC stdio protocol.
 * Returns the parsed text content of the result, or null on failure.
 */
export function callJcodemunchMcpTool(mcpPath: string, toolName: string, args: Record<string, string>, exec: ExecFn): string | null {
  const init = '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"rig","version":"1.0"}},"id":1}';
  const ready = '{"jsonrpc":"2.0","method":"notifications/initialized"}';
  const call = JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: toolName, arguments: args },
    id: 2,
  });

  const cmd = `printf '%s\\n' '${init}' '${ready}' '${call}' | '${mcpPath}' 2>/dev/null`;
  try {
    const output = exec(cmd, { timeout: 60_000 });
    const lines = output.trim().split('\n');
    const responseLine = lines.find(l => l.includes('"id":2'));
    if (!responseLine) return null;
    const rpcResponse = JSON.parse(responseLine);
    return rpcResponse?.result?.content?.[0]?.text ?? null;
  } catch {
    return null;
  }
}

function resolveJcodemunchRepos(cwd: string, repos: string[]): {
  available: boolean;
  cwdIndexed: boolean;
  cwdRepo: string | null;
  knownRepos: string[];
} {
  const folderName = basename(cwd);
  const cwdRepo = repos.find(r => r.split('/').pop() === folderName) ?? null;

  return {
    available: true,
    cwdIndexed: cwdRepo !== null,
    cwdRepo,
    knownRepos: repos,
  };
}

import { execSync, spawn } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import type { Environment, GraphBuildInfo, JcodemunchTransport } from '../types.js';
import { resolveJcodemunchRegistration } from './claude-config.js';
import type { McpRegistration } from './claude-config.js';

export type RegistrationLookupFn = (cwd: string) => McpRegistration | null;

export interface ExecFn {
  (command: string, options?: { encoding?: string; timeout?: number }): string;
}

/**
 * Sends JSON-RPC messages to an MCP server over stdio and resolves with raw stdout
 * once a response containing `"id":<matchId>` is observed, or null on timeout/error.
 *
 * Keeps stdin OPEN while waiting: closing it on EOF causes some MCP servers (notably
 * uvx-managed `jcodemunch-mcp`) to shut down before emitting later responses. The
 * caller (this helper) kills the child the moment the desired response arrives.
 */
export interface McpQueryFn {
  (
    command: string,
    args: string[],
    messages: string[],
    matchId: number,
    timeoutMs: number,
  ): Promise<string | null>;
}

const defaultExec: ExecFn = (cmd, opts) =>
  execSync(cmd, { encoding: 'utf-8', ...opts } as Parameters<typeof execSync>[1]) as string;

export const defaultMcpQuery: McpQueryFn = (command, args, messages, matchId, timeoutMs) =>
  new Promise((resolve) => {
    const matchPattern = `"id":${matchId}`;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }

    let buffer = '';
    let settled = false;

    const finish = (result: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      resolve(result);
    };

    const timer = setTimeout(() => finish(buffer.includes(matchPattern) ? buffer : null), timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      if (buffer.includes(matchPattern)) {
        finish(buffer);
      }
    });

    child.on('error', () => finish(null));
    child.on('exit', () => finish(buffer.includes(matchPattern) ? buffer : null));

    // Write all messages, but deliberately do NOT call stdin.end().
    // Some MCP servers exit at EOF before processing queued messages — we hold
    // stdin open until we observe the target response, then kill the child.
    try {
      for (const msg of messages) {
        child.stdin?.write(msg + '\n');
      }
    } catch {
      finish(null);
    }
  });

export async function detectEnvironment(
  cwd: string,
  exec: ExecFn = defaultExec,
  existsCheck: (path: string) => boolean = existsSync,
  statCheck: (path: string) => { size: number } | undefined = defaultStatCheck,
  mcpQuery: McpQueryFn = defaultMcpQuery,
  registrationLookup: RegistrationLookupFn = resolveJcodemunchRegistration,
): Promise<Environment> {
  const rtkResult = detectRtk(exec);
  const jmResult = await detectJcodemunch(cwd, exec, mcpQuery, registrationLookup);
  const graphifyResult = detectGraphify(cwd, exec, existsCheck, statCheck);

  return {
    rtkAvailable: rtkResult.available,
    rtkPath: rtkResult.path,
    jcodemunchAvailable: jmResult.available,
    jcodemunchCwdIndexed: jmResult.cwdIndexed,
    jcodemunchCwdRepo: jmResult.cwdRepo,
    jcodemunchKnownRepos: jmResult.knownRepos,
    jcodemunchTransport: jmResult.transport,
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

interface JcodemunchDetection {
  available: boolean;
  cwdIndexed: boolean;
  cwdRepo: string | null;
  knownRepos: string[];
  transport?: JcodemunchTransport;
}

async function detectJcodemunch(
  cwd: string,
  exec: ExecFn,
  mcpQuery: McpQueryFn,
  registrationLookup: RegistrationLookupFn,
): Promise<JcodemunchDetection> {
  // Try CLI binary first
  try {
    exec('which jcodemunch');
    return {
      ...detectJcodemunchCli(cwd, exec),
      transport: { kind: 'cli', command: 'jcodemunch', args: [] },
    };
  } catch {
    // CLI not found — try the registered MCP command
  }

  // Claude Code's own MCP registration is ground truth for how the server is
  // launched (e.g. `uvx --from <wheel-url> jcodemunch-mcp` for GitHub-release
  // installs that a bare `uvx jcodemunch-mcp` can never resolve).
  let registration: McpRegistration | null = null;
  try {
    registration = registrationLookup(cwd);
  } catch {
    // Unreadable config — continue with the PATH-based chain
  }
  if (registration) {
    const output = await mcpQuery(registration.command, registration.args, LIST_REPOS_MESSAGES, 2, 20_000);
    if (output) {
      return {
        ...parseListReposResponse(cwd, output),
        transport: {
          kind: 'config',
          command: registration.command,
          args: registration.args,
          source: registration.source,
        },
      };
    }
    // Registered command didn't respond — fall through to PATH-based detection
  }

  try {
    const mcpPath = exec('which jcodemunch-mcp').trim();
    if (mcpPath) {
      return {
        ...(await detectJcodemunchMcp(cwd, mcpPath, mcpQuery)),
        transport: { kind: 'binary', command: mcpPath, args: [] },
      };
    }
  } catch {
    // MCP binary not found either
  }

  // Last resort: bare uvx invocation. Only works for PyPI-published installs —
  // wheel-URL installs are covered by the registration probe above.
  try {
    exec('which uvx');
    const result = await detectJcodemunchViaUvx(cwd, mcpQuery);
    if (result.available) {
      return { ...result, transport: { kind: 'uvx', command: 'uvx', args: ['jcodemunch-mcp'] } };
    }
    return result;
  } catch {
    // uvx not available
  }

  return { available: false, cwdIndexed: false, cwdRepo: null, knownRepos: [] };
}

function detectJcodemunchCli(cwd: string, exec: ExecFn): JcodemunchDetection {
  try {
    const raw = exec('jcodemunch list_repos').trim();
    const parsed = JSON.parse(raw);
    return resolveJcodemunchRepos(cwd, parsed.repos ?? []);
  } catch {
    return { available: true, cwdIndexed: false, cwdRepo: null, knownRepos: [] };
  }
}

const LIST_REPOS_MESSAGES = [
  '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"rig","version":"1.0"}},"id":1}',
  '{"jsonrpc":"2.0","method":"notifications/initialized"}',
  '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_repos","arguments":{}},"id":2}',
];

async function detectJcodemunchMcp(
  cwd: string,
  mcpPath: string,
  mcpQuery: McpQueryFn,
): Promise<JcodemunchDetection> {
  const output = await mcpQuery(mcpPath, [], LIST_REPOS_MESSAGES, 2, 10_000);
  return parseListReposResponse(cwd, output);
}

async function detectJcodemunchViaUvx(cwd: string, mcpQuery: McpQueryFn): Promise<JcodemunchDetection> {
  const output = await mcpQuery('uvx', ['jcodemunch-mcp'], LIST_REPOS_MESSAGES, 2, 15_000);
  if (!output) return { available: false, cwdIndexed: false, cwdRepo: null, knownRepos: [] };
  return parseListReposResponse(cwd, output);
}

function parseListReposResponse(cwd: string, output: string | null): JcodemunchDetection {
  if (!output) return { available: true, cwdIndexed: false, cwdRepo: null, knownRepos: [] };
  try {
    const lines = output.trim().split('\n');
    const reposLine = lines.find(l => l.includes('"id":2'));
    if (!reposLine) return { available: true, cwdIndexed: false, cwdRepo: null, knownRepos: [] };

    const rpcResponse = JSON.parse(reposLine);
    const textContent = rpcResponse?.result?.content?.[0]?.text;
    if (!textContent) return { available: true, cwdIndexed: false, cwdRepo: null, knownRepos: [] };

    const reposData = JSON.parse(textContent);
    return resolveJcodemunchRepos(cwd, reposData.repos ?? []);
  } catch {
    return { available: true, cwdIndexed: false, cwdRepo: null, knownRepos: [] };
  }
}

/**
 * Call a jcodemunch MCP tool via JSON-RPC stdio. Returns the parsed `result.content[0].text`
 * (typically a JSON string the caller parses), or null on failure.
 *
 * If `command` is a binary path like `/usr/local/bin/jcodemunch-mcp`, pass empty `args`.
 * For uvx installs, use `command='uvx'`, `args=['jcodemunch-mcp']`.
 */
export async function callJcodemunchMcpTool(
  command: string,
  args: string[],
  toolName: string,
  toolArgs: Record<string, string>,
  mcpQuery: McpQueryFn = defaultMcpQuery,
  timeoutMs: number = 60_000,
): Promise<string | null> {
  const messages = [
    '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"rig","version":"1.0"}},"id":1}',
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: toolName, arguments: toolArgs },
      id: 2,
    }),
  ];

  const output = await mcpQuery(command, args, messages, 2, timeoutMs);
  if (!output) return null;
  try {
    const lines = output.trim().split('\n');
    const responseLine = lines.find(l => l.includes('"id":2'));
    if (!responseLine) return null;
    const rpcResponse = JSON.parse(responseLine);
    return rpcResponse?.result?.content?.[0]?.text ?? null;
  } catch {
    return null;
  }
}

/** A repo entry from list_repos: bare name (CLI/older servers) or rich object (MCP). */
type RepoEntry = string | { repo: string; source_root?: string };

function resolveJcodemunchRepos(cwd: string, repos: RepoEntry[]): JcodemunchDetection {
  const entries = repos
    .map(r => (typeof r === 'string' ? { repo: r } : r))
    .filter((e): e is { repo: string; source_root?: string } => typeof e?.repo === 'string');

  // Exact source-root path match is authoritative — it disambiguates repos
  // with the same basename and survives renamed checkouts. Basename equality
  // is the fallback for entries that don't carry a source_root.
  const resolvedCwd = resolve(cwd);
  const folderName = basename(cwd);
  const bySourceRoot = entries.find(e => e.source_root && resolve(e.source_root) === resolvedCwd);
  const byBasename = entries.find(e => e.repo.split('/').pop() === folderName);
  const cwdRepo = (bySourceRoot ?? byBasename)?.repo ?? null;

  return {
    available: true,
    cwdIndexed: cwdRepo !== null,
    cwdRepo,
    knownRepos: entries.map(e => e.repo),
  };
}

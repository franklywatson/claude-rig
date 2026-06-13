import { describe, it, expect } from 'vitest';
import {
  detectEnvironment,
  detectGraphify,
  callJcodemunchMcpTool,
  defaultMcpQuery,
} from '../../src/session/environment.js';
import type { ExecFn, McpQueryFn } from '../../src/session/environment.js';

function makeExec(responses: Record<string, string | Error>): ExecFn {
  return (cmd: string) => {
    for (const [pattern, result] of Object.entries(responses)) {
      if (cmd.includes(pattern) || cmd === pattern) {
        if (result instanceof Error) throw result;
        return result;
      }
    }
    throw new Error(`unexpected command: ${cmd}`);
  };
}

// Mock for the McpQueryFn — keyed by [command, ...args].join(' ').
function makeMcpQuery(responses: Record<string, string | Error | null>): McpQueryFn {
  return async (command, args) => {
    const key = [command, ...args].join(' ');
    for (const [pattern, result] of Object.entries(responses)) {
      if (key.includes(pattern)) {
        if (result instanceof Error) throw result;
        return result;
      }
    }
    return null;
  };
}

// Helper to build MCP JSON-RPC response for list_repos
function mcpListReposResponse(
  repos: Array<{ repo: string; source_root?: string }>,
  protocolVersion = '2025-03-26',
): string {
  const reposJson = JSON.stringify({ repos });
  const rpcResponse = {
    jsonrpc: '2.0',
    id: 2,
    result: {
      content: [{ type: 'text', text: reposJson }],
      isError: false,
    },
  };
  const initResponse = { jsonrpc: '2.0', id: 1, result: { protocolVersion } };
  return JSON.stringify(initResponse) + '\n' + JSON.stringify(rpcResponse);
}

describe('detectEnvironment', () => {
  it('detects rtk available when which succeeds', async () => {
    const exec = makeExec({
      'which rtk': '/usr/local/bin/rtk',
      'which jcodemunch': new Error('not found'),
      'which jcodemunch-mcp': new Error('not found'),
      'which uvx': new Error('not found'),
    });

    const env = await detectEnvironment('/fake/cwd', exec);
    expect(env.rtkAvailable).toBe(true);
    expect(env.rtkPath).toBe('/usr/local/bin/rtk');
  });

  it('captures the rtk version when the probe succeeds', async () => {
    const exec = makeExec({
      'which rtk': '/opt/homebrew/bin/rtk',
      'rtk --version': 'rtk 0.39.0\n',
      'which jcodemunch-mcp': new Error('not found'),
      'which jcodemunch': new Error('not found'),
      'which uvx': new Error('not found'),
    });

    const env = await detectEnvironment('/fake/cwd', exec, () => false, () => undefined, makeMcpQuery({}), () => null);
    expect(env.rtkAvailable).toBe(true);
    expect(env.rtkVersion).toBe('0.39.0');
  });

  it('rtk version probe failure leaves rtk available with null version', async () => {
    const exec = makeExec({
      'which rtk': '/opt/homebrew/bin/rtk',
      // no 'rtk --version' key — makeExec throws for it
      'which jcodemunch-mcp': new Error('not found'),
      'which jcodemunch': new Error('not found'),
      'which uvx': new Error('not found'),
    });

    const env = await detectEnvironment('/fake/cwd', exec, () => false, () => undefined, makeMcpQuery({}), () => null);
    expect(env.rtkAvailable).toBe(true);
    expect(env.rtkVersion).toBeNull();
  });

  it('detects rtk unavailable when which fails', async () => {
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch': new Error('not found'),
      'which jcodemunch-mcp': new Error('not found'),
      'which uvx': new Error('not found'),
    });

    const env = await detectEnvironment('/fake/cwd', exec);
    expect(env.rtkAvailable).toBe(false);
    expect(env.rtkPath).toBeNull();
  });

  it('detects jcodemunch available when CLI binary succeeds', async () => {
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch': '/usr/local/bin/jcodemunch',
      'list_repos': '{"repos":[]}',
    });

    const env = await detectEnvironment('/fake/cwd', exec);
    expect(env.jcodemunchAvailable).toBe(true);
  });

  it('detects jcodemunch unavailable when neither CLI, MCP, nor uvx found', async () => {
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch': new Error('not found'),
      'which jcodemunch-mcp': new Error('not found'),
      'which uvx': new Error('not found'),
    });

    const env = await detectEnvironment('/fake/cwd', exec, undefined, undefined, makeMcpQuery({}), () => null);
    expect(env.jcodemunchAvailable).toBe(false);
    expect(env.jcodemunchCwdIndexed).toBe(false);
    expect(env.jcodemunchCwdRepo).toBeNull();
  });

  it('detects CWD as indexed when jcodemunch CLI list_repos includes it', async () => {
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch': '/usr/local/bin/jcodemunch',
      'list_repos': JSON.stringify({ repos: ['local/rig'] }),
    });

    const env = await detectEnvironment('/home/jerome/projects/rig', exec);
    expect(env.jcodemunchAvailable).toBe(true);
    expect(env.jcodemunchKnownRepos).toContain('local/rig');
  });

  it('basename match: CWD rig does NOT match repo local/test-rig (endsWith suffix false-positive, platform-agnostic)', async () => {
    // Bug: "local/test-rig".endsWith("rig") === true — CWD "rig" incorrectly
    // matches repo "test-rig" because it is a suffix of the repo basename.
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch': '/usr/local/bin/jcodemunch',
      'list_repos': JSON.stringify({ repos: ['local/test-rig'] }),
    });

    const env = await detectEnvironment('/home/jerome/projects/rig', exec);
    expect(env.jcodemunchAvailable).toBe(true);
    expect(env.jcodemunchCwdIndexed).toBe(false);
    expect(env.jcodemunchCwdRepo).toBeNull();
  });

  it('basename match: CWD rig DOES match repo local/rig (exact match preserved)', async () => {
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch': '/usr/local/bin/jcodemunch',
      'list_repos': JSON.stringify({ repos: ['local/rig', 'local/test-rig'] }),
    });

    // Both repos exist — must pick the exact match only
    const env = await detectEnvironment('/home/jerome/projects/rig', exec);
    expect(env.jcodemunchAvailable).toBe(true);
    expect(env.jcodemunchCwdIndexed).toBe(true);
    expect(env.jcodemunchCwdRepo).toBe('local/rig');
  });

  it('detects jcodemunch via MCP server binary when CLI not found', async () => {
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch-mcp': '/home/user/.local/bin/jcodemunch-mcp\n',
      'which jcodemunch': new Error('not found'),
    });
    const mcpQuery = makeMcpQuery({
      '/home/user/.local/bin/jcodemunch-mcp': mcpListReposResponse([{ repo: 'local/ai-news' }]),
    });

    const env = await detectEnvironment('/home/user/projects/ai-news', exec, undefined, undefined, mcpQuery);
    expect(env.jcodemunchAvailable).toBe(true);
    expect(env.jcodemunchCwdIndexed).toBe(true);
    expect(env.jcodemunchCwdRepo).toBe('local/ai-news');
    expect(env.jcodemunchKnownRepos).toContain('local/ai-news');
  });

  it('detects jcodemunch MCP available but CWD not indexed', async () => {
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch-mcp': '/home/user/.local/bin/jcodemunch-mcp\n',
      'which jcodemunch': new Error('not found'),
    });
    const mcpQuery = makeMcpQuery({
      '/home/user/.local/bin/jcodemunch-mcp': mcpListReposResponse([
        { repo: 'local/other-project' },
        { repo: 'local/third-project' },
      ]),
    });

    const env = await detectEnvironment('/home/user/projects/ai-news', exec, undefined, undefined, mcpQuery);
    expect(env.jcodemunchAvailable).toBe(true);
    expect(env.jcodemunchCwdIndexed).toBe(false);
    expect(env.jcodemunchKnownRepos).toHaveLength(2);
  });

  it('handles malformed MCP JSON-RPC response gracefully', async () => {
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch-mcp': '/home/user/.local/bin/jcodemunch-mcp\n',
      'which jcodemunch': new Error('not found'),
    });
    const mcpQuery = makeMcpQuery({
      '/home/user/.local/bin/jcodemunch-mcp': 'not valid json',
    });

    const env = await detectEnvironment('/home/user/projects/ai-news', exec, undefined, undefined, mcpQuery);
    // Should still mark as available since the binary exists
    expect(env.jcodemunchAvailable).toBe(true);
    expect(env.jcodemunchCwdIndexed).toBe(false);
  });

  it('handles MCP query null result gracefully (timeout / no match)', async () => {
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch-mcp': '/home/user/.local/bin/jcodemunch-mcp\n',
      'which jcodemunch': new Error('not found'),
    });
    const mcpQuery = makeMcpQuery({
      '/home/user/.local/bin/jcodemunch-mcp': null,
    });

    const env = await detectEnvironment('/home/user/projects/ai-news', exec, undefined, undefined, mcpQuery);
    expect(env.jcodemunchAvailable).toBe(true);
    expect(env.jcodemunchCwdIndexed).toBe(false);
  });

  it('prefers CLI binary over MCP server when both available', async () => {
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch': '/usr/local/bin/jcodemunch',
      'list_repos': JSON.stringify({ repos: ['local/rig'] }),
    });

    const env = await detectEnvironment('/home/jerome/projects/rig', exec);
    expect(env.jcodemunchAvailable).toBe(true);
    expect(env.jcodemunchKnownRepos).toContain('local/rig');
  });

  it('returns valid timestamp', async () => {
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch': new Error('not found'),
      'which jcodemunch-mcp': new Error('not found'),
      'which uvx': new Error('not found'),
    });

    const before = Date.now();
    const env = await detectEnvironment('/fake/cwd', exec);
    const after = Date.now();
    expect(env.detectedAt).toBeGreaterThanOrEqual(before);
    expect(env.detectedAt).toBeLessThanOrEqual(after);
  });

  it('returns isEnvironment-compatible object', async () => {
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch': new Error('not found'),
      'which jcodemunch-mcp': new Error('not found'),
      'which uvx': new Error('not found'),
    });

    const env = await detectEnvironment('/fake/cwd', exec, undefined, undefined, makeMcpQuery({}), () => null);
    expect(env.rtkAvailable).toBe(false);
    expect(env.rtkPath).toBeNull();
    expect(env.jcodemunchAvailable).toBe(false);
    expect(env.jcodemunchCwdIndexed).toBe(false);
    expect(env.jcodemunchCwdRepo).toBeNull();
    expect(env.jcodemunchKnownRepos).toEqual([]);
    expect(typeof env.detectedAt).toBe('number');
  });

  // ── macOS/uvx-install detection (jcodemunch-mcp not in PATH, managed by uvx) ──

  it('macOS/uvx: detects jcodemunch when binary not in PATH but uvx available and CWD is indexed', async () => {
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch': new Error('not found'),
      'which jcodemunch-mcp': new Error('not found'),
      'which uvx': '/opt/homebrew/bin/uvx',
    });
    const mcpQuery = makeMcpQuery({
      'uvx jcodemunch-mcp': mcpListReposResponse([{ repo: 'local/forgd-onboarding' }]),
    });

    const env = await detectEnvironment(
      '/Users/jerome/Documents/Claude/Projects/forgd-onboarding',
      exec,
      undefined,
      undefined,
      mcpQuery,
    );
    expect(env.jcodemunchAvailable).toBe(true);
    expect(env.jcodemunchCwdIndexed).toBe(true);
    expect(env.jcodemunchCwdRepo).toBe('local/forgd-onboarding');
  });

  it('macOS/uvx: marks available=true but cwdIndexed=false when uvx runs but CWD not in repo list', async () => {
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch': new Error('not found'),
      'which jcodemunch-mcp': new Error('not found'),
      'which uvx': '/opt/homebrew/bin/uvx',
    });
    const mcpQuery = makeMcpQuery({
      'uvx jcodemunch-mcp': mcpListReposResponse([{ repo: 'local/other-project' }]),
    });

    const env = await detectEnvironment(
      '/Users/jerome/Documents/Claude/Projects/forgd-onboarding',
      exec,
      undefined,
      undefined,
      mcpQuery,
    );
    expect(env.jcodemunchAvailable).toBe(true);
    expect(env.jcodemunchCwdIndexed).toBe(false);
    expect(env.jcodemunchCwdRepo).toBeNull();
  });

  it('macOS/uvx: marks available=false when uvx is not installed (which uvx fails)', async () => {
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch': new Error('not found'),
      'which jcodemunch-mcp': new Error('not found'),
      'which uvx': new Error('not found'),
    });

    const env = await detectEnvironment(
      '/Users/jerome/Documents/Claude/Projects/forgd-onboarding',
      exec,
      undefined,
      undefined,
      makeMcpQuery({}),
      () => null,
    );
    expect(env.jcodemunchAvailable).toBe(false);
    expect(env.jcodemunchCwdIndexed).toBe(false);
  });

  it('macOS/uvx: handles uvx jcodemunch-mcp startup failure (mcpQuery returns null) gracefully', async () => {
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch': new Error('not found'),
      'which jcodemunch-mcp': new Error('not found'),
      'which uvx': '/opt/homebrew/bin/uvx',
    });
    const mcpQuery = makeMcpQuery({
      'uvx jcodemunch-mcp': null,
    });

    const env = await detectEnvironment(
      '/Users/jerome/Documents/Claude/Projects/forgd-onboarding',
      exec,
      undefined,
      undefined,
      mcpQuery,
    );
    expect(env.jcodemunchAvailable).toBe(false);
    expect(env.jcodemunchCwdIndexed).toBe(false);
  });

  it('macOS/uvx: mcpQuery is invoked with command=uvx args=[jcodemunch-mcp] (not a shell pipe)', async () => {
    // Regression: previously detection used `printf ... | uvx jcodemunch-mcp` as a
    // shell pipe, which closed stdin at EOF and caused the MCP server to exit
    // before emitting the list_repos response. The new spawn-based approach calls
    // the binary directly with args and holds stdin open until the response arrives.
    let capturedCommand = '';
    let capturedArgs: string[] = [];
    let capturedMessages: string[] = [];
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch': new Error('not found'),
      'which jcodemunch-mcp': new Error('not found'),
      'which uvx': '/opt/homebrew/bin/uvx',
    });
    const mcpQuery: McpQueryFn = async (command, args, messages) => {
      capturedCommand = command;
      capturedArgs = args;
      capturedMessages = messages;
      return mcpListReposResponse([{ repo: 'local/my-project' }]);
    };

    await detectEnvironment('/Users/jerome/projects/my-project', exec, undefined, undefined, mcpQuery, () => null);
    expect(capturedCommand).toBe('uvx');
    expect(capturedArgs).toEqual(['jcodemunch-mcp']);
    // Must include initialize, notifications/initialized, and tools/call list_repos
    expect(capturedMessages).toHaveLength(3);
    expect(capturedMessages[0]).toContain('"method":"initialize"');
    expect(capturedMessages[1]).toContain('"method":"notifications/initialized"');
    expect(capturedMessages[2]).toContain('"name":"list_repos"');
  });

  it('Linux/direct-binary: existing which jcodemunch-mcp path still wins when binary is in PATH (uvx fallback not reached)', async () => {
    // On Linux with pip/pipx install, jcodemunch-mcp lands in ~/.local/bin (in PATH).
    // The direct binary path must be preferred; uvx fallback must not be reached.
    let mcpQueryCommand = '';
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch-mcp': '/home/user/.local/bin/jcodemunch-mcp',
      'which jcodemunch': new Error('not found'),
      // uvx is NOT in this map — if `which uvx` is reached, makeExec throws
    });
    const mcpQuery: McpQueryFn = async (command, args) => {
      mcpQueryCommand = command;
      if (command === '/home/user/.local/bin/jcodemunch-mcp' && args.length === 0) {
        return mcpListReposResponse([{ repo: 'local/my-project' }]);
      }
      return null;
    };

    const env = await detectEnvironment(
      '/home/user/projects/my-project',
      exec,
      undefined,
      undefined,
      mcpQuery,
    );
    expect(env.jcodemunchAvailable).toBe(true);
    expect(env.jcodemunchCwdIndexed).toBe(true);
    expect(env.jcodemunchCwdRepo).toBe('local/my-project');
    expect(mcpQueryCommand).toBe('/home/user/.local/bin/jcodemunch-mcp');
  });
});

describe('detectEnvironment with config-registered MCP transport', () => {
  const WHEEL_URL =
    'https://github.com/jgravelle/jcodemunch-mcp/releases/download/v1.108.20/jcodemunch_mcp-1.108.20-py3-none-any.whl';
  const wheelRegistration = {
    command: 'uvx',
    args: ['--from', WHEEL_URL, 'jcodemunch-mcp'],
    source: 'user' as const,
  };

  const noBinariesExec = makeExec({
    'which rtk': new Error('not found'),
    'which jcodemunch-mcp': new Error('not found'),
    'which jcodemunch': new Error('not found'),
    'which uvx': '/opt/homebrew/bin/uvx',
    'which graphify': new Error('not found'),
  });

  it('detects via registered wheel-URL command when binaries are absent (live-bug regression)', async () => {
    const probeCalls: Array<{ command: string; args: string[] }> = [];
    const mcpQuery: McpQueryFn = async (command, args) => {
      probeCalls.push({ command, args });
      if (command === 'uvx' && args.includes(WHEEL_URL)) {
        return mcpListReposResponse([{ repo: 'franklywatson/my-project' }]);
      }
      return null;
    };

    const env = await detectEnvironment(
      '/work/my-project',
      noBinariesExec,
      () => false,
      () => undefined,
      mcpQuery,
      () => wheelRegistration,
    );

    expect(env.jcodemunchAvailable).toBe(true);
    expect(env.jcodemunchCwdIndexed).toBe(true);
    expect(env.jcodemunchCwdRepo).toBe('franklywatson/my-project');
    expect(env.jcodemunchTransport).toEqual({
      kind: 'config',
      command: 'uvx',
      args: ['--from', WHEEL_URL, 'jcodemunch-mcp'],
      source: 'user',
    });
    // The registration command/args must be passed to the probe verbatim
    expect(probeCalls[0]).toEqual({
      command: 'uvx',
      args: ['--from', WHEEL_URL, 'jcodemunch-mcp'],
    });
  });

  it('falls through to jcodemunch-mcp binary when the registration probe fails', async () => {
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch-mcp': '/usr/local/bin/jcodemunch-mcp',
      'which jcodemunch': new Error('not found'),
      'which graphify': new Error('not found'),
    });
    const mcpQuery: McpQueryFn = async (command) => {
      if (command === '/usr/local/bin/jcodemunch-mcp') {
        return mcpListReposResponse([{ repo: 'local/my-project' }]);
      }
      return null; // registration probe fails
    };

    const env = await detectEnvironment(
      '/work/my-project',
      exec,
      () => false,
      () => undefined,
      mcpQuery,
      () => wheelRegistration,
    );

    expect(env.jcodemunchAvailable).toBe(true);
    expect(env.jcodemunchTransport?.kind).toBe('binary');
    expect(env.jcodemunchTransport?.command).toBe('/usr/local/bin/jcodemunch-mcp');
  });

  it('uses the bare uvx fallback when no registration exists', async () => {
    const mcpQuery: McpQueryFn = async (command, args) => {
      if (command === 'uvx' && args.length === 1 && args[0] === 'jcodemunch-mcp') {
        return mcpListReposResponse([{ repo: 'local/my-project' }]);
      }
      return null;
    };

    const env = await detectEnvironment(
      '/work/my-project',
      noBinariesExec,
      () => false,
      () => undefined,
      mcpQuery,
      () => null,
    );

    expect(env.jcodemunchAvailable).toBe(true);
    expect(env.jcodemunchTransport).toEqual({
      kind: 'uvx',
      command: 'uvx',
      args: ['jcodemunch-mcp'],
    });
  });

  it('records a cli transport when the jcodemunch binary is on PATH', async () => {
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch-mcp': new Error('not found'),
      'which jcodemunch': '/usr/local/bin/jcodemunch',
      'jcodemunch list_repos': JSON.stringify({ repos: ['local/my-project'] }),
      'which graphify': new Error('not found'),
    });

    const env = await detectEnvironment(
      '/work/my-project',
      exec,
      () => false,
      () => undefined,
      makeMcpQuery({}),
      () => null,
    );

    expect(env.jcodemunchAvailable).toBe(true);
    expect(env.jcodemunchTransport?.kind).toBe('cli');
  });

  it('source_root exact-path match wins over ambiguous basenames', async () => {
    const mcpQuery: McpQueryFn = async (command, args) => {
      if (command === 'uvx' && args.includes(WHEEL_URL)) {
        return mcpListReposResponse([
          { repo: 'local/api', source_root: '/other/checkout/api' },
          { repo: 'team/api', source_root: '/work/api' },
        ]);
      }
      return null;
    };

    const env = await detectEnvironment(
      '/work/api',
      noBinariesExec,
      () => false,
      () => undefined,
      mcpQuery,
      () => wheelRegistration,
    );

    expect(env.jcodemunchCwdIndexed).toBe(true);
    expect(env.jcodemunchCwdRepo).toBe('team/api');
    expect(env.jcodemunchKnownRepos).toEqual(['local/api', 'team/api']);
  });

  it('renamed checkout matches via source_root even when basenames differ', async () => {
    const mcpQuery: McpQueryFn = async (command, args) => {
      if (command === 'uvx' && args.includes(WHEEL_URL)) {
        return mcpListReposResponse([
          { repo: 'org/upstream-name', source_root: '/work/my-fork' },
        ]);
      }
      return null;
    };

    const env = await detectEnvironment(
      '/work/my-fork',
      noBinariesExec,
      () => false,
      () => undefined,
      mcpQuery,
      () => wheelRegistration,
    );

    expect(env.jcodemunchCwdIndexed).toBe(true);
    expect(env.jcodemunchCwdRepo).toBe('org/upstream-name');
  });

  it('falls back to strict basename equality when source_root is absent', async () => {
    const mcpQuery: McpQueryFn = async (command, args) => {
      if (command === 'uvx' && args.includes(WHEEL_URL)) {
        return mcpListReposResponse([{ repo: 'local/test-rig' }, { repo: 'local/rig' }]);
      }
      return null;
    };

    const env = await detectEnvironment(
      '/home/jerome/projects/rig',
      noBinariesExec,
      () => false,
      () => undefined,
      mcpQuery,
      () => wheelRegistration,
    );

    expect(env.jcodemunchCwdRepo).toBe('local/rig');
  });

  it('a throwing registrationLookup never breaks detection', async () => {
    const env = await detectEnvironment(
      '/work/my-project',
      noBinariesExec,
      () => false,
      () => undefined,
      makeMcpQuery({}),
      () => { throw new Error('config unreadable'); },
    );

    expect(env.jcodemunchAvailable).toBe(false);
  });
});

describe('MCP protocol version validation', () => {
  const uvxExec = makeExec({
    'which rtk': new Error('not found'),
    'which jcodemunch-mcp': new Error('not found'),
    'which jcodemunch': new Error('not found'),
    'which uvx': '/opt/homebrew/bin/uvx',
    'which graphify': new Error('not found'),
  });

  it('sets no warning when the server speaks the expected protocol version', async () => {
    const mcpQuery = makeMcpQuery({
      'uvx jcodemunch-mcp': mcpListReposResponse([{ repo: 'local/my-project' }]),
    });

    const env = await detectEnvironment(
      '/work/my-project', uvxExec, () => false, () => undefined, mcpQuery, () => null,
    );
    expect(env.jcodemunchAvailable).toBe(true);
    expect(env.jcodemunchProtocolWarning).toBeUndefined();
  });

  it('sets a warning on protocol version mismatch but stays available', async () => {
    const mcpQuery = makeMcpQuery({
      'uvx jcodemunch-mcp': mcpListReposResponse([{ repo: 'local/my-project' }], '2024-11-05'),
    });

    const env = await detectEnvironment(
      '/work/my-project', uvxExec, () => false, () => undefined, mcpQuery, () => null,
    );
    expect(env.jcodemunchAvailable).toBe(true);
    expect(env.jcodemunchCwdIndexed).toBe(true);
    expect(env.jcodemunchProtocolWarning).toContain('2024-11-05');
    expect(env.jcodemunchProtocolWarning).toContain('2025-03-26');
  });

  it('sets no warning when the initialize line is missing or garbled', async () => {
    const reposJson = JSON.stringify({ repos: [{ repo: 'local/my-project' }] });
    const onlyToolResponse = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text', text: reposJson }], isError: false },
    });
    const mcpQuery = makeMcpQuery({
      'uvx jcodemunch-mcp': '{garbled init line\n' + onlyToolResponse,
    });

    const env = await detectEnvironment(
      '/work/my-project', uvxExec, () => false, () => undefined, mcpQuery, () => null,
    );
    expect(env.jcodemunchAvailable).toBe(true);
    expect(env.jcodemunchProtocolWarning).toBeUndefined();
  });

  it('callJcodemunchMcpTool fires onWarning on mismatch and still returns the tool text', async () => {
    const initResponse = JSON.stringify({
      jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' },
    });
    const toolResponse = JSON.stringify({
      jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{"success":true}' }] },
    });
    const mcpQuery = makeMcpQuery({
      'jcodemunch-mcp': initResponse + '\n' + toolResponse,
    });

    const warnings: string[] = [];
    const result = await callJcodemunchMcpTool(
      'jcodemunch-mcp', [], 'index_folder', { path: '/work' }, mcpQuery, 60_000,
      (msg) => warnings.push(msg),
    );

    expect(result).toBe('{"success":true}');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('2024-11-05');
  });
});

describe('detectGraphify', () => {
  it('returns state ready with graphPath when CLI and real graph.json exist', () => {
    const exec = makeExec({
      'which graphify': '/usr/local/bin/graphify',
    });
    const existsCheck = (path: string) =>
      path === '/fake/cwd/graphify-out/graph.json';
    const statCheck = (path: string) =>
      path === '/fake/cwd/graphify-out/graph.json' ? { size: 5000 } : undefined;

    const result = detectGraphify('/fake/cwd', exec, existsCheck, statCheck);
    expect(result.state).toBe('ready');
    expect(result.graphPath).toBe('graphify-out/graph.json');
  });

  it('returns ready when graph.json exists even if CLI is not on PATH', () => {
    // The CLI may be installed off the hook PATH (e.g. ~/.local/bin); a valid
    // graph on disk is sufficient for 'ready' — CLI is only needed to rebuild.
    const exec = makeExec({
      'which graphify': new Error('not found'),
      'which graphifyy': new Error('not found'),
    });
    const existsCheck = (path: string) => path === '/fake/cwd/graphify-out/graph.json';
    const statCheck = (path: string) =>
      path === '/fake/cwd/graphify-out/graph.json' ? { size: 5000 } : undefined;

    const result = detectGraphify('/fake/cwd', exec, existsCheck, statCheck);
    expect(result.state).toBe('ready');
    expect(result.graphPath).toBe('graphify-out/graph.json');
    expect(result._cliFound).toBe(false);
  });

  it('returns state absent when CLI not found and no graph.json', () => {
    const exec = makeExec({
      'which graphify': new Error('not found'),
      'which graphifyy': new Error('not found'),
    });

    const result = detectGraphify('/fake/cwd', exec, () => false, () => undefined);
    expect(result.state).toBe('absent');
    expect(result.graphPath).toBeUndefined();
    expect(result._cliFound).toBe(false);
  });

  it('returns state absent when graphifyy (uvx) binary exists but no graph.json', () => {
    const exec = (cmd: string) => {
      if (cmd === 'which graphify') throw new Error('not found');
      if (cmd === 'which graphifyy') return '/home/user/.local/bin/graphifyy';
      throw new Error(`unexpected: ${cmd}`);
    };
    const existsCheck = (_path: string) => false;
    const statCheck = (_path: string) => undefined;

    const result = detectGraphify('/fake/cwd', exec, existsCheck, statCheck);
    expect(result.state).toBe('absent');
    expect(result.graphPath).toBeUndefined();
  });

  it('returns state absent when graph.json exists but is placeholder (< 1KB)', () => {
    const exec = makeExec({
      'which graphify': '/usr/local/bin/graphify',
    });
    const existsCheck = (path: string) =>
      path === '/fake/cwd/graphify-out/graph.json';
    const statCheck = (path: string) =>
      path === '/fake/cwd/graphify-out/graph.json' ? { size: 50 } : undefined;

    const result = detectGraphify('/fake/cwd', exec, existsCheck, statCheck);
    expect(result.state).toBe('absent');
    expect(result.graphPath).toBeUndefined();
  });

  it('returns state absent when CLI exists but no graph.json', () => {
    const exec = makeExec({
      'which graphify': '/usr/local/bin/graphify',
    });
    const existsCheck = (_path: string) => false;
    const statCheck = (_path: string) => undefined;

    const result = detectGraphify('/fake/cwd', exec, existsCheck, statCheck);
    expect(result.state).toBe('absent');
    expect(result.graphPath).toBeUndefined();
  });

  it('populates graphBuildInfo in detectEnvironment result', async () => {
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch': new Error('not found'),
      'which jcodemunch-mcp': new Error('not found'),
      'which uvx': new Error('not found'),
      'which graphify': '/usr/local/bin/graphify',
    });
    const existsCheck = (path: string) =>
      path === '/project/graphify-out/graph.json';
    const statCheck = (path: string) =>
      path === '/project/graphify-out/graph.json' ? { size: 50000 } : undefined;

    const env = await detectEnvironment('/project', exec, existsCheck, statCheck);
    expect(env.graphBuildInfo).toBeDefined();
    expect(env.graphBuildInfo!.state).toBe('ready');
    expect(env.graphBuildInfo!.graphPath).toBe('graphify-out/graph.json');
    // Backward compat
    expect(env.graphifyAvailable).toBe(true);
    expect(env.graphifyGraphPath).toBe('graphify-out/graph.json');
  });

  it('returns building when .rebuild.lock present and no valid graph', () => {
    const exec = makeExec({ 'which graphify': '/usr/local/bin/graphify' });
    const existsCheck = (path: string) => path === '/fake/cwd/graphify-out/.rebuild.lock';

    const result = detectGraphify(
      '/fake/cwd', exec, existsCheck, () => undefined,
      (path) => (path.endsWith('.rebuild.lock') ? new Date(2000) : undefined),
    );
    expect(result.state).toBe('building');
    expect(result._cliFound).toBe(true);
  });

  it('returns ready when graph.json is newer than .rebuild.lock (stale lock from completed build)', () => {
    // graphify leaves lock files behind after completed builds
    const exec = makeExec({ 'which graphify': '/usr/local/bin/graphify' });
    const existsCheck = (path: string) =>
      path === '/fake/cwd/graphify-out/graph.json' ||
      path === '/fake/cwd/graphify-out/.rebuild.lock';
    const statCheck = (path: string) =>
      path === '/fake/cwd/graphify-out/graph.json' ? { size: 5000 } : undefined;
    const mtimeCheck = (path: string) =>
      path.endsWith('graph.json') ? new Date(5000) : new Date(1000);

    const result = detectGraphify('/fake/cwd', exec, existsCheck, statCheck, mtimeCheck);
    expect(result.state).toBe('ready');
    expect(result.graphPath).toBe('graphify-out/graph.json');
  });

  it('returns building when .rebuild.lock is newer than graph.json (active rebuild)', () => {
    const exec = makeExec({ 'which graphify': '/usr/local/bin/graphify' });
    const existsCheck = (path: string) =>
      path === '/fake/cwd/graphify-out/graph.json' ||
      path === '/fake/cwd/graphify-out/.rebuild.lock';
    const statCheck = (path: string) =>
      path === '/fake/cwd/graphify-out/graph.json' ? { size: 5000 } : undefined;
    const mtimeCheck = (path: string) =>
      path.endsWith('graph.json') ? new Date(1000) : new Date(5000);

    const result = detectGraphify('/fake/cwd', exec, existsCheck, statCheck, mtimeCheck);
    expect(result.state).toBe('building');
  });

  it('captures the CLI version when the probe succeeds', () => {
    const exec = makeExec({
      'which graphify': '/usr/local/bin/graphify',
      'graphify --version': 'graphify 0.7.18',
    });
    const existsCheck = (path: string) => path === '/fake/cwd/graphify-out/graph.json';
    const statCheck = () => ({ size: 5000 });

    const result = detectGraphify('/fake/cwd', exec, existsCheck, statCheck);
    expect(result.state).toBe('ready');
    expect(result.cliVersion).toBe('0.7.18');
  });

  it('parses the version from the binary line, not from skew-warning noise', () => {
    // Live output includes a warning line mentioning a different version:
    //   warning: skill is from graphify 0.7.16, package is 0.7.18. ...
    //   graphify 0.7.18
    const exec = makeExec({
      'which graphify': '/usr/local/bin/graphify',
      'graphify --version':
        "  warning: skill is from graphify 0.7.16, package is 0.7.18. Run 'graphify install' to update.\ngraphify 0.7.18",
    });

    const result = detectGraphify('/fake/cwd', exec, () => false, () => undefined);
    expect(result.cliVersion).toBe('0.7.18');
  });

  it('version probe failure never changes detection state', () => {
    const exec = makeExec({
      'which graphify': '/usr/local/bin/graphify',
      // no 'graphify --version' key — makeExec throws for it
    });
    const existsCheck = (path: string) => path === '/fake/cwd/graphify-out/graph.json';
    const statCheck = () => ({ size: 5000 });

    const result = detectGraphify('/fake/cwd', exec, existsCheck, statCheck);
    expect(result.state).toBe('ready');
    expect(result.cliVersion).toBeUndefined();
  });

  it('probes the graphifyy binary name when that is what resolved', () => {
    const calls: string[] = [];
    const exec = (cmd: string) => {
      calls.push(cmd);
      if (cmd === 'which graphify') throw new Error('not found');
      if (cmd === 'which graphifyy') return '/home/user/.local/bin/graphifyy';
      if (cmd === 'graphifyy --version') return 'graphifyy 0.7.16';
      throw new Error(`unexpected: ${cmd}`);
    };

    const result = detectGraphify('/fake/cwd', exec, () => false, () => undefined);
    expect(result.cliVersion).toBe('0.7.16');
    expect(calls).toContain('graphifyy --version');
  });

  it('exposes graphifyVersion on the detected environment', async () => {
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch-mcp': new Error('not found'),
      'which jcodemunch': new Error('not found'),
      'which uvx': new Error('not found'),
      'which graphify': '/usr/local/bin/graphify',
      'graphify --version': 'graphify 0.7.18',
    });

    const env = await detectEnvironment(
      '/project', exec, () => false, () => undefined, makeMcpQuery({}), () => null,
    );
    expect(env.graphifyVersion).toBe('0.7.18');
  });

  it('returns state ready when graphifyy binary and real graph exist', () => {
    const exec = (cmd: string) => {
      if (cmd === 'which graphify') throw new Error('not found');
      if (cmd === 'which graphifyy') return '/home/user/.local/bin/graphifyy';
      throw new Error(`unexpected: ${cmd}`);
    };
    const existsCheck = (path: string) =>
      path === '/fake/cwd/graphify-out/graph.json';
    const statCheck = (path: string) =>
      path === '/fake/cwd/graphify-out/graph.json' ? { size: 74000000 } : undefined;

    const result = detectGraphify('/fake/cwd', exec, existsCheck, statCheck);
    expect(result.state).toBe('ready');
    expect(result.graphPath).toBe('graphify-out/graph.json');
  });
});

describe('callJcodemunchMcpTool', () => {
  // Helper to build an index_folder-style MCP response.
  function mcpToolResponse(payload: object): string {
    const rpcResponse = {
      jsonrpc: '2.0',
      id: 2,
      result: {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        isError: false,
      },
    };
    const initResponse = { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } };
    return JSON.stringify(initResponse) + '\n' + JSON.stringify(rpcResponse);
  }

  it('invokes a direct binary with empty args', async () => {
    let capturedCommand = '';
    let capturedArgs: string[] = [];
    const mcpQuery: McpQueryFn = async (command, args) => {
      capturedCommand = command;
      capturedArgs = args;
      return mcpToolResponse({ success: true, repo: 'local/proj' });
    };

    const result = await callJcodemunchMcpTool(
      '/usr/local/bin/jcodemunch-mcp',
      [],
      'index_folder',
      { path: '/fake/cwd' },
      mcpQuery,
    );
    expect(capturedCommand).toBe('/usr/local/bin/jcodemunch-mcp');
    expect(capturedArgs).toEqual([]);
    expect(result).toBeTruthy();
    expect(JSON.parse(result!)).toEqual({ success: true, repo: 'local/proj' });
  });

  it('invokes uvx with [jcodemunch-mcp] args for macOS uvx installs', async () => {
    let capturedCommand = '';
    let capturedArgs: string[] = [];
    const mcpQuery: McpQueryFn = async (command, args) => {
      capturedCommand = command;
      capturedArgs = args;
      return mcpToolResponse({ success: true });
    };

    const result = await callJcodemunchMcpTool(
      'uvx',
      ['jcodemunch-mcp'],
      'index_folder',
      { path: '/fake/cwd' },
      mcpQuery,
    );
    expect(capturedCommand).toBe('uvx');
    expect(capturedArgs).toEqual(['jcodemunch-mcp']);
    expect(result).toBeTruthy();
  });

  it('sends initialize + notifications/initialized + tool call in order', async () => {
    let capturedMessages: string[] = [];
    const mcpQuery: McpQueryFn = async (_command, _args, messages) => {
      capturedMessages = messages;
      return mcpToolResponse({ ok: true });
    };

    await callJcodemunchMcpTool(
      'uvx',
      ['jcodemunch-mcp'],
      'search_symbols',
      { query: 'foo' },
      mcpQuery,
    );
    expect(capturedMessages).toHaveLength(3);
    expect(capturedMessages[0]).toContain('"method":"initialize"');
    expect(capturedMessages[1]).toContain('"method":"notifications/initialized"');
    expect(capturedMessages[2]).toContain('"name":"search_symbols"');
    expect(capturedMessages[2]).toContain('"query":"foo"');
  });

  it('returns null when mcpQuery returns null (timeout / no match)', async () => {
    const mcpQuery: McpQueryFn = async () => null;
    const result = await callJcodemunchMcpTool(
      'uvx',
      ['jcodemunch-mcp'],
      'index_folder',
      { path: '/fake' },
      mcpQuery,
    );
    expect(result).toBeNull();
  });

  it('returns null when response lacks id:2 line', async () => {
    const mcpQuery: McpQueryFn = async () =>
      '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26"}}';
    const result = await callJcodemunchMcpTool(
      'uvx',
      ['jcodemunch-mcp'],
      'index_folder',
      { path: '/fake' },
      mcpQuery,
    );
    expect(result).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    const mcpQuery: McpQueryFn = async () => '{"id":2 not-valid-json';
    const result = await callJcodemunchMcpTool(
      'uvx',
      ['jcodemunch-mcp'],
      'index_folder',
      { path: '/fake' },
      mcpQuery,
    );
    expect(result).toBeNull();
  });
});

describe('defaultMcpQuery (real-process integration)', () => {
  // Smoke test: spawn a tiny shell script that emits a fake MCP response,
  // verify defaultMcpQuery reads stdout and resolves when it sees `"id":<matchId>`.
  it('resolves with stdout once matching id line arrives, then kills the child', async () => {
    // Use printf with two separate calls so the inner JSON's quotes survive.
    // The child sleeps after printing — defaultMcpQuery must kill it on match.
    const start = Date.now();
    const result = await defaultMcpQuery(
      '/bin/sh',
      ['-c', `printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{}}'; printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"value":42}}'; sleep 10`],
      [],
      2,
      5_000,
    );
    const elapsed = Date.now() - start;
    expect(result).toContain('"id":2');
    expect(result).toContain('"value":42');
    // Must have returned quickly after id:2 — well under the sleep 10 + 5s timeout.
    expect(elapsed).toBeLessThan(3_000);
  });

  it('returns null on timeout when no matching id appears', async () => {
    // Spawn a process that emits unrelated output then sleeps. With a 200ms
    // timeout and no matching id:2, we should resolve null.
    const result = await defaultMcpQuery(
      '/bin/sh',
      ['-c', 'printf "unrelated\\n"; sleep 5'],
      [],
      2,
      200,
    );
    expect(result).toBeNull();
  });

  it('returns null when spawned command does not exist', async () => {
    const result = await defaultMcpQuery(
      '/nonexistent/binary-that-should-not-exist',
      [],
      [],
      2,
      1_000,
    );
    expect(result).toBeNull();
  });
});

describe('detectEnvironment agent-teams detection', () => {
  const noToolsExec = makeExec({
    'which rtk': new Error('not found'),
    'which jcodemunch': new Error('not found'),
    'which jcodemunch-mcp': new Error('not found'),
    'which uvx': new Error('not found'),
  });

  it('detects agent teams from the experimental env flag', async () => {
    const env = await detectEnvironment(
      '/fake/cwd',
      noToolsExec,
      () => false,
      () => undefined,
      makeMcpQuery({}),
      () => null,
      { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
    );
    expect(env.agentTeamsAvailable).toBe(true);
  });

  it('reports agent teams unavailable when the flag is absent', async () => {
    const env = await detectEnvironment(
      '/fake/cwd',
      noToolsExec,
      () => false,
      () => undefined,
      makeMcpQuery({}),
      () => null,
      {},
    );
    expect(env.agentTeamsAvailable).toBe(false);
  });

  it('reports agent teams unavailable when the flag is not "1"', async () => {
    const env = await detectEnvironment(
      '/fake/cwd',
      noToolsExec,
      () => false,
      () => undefined,
      makeMcpQuery({}),
      () => null,
      { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0' },
    );
    expect(env.agentTeamsAvailable).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { detectEnvironment, detectGraphify } from '../../src/session/environment.js';
import type { ExecFn } from '../../src/session/environment.js';

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

// Helper to build MCP JSON-RPC response for list_repos
function mcpListReposResponse(repos: Array<{ repo: string }>): string {
  const reposJson = JSON.stringify({ repos });
  const rpcResponse = {
    jsonrpc: '2.0',
    id: 2,
    result: {
      content: [{ type: 'text', text: reposJson }],
      isError: false,
    },
  };
  const initResponse = { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } };
  return JSON.stringify(initResponse) + '\n' + JSON.stringify(rpcResponse);
}

describe('detectEnvironment', () => {
  it('detects rtk available when which succeeds', async () => {
    const exec = makeExec({
      'which rtk': '/usr/local/bin/rtk',
      'which jcodemunch': new Error('not found'),
      'which jcodemunch-mcp': new Error('not found'),
    });

    const env = await detectEnvironment('/fake/cwd', exec);
    expect(env.rtkAvailable).toBe(true);
    expect(env.rtkPath).toBe('/usr/local/bin/rtk');
  });

  it('detects rtk unavailable when which fails', async () => {
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch': new Error('not found'),
      'which jcodemunch-mcp': new Error('not found'),
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

  it('detects jcodemunch unavailable when neither CLI nor MCP found', async () => {
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch': new Error('not found'),
      'which jcodemunch-mcp': new Error('not found'),
    });

    const env = await detectEnvironment('/fake/cwd', exec);
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
    const mcpOutput = mcpListReposResponse([{ repo: 'local/ai-news' }]);
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch-mcp': '/home/user/.local/bin/jcodemunch-mcp\n',
      'which jcodemunch': new Error('not found'),
      'jcodemunch-mcp': mcpOutput,
    });

    const env = await detectEnvironment('/home/user/projects/ai-news', exec);
    expect(env.jcodemunchAvailable).toBe(true);
    expect(env.jcodemunchCwdIndexed).toBe(true);
    expect(env.jcodemunchCwdRepo).toBe('local/ai-news');
    expect(env.jcodemunchKnownRepos).toContain('local/ai-news');
  });

  it('detects jcodemunch MCP available but CWD not indexed', async () => {
    const mcpOutput = mcpListReposResponse([
      { repo: 'local/other-project' },
      { repo: 'local/third-project' },
    ]);
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch-mcp': '/home/user/.local/bin/jcodemunch-mcp\n',
      'which jcodemunch': new Error('not found'),
      'jcodemunch-mcp': mcpOutput,
    });

    const env = await detectEnvironment('/home/user/projects/ai-news', exec);
    expect(env.jcodemunchAvailable).toBe(true);
    expect(env.jcodemunchCwdIndexed).toBe(false);
    expect(env.jcodemunchKnownRepos).toHaveLength(2);
  });

  it('handles malformed MCP JSON-RPC response gracefully', async () => {
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch-mcp': '/home/user/.local/bin/jcodemunch-mcp\n',
      'which jcodemunch': new Error('not found'),
      'jcodemunch-mcp': 'not valid json',
    });

    const env = await detectEnvironment('/home/user/projects/ai-news', exec);
    // Should still mark as available since the binary exists
    expect(env.jcodemunchAvailable).toBe(true);
    expect(env.jcodemunchCwdIndexed).toBe(false);
  });

  it('handles MCP query failure gracefully', async () => {
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch-mcp': '/home/user/.local/bin/jcodemunch-mcp\n',
      'which jcodemunch': new Error('not found'),
      'jcodemunch-mcp': new Error('timeout'),
    });

    const env = await detectEnvironment('/home/user/projects/ai-news', exec);
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

    const env = await detectEnvironment('/fake/cwd', exec);
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
    const mcpOutput = mcpListReposResponse([{ repo: 'local/forgd-onboarding' }]);
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch': new Error('not found'),
      'which jcodemunch-mcp': new Error('not found'),
      'which uvx': '/opt/homebrew/bin/uvx',
      'uvx jcodemunch-mcp': mcpOutput,
    });

    const env = await detectEnvironment('/Users/jerome/Documents/Claude/Projects/forgd-onboarding', exec);
    expect(env.jcodemunchAvailable).toBe(true);
    expect(env.jcodemunchCwdIndexed).toBe(true);
    expect(env.jcodemunchCwdRepo).toBe('local/forgd-onboarding');
  });

  it('macOS/uvx: marks available=true but cwdIndexed=false when uvx runs but CWD not in repo list', async () => {
    const mcpOutput = mcpListReposResponse([{ repo: 'local/other-project' }]);
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch': new Error('not found'),
      'which jcodemunch-mcp': new Error('not found'),
      'which uvx': '/opt/homebrew/bin/uvx',
      'uvx jcodemunch-mcp': mcpOutput,
    });

    const env = await detectEnvironment('/Users/jerome/Documents/Claude/Projects/forgd-onboarding', exec);
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

    const env = await detectEnvironment('/Users/jerome/Documents/Claude/Projects/forgd-onboarding', exec);
    expect(env.jcodemunchAvailable).toBe(false);
    expect(env.jcodemunchCwdIndexed).toBe(false);
  });

  it('macOS/uvx: handles uvx jcodemunch-mcp startup failure gracefully (exit nonzero / timeout)', async () => {
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch': new Error('not found'),
      'which jcodemunch-mcp': new Error('not found'),
      'which uvx': '/opt/homebrew/bin/uvx',
      'uvx jcodemunch-mcp': new Error('uvx: Package jcodemunch-mcp not found'),
    });

    const env = await detectEnvironment('/Users/jerome/Documents/Claude/Projects/forgd-onboarding', exec);
    expect(env.jcodemunchAvailable).toBe(false);
    expect(env.jcodemunchCwdIndexed).toBe(false);
  });

  it('Linux/direct-binary: existing which jcodemunch-mcp path still wins when binary is in PATH (uvx fallback not reached)', async () => {
    // On Linux with pip/pipx install, jcodemunch-mcp lands in ~/.local/bin (in PATH).
    // The direct binary path must be preferred; uvx fallback must not be reached.
    // Note: 'which jcodemunch-mcp' must come before 'which jcodemunch' in the map
    // because makeExec uses substring matching and the shorter key would match first.
    const mcpOutput = mcpListReposResponse([{ repo: 'local/my-project' }]);
    const exec = makeExec({
      'which rtk': new Error('not found'),
      'which jcodemunch-mcp': '/home/user/.local/bin/jcodemunch-mcp',
      'which jcodemunch': new Error('not found'),
      'jcodemunch-mcp': mcpOutput,
      // uvx is NOT in this map — if the code reaches it, makeExec throws "unexpected command"
    });

    const env = await detectEnvironment('/home/user/projects/my-project', exec);
    expect(env.jcodemunchAvailable).toBe(true);
    expect(env.jcodemunchCwdIndexed).toBe(true);
    expect(env.jcodemunchCwdRepo).toBe('local/my-project');
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

  it('returns state absent when which graphify fails', () => {
    const exec = makeExec({
      'which graphify': new Error('not found'),
      'which graphifyy': new Error('not found'),
    });
    const existsCheck = (_path: string) => true;
    const statCheck = (_path: string) => ({ size: 5000 });

    const result = detectGraphify('/fake/cwd', exec, existsCheck, statCheck);
    expect(result.state).toBe('absent');
    expect(result.graphPath).toBeUndefined();
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

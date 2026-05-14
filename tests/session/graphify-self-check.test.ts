import { describe, it, expect } from 'vitest';
import { checkGraphifyMcpReadiness } from '../../src/session/graphify-self-check.js';
import type { ExecFn } from '../../src/session/environment.js';
import type { Environment } from '../../src/types.js';

// ── helpers ─────────────────────────────────────────────────────────────────

function makeExec(responses: Record<string, string | Error>): ExecFn {
  return (cmd: string) => {
    // Sort by pattern length descending so longer (more specific) patterns win.
    // This prevents 'which graphify' from matching 'which graphifyy'.
    const entries = Object.entries(responses).sort(([a], [b]) => b.length - a.length);
    for (const [pattern, result] of entries) {
      if (cmd.includes(pattern) || cmd === pattern) {
        if (result instanceof Error) throw result;
        return result;
      }
    }
    throw new Error(`unexpected command: ${cmd}`);
  };
}

function makeEnv(overrides: Partial<Environment> = {}): Environment {
  return {
    rtkAvailable: false,
    rtkPath: null,
    jcodemunchAvailable: false,
    jcodemunchCwdIndexed: false,
    jcodemunchCwdRepo: null,
    jcodemunchKnownRepos: [],
    graphifyAvailable: false,
    graphifyGraphPath: null,
    graphBuildInfo: undefined,
    detectedAt: Date.now(),
    ...overrides,
  };
}

// ── status: cli_missing ──────────────────────────────────────────────────────

describe('checkGraphifyMcpReadiness — cli_missing', () => {
  it('returns cli_missing when neither graphify nor graphifyy is on PATH', () => {
    const exec = makeExec({
      'which graphify': new Error('not found'),
      'which graphifyy': new Error('not found'),
    });
    const env = makeEnv();

    const result = checkGraphifyMcpReadiness('/fake/cwd', env, exec);
    expect(result.status).toBe('cli_missing');
  });
});

// ── status: no_graph ────────────────────────────────────────────────────────

describe('checkGraphifyMcpReadiness — no_graph', () => {
  it('returns no_graph when CLI exists but graphBuildInfo state is absent', () => {
    const exec = makeExec({
      'which graphify': '/usr/bin/graphify',
    });
    const env = makeEnv({
      graphBuildInfo: { state: 'absent' },
    });

    const result = checkGraphifyMcpReadiness('/fake/cwd', env, exec);
    expect(result.status).toBe('no_graph');
    if (result.status === 'no_graph') {
      expect(result.fixCommand).toBe('graphify update .');
    }
  });

  it('returns no_graph with graphifyy binary', () => {
    const exec = makeExec({
      'which graphify': new Error('not found'),
      'which graphifyy': '/home/user/.local/bin/graphifyy',
    });
    const env = makeEnv({
      graphBuildInfo: { state: 'absent' },
    });

    const result = checkGraphifyMcpReadiness('/fake/cwd', env, exec);
    expect(result.status).toBe('no_graph');
  });
});

// ── status: cli_only_mcp_dep_missing ────────────────────────────────────────

describe('checkGraphifyMcpReadiness — cli_only_mcp_dep_missing', () => {
  it('returns cli_only_mcp_dep_missing when python serve probe fails with ModuleNotFoundError', () => {
    const uvPythonPath = '/home/user/.local/share/uv/tools/graphifyy/bin/python3';
    const exec = makeExec({
      'which graphify': new Error('not found'),
      'which graphifyy': '/home/user/.local/bin/graphifyy',
      'which python3': '/usr/bin/python3',
      'claude mcp list': 'No MCP servers configured',
      [`${uvPythonPath} -c`]: new Error("ModuleNotFoundError: No module named 'mcp'"),
      'python3 -c': new Error("ModuleNotFoundError: No module named 'mcp'"),
    });
    const env = makeEnv({
      graphBuildInfo: { state: 'ready', graphPath: 'graphify-out/graph.json' },
    });

    const result = checkGraphifyMcpReadiness('/fake/cwd', env, exec);
    expect(result.status).toBe('cli_only_mcp_dep_missing');
    if (result.status === 'cli_only_mcp_dep_missing') {
      expect(result.fixCommand).toBe('uv tool install graphifyy --with mcp --force');
    }
  });

  it('includes the correct fix command', () => {
    const exec = makeExec({
      'which graphify': '/usr/bin/graphify',
      'which python3': '/usr/bin/python3',
      'claude mcp list': 'No MCP servers configured',
      'python3 -c': new Error("ModuleNotFoundError: No module named 'mcp'"),
    });
    const env = makeEnv({
      graphBuildInfo: { state: 'ready', graphPath: 'graphify-out/graph.json' },
    });

    const result = checkGraphifyMcpReadiness('/fake/cwd', env, exec);
    expect(result.status).toBe('cli_only_mcp_dep_missing');
    if (result.status === 'cli_only_mcp_dep_missing') {
      expect(result.fixCommand).toContain('uv tool install graphifyy');
      expect(result.fixCommand).toContain('--with mcp');
    }
  });
});

// ── status: cli_only_not_registered ─────────────────────────────────────────

describe('checkGraphifyMcpReadiness — cli_only_not_registered', () => {
  it('returns cli_only_not_registered when mcp module loads but claude mcp list lacks graphify', () => {
    const exec = makeExec({
      'which graphify': '/usr/bin/graphify',
      'which python3': '/usr/bin/python3',
      'claude mcp list': 'jcodemunch\nsome-other-server',
      'python3 -c': '',  // mcp module loads successfully (no error)
    });
    const env = makeEnv({
      graphBuildInfo: { state: 'ready', graphPath: 'graphify-out/graph.json' },
    });

    const result = checkGraphifyMcpReadiness('/fake/cwd', env, exec);
    expect(result.status).toBe('cli_only_not_registered');
    if (result.status === 'cli_only_not_registered') {
      expect(result.fixCommand).toContain('claude mcp add');
      expect(result.fixCommand).toContain('graphify');
    }
  });

  it('fix command uses uv-tool python path when graphifyy binary is present', () => {
    const uvPythonPath = '/home/user/.local/share/uv/tools/graphifyy/bin/python3';
    const exec = (cmd: string): string => {
      if (cmd === 'which graphify') throw new Error('not found');
      if (cmd === 'which graphifyy') return '/home/user/.local/bin/graphifyy';
      if (cmd === 'which python3') return '/usr/bin/python3';
      if (cmd.includes('claude mcp list')) return 'jcodemunch';
      if (cmd.includes(`${uvPythonPath} -c`)) return '';   // mcp loads ok
      if (cmd.includes('python3 -c')) return '';            // fallback also ok
      throw new Error(`unexpected: ${cmd}`);
    };
    const env = makeEnv({
      graphBuildInfo: { state: 'ready', graphPath: 'graphify-out/graph.json' },
    });

    const result = checkGraphifyMcpReadiness('/fake/cwd', env, exec);
    expect(result.status).toBe('cli_only_not_registered');
    if (result.status === 'cli_only_not_registered') {
      expect(result.fixCommand).toContain('claude mcp add');
    }
  });

  it('fix command references graph.json path from cwd', () => {
    const exec = makeExec({
      'which graphify': '/usr/bin/graphify',
      'which python3': '/usr/bin/python3',
      'claude mcp list': 'nothing here',
      'python3 -c': '',
    });
    const env = makeEnv({
      graphBuildInfo: { state: 'ready', graphPath: 'graphify-out/graph.json' },
    });

    const result = checkGraphifyMcpReadiness('/my/project', env, exec);
    expect(result.status).toBe('cli_only_not_registered');
    if (result.status === 'cli_only_not_registered') {
      expect(result.fixCommand).toContain('/my/project/graphify-out/graph.json');
    }
  });
});

// ── status: ready ────────────────────────────────────────────────────────────

describe('checkGraphifyMcpReadiness — ready', () => {
  it('returns ready when claude mcp list includes graphify', () => {
    const exec = makeExec({
      'which graphify': '/usr/bin/graphify',
      'which python3': '/usr/bin/python3',
      'claude mcp list': 'graphify\njcodemunch',
      'python3 -c': '',
    });
    const env = makeEnv({
      graphBuildInfo: { state: 'ready', graphPath: 'graphify-out/graph.json' },
    });

    const result = checkGraphifyMcpReadiness('/fake/cwd', env, exec);
    expect(result.status).toBe('ready');
  });

  it('returns ready when mcp list includes graphify (case-insensitive substring)', () => {
    const exec = makeExec({
      'which graphify': '/usr/bin/graphify',
      'which python3': '/usr/bin/python3',
      'claude mcp list': 'Graphify (running) - /usr/bin/python3 -m graphify.serve',
      'python3 -c': '',
    });
    const env = makeEnv({
      graphBuildInfo: { state: 'ready', graphPath: 'graphify-out/graph.json' },
    });

    const result = checkGraphifyMcpReadiness('/fake/cwd', env, exec);
    expect(result.status).toBe('ready');
  });
});

// ── edge cases ───────────────────────────────────────────────────────────────

describe('checkGraphifyMcpReadiness — edge cases', () => {
  it('returns cli_missing when graphBuildInfo is undefined and CLI not found', () => {
    const exec = makeExec({
      'which graphify': new Error('not found'),
      'which graphifyy': new Error('not found'),
    });
    const env = makeEnv({ graphBuildInfo: undefined });

    const result = checkGraphifyMcpReadiness('/fake/cwd', env, exec);
    expect(result.status).toBe('cli_missing');
  });

  it('returns no_graph when graphBuildInfo state is failed', () => {
    const exec = makeExec({
      'which graphify': '/usr/bin/graphify',
    });
    const env = makeEnv({ graphBuildInfo: { state: 'failed' } });

    const result = checkGraphifyMcpReadiness('/fake/cwd', env, exec);
    expect(result.status).toBe('no_graph');
    if (result.status === 'no_graph') {
      expect(result.fixCommand).toBe('graphify update .');
    }
  });

  it('returns no_graph when graphBuildInfo state is building', () => {
    const exec = makeExec({
      'which graphify': '/usr/bin/graphify',
    });
    const env = makeEnv({ graphBuildInfo: { state: 'building' } });

    const result = checkGraphifyMcpReadiness('/fake/cwd', env, exec);
    expect(result.status).toBe('no_graph');
  });

  it('handles claude mcp list failure gracefully (treats as not registered)', () => {
    const exec = makeExec({
      'which graphify': '/usr/bin/graphify',
      'which python3': '/usr/bin/python3',
      'claude mcp list': new Error('command not found: claude'),
      'python3 -c': '',
    });
    const env = makeEnv({
      graphBuildInfo: { state: 'ready', graphPath: 'graphify-out/graph.json' },
    });

    const result = checkGraphifyMcpReadiness('/fake/cwd', env, exec);
    // Can't verify registration, so treat as not_registered
    expect(result.status).toBe('cli_only_not_registered');
  });
});

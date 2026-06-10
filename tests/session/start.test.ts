import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSessionStart, detectAndIndex } from '../../src/session/start.js';
import { SessionCache } from '../../src/session/cache.js';
import type { ExecFn, McpQueryFn } from '../../src/session/environment.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';

describe('handleSessionStart', () => {
  let cache: SessionCache;

  beforeEach(() => {
    cache = new SessionCache();
    vi.resetAllMocks();
  });

  it('detects environment and caches it', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'which rtk') return '/usr/bin/rtk';
      if (cmd === 'which jcodemunch') return '/usr/bin/jcodemunch';
      if (cmd.includes('list_repos')) return '{"repos":["local/test-project"]}';
      return '';
    });

    const output = await handleSessionStart('/home/user/test-project', cache);

    const env = cache.getEnvironment();
    expect(env).toBeDefined();
    expect(env!.rtkAvailable).toBe(true);
    expect(env!.jcodemunchAvailable).toBe(true);
  });

  it('detects Python env and caches it', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'which rtk') throw new Error('not found');
      if (cmd === 'which jcodemunch') throw new Error('not found');
      if (cmd === 'which uv') return '/usr/bin/uv\n';
      return '';
    });

    await handleSessionStart('/home/user/test-project', cache);

    const pyEnv = cache.getPythonEnv();
    expect(pyEnv).toBeDefined();
    expect(pyEnv!.uvAvailable).toBe(true);
    expect(pyEnv!.uvPath).toBe('/usr/bin/uv');
  });

  it('detects Python env with .venv', async () => {
    const { mkdirSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const tmpDir = '/tmp/rig-test-pyenv-' + process.pid;
    mkdirSync(join(tmpDir, '.venv', 'bin'), { recursive: true });

    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'which rtk') throw new Error('not found');
      if (cmd === 'which jcodemunch') throw new Error('not found');
      if (cmd === 'which uv') throw new Error('not found');
      return '';
    });

    await handleSessionStart(tmpDir, cache);

    const pyEnv = cache.getPythonEnv();
    expect(pyEnv).toBeDefined();
    expect(pyEnv!.venvPath).toBe(join(tmpDir, '.venv'));

    rmSync(tmpDir, { recursive: true });
  });

  it('auto-indexes CWD with jcodemunch when available but not indexed', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'which rtk') throw new Error('not found');
      if (cmd === 'which jcodemunch') return '/usr/bin/jcodemunch';
      if (cmd.includes('list_repos')) return '{"repos":[]}';
      if (cmd.includes('index_folder')) return JSON.stringify({ success: true, repo: 'local/test-project' });
      return '';
    });

    await handleSessionStart('/home/user/test-project', cache);

    // Should have called index_folder for the CWD
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('index_folder'),
      expect.anything(),
    );
  });

  it('skips indexing when already indexed', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'which rtk') throw new Error('not found');
      if (cmd === 'which jcodemunch') return '/usr/bin/jcodemunch';
      if (cmd.includes('list_repos')) return JSON.stringify({ repos: ['local/test-project'] });
      return '';
    });

    await handleSessionStart('/home/user/test-project', cache);

    // Should NOT have called index_folder — already indexed
    const calls = vi.mocked(execSync).mock.calls.map(c => c[0] as string);
    expect(calls.find(c => c.includes('index_folder'))).toBeUndefined();
  });

  it('skips indexing when jcodemunch not available', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'which rtk') throw new Error('not found');
      if (cmd === 'which jcodemunch') throw new Error('not found');
      return '';
    });

    await handleSessionStart('/home/user/test-project', cache);

    const calls = vi.mocked(execSync).mock.calls.map(c => c[0] as string);
    expect(calls.find(c => c.includes('index_folder'))).toBeUndefined();
  });

  it('returns diagnostic output for session start', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'which rtk') return '/usr/bin/rtk';
      if (cmd === 'which jcodemunch') return '/usr/bin/jcodemunch';
      if (cmd.includes('list_repos')) return '{"repos":["local/test-project"]}';
      return '';
    });

    const output = await handleSessionStart('/home/user/test-project', cache);
    expect(output).toContain('rtk');
    expect(output).toContain('jcodemunch');
    expect(output).toContain('indexed');
  });

  it('includes worktree suggestion when on master', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'which rtk') throw new Error('not found');
      if (cmd === 'which jcodemunch') throw new Error('not found');
      if (cmd === 'git branch --show-current') return 'master';
      return '';
    });

    const output = await handleSessionStart('/home/user/test-project', cache);
    expect(output).toContain('using-git-worktrees');
  });

  it('omits worktree suggestion when on feature branch', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'which rtk') throw new Error('not found');
      if (cmd === 'which jcodemunch') throw new Error('not found');
      if (cmd === 'git branch --show-current') return 'feat/something';
      return '';
    });

    const output = await handleSessionStart('/home/user/test-project', cache);
    expect(output).not.toContain('using-git-worktrees');
  });

  it('warns when rtk is not installed', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'which rtk') throw new Error('not found');
      if (cmd === 'which jcodemunch') return '/usr/bin/jcodemunch';
      if (cmd.includes('list_repos')) return '{"repos":["local/test-project"]}';
      return '';
    });

    const output = await handleSessionStart('/home/user/test-project', cache);
    expect(output).toContain('WARNING');
    expect(output).toContain('rtk');
    expect(output).toContain('install');
  });

  it('warns when jcodemunch was not detected', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'which rtk') return '/usr/bin/rtk';
      if (cmd === 'which jcodemunch') throw new Error('not found');
      return '';
    });

    const output = await handleSessionStart('/home/user/test-project', cache);
    expect(output).toContain('WARNING');
    expect(output).toContain('jcodemunch');
    expect(output).toContain('install');
  });

  it('warns when both tools are not installed', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'which rtk') throw new Error('not found');
      if (cmd === 'which jcodemunch') throw new Error('not found');
      if (cmd === 'git branch --show-current') return 'feat/something';
      return '';
    });

    const output = await handleSessionStart('/home/user/test-project', cache);
    expect(output).toContain('rtk');
    expect(output).toContain('jcodemunch');
    // Should contain two warnings
    const warningCount = (output.match(/WARNING/g) ?? []).length;
    expect(warningCount).toBeGreaterThanOrEqual(2);
  });

  it('does not warn when both tools are available', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'which rtk') return '/usr/bin/rtk';
      if (cmd === 'which jcodemunch') return '/usr/bin/jcodemunch';
      if (cmd.includes('list_repos')) return '{"repos":["local/test-project"]}';
      return '';
    });

    const output = await handleSessionStart('/home/user/test-project', cache);
    // The tool-missing warnings (rtk/jcodemunch) should not appear when both are present.
    expect(output).not.toContain('rtk is not installed');
    expect(output).not.toContain('jcodemunch was not detected');
  });

  it('emits subagent delegation instructions when jcodemunch available', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'which rtk') return '/usr/bin/rtk';
      if (cmd === 'which jcodemunch') return '/usr/bin/jcodemunch';
      if (cmd.includes('list_repos')) return '{"repos":["local/test-project"]}';
      return '';
    });

    const output = await handleSessionStart('/home/user/test-project', cache);
    expect(output).toContain('When spawning subagents');
    expect(output).toContain('mcp__jcodemunch__search_text');
    expect(output).toContain('mcp__jcodemunch__get_file_tree');
    expect(output).toContain('mcp__jcodemunch__get_file_outline');
  });

  it('omits subagent delegation instructions when jcodemunch unavailable', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'which rtk') return '/usr/bin/rtk';
      if (cmd === 'which jcodemunch') throw new Error('not found');
      return '';
    });

    const output = await handleSessionStart('/home/user/test-project', cache);
    expect(output).not.toContain('When spawning subagents');
    expect(output).not.toContain('mcp__jcodemunch__');
  });

  it('emits scout agent preference when jcodemunch available', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'which rtk') return '/usr/bin/rtk';
      if (cmd === 'which jcodemunch') return '/usr/bin/jcodemunch';
      if (cmd.includes('list_repos')) return '{"repos":["local/test-project"]}';
      return '';
    });

    const output = await handleSessionStart('/home/user/test-project', cache);
    expect(output).toContain('scout');
    expect(output).toContain('subagent_type');
    expect(output).toContain('Explore');
  });

  it('omits scout agent preference when jcodemunch unavailable', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'which rtk') return '/usr/bin/rtk';
      if (cmd === 'which jcodemunch') throw new Error('not found');
      return '';
    });

    const output = await handleSessionStart('/home/user/test-project', cache);
    expect(output).not.toContain('scout');
  });

  it('suppresses warning on second call', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'which rtk') throw new Error('not found');
      if (cmd === 'which jcodemunch') throw new Error('not found');
      if (cmd === 'git branch --show-current') return 'feat/something';
      return '';
    });

    // First call — tool-missing warnings present
    const output1 = await handleSessionStart('/home/user/test-project', cache);
    expect(output1).toContain('rtk is not installed');
    expect(output1).toContain('jcodemunch was not detected');

    // Second call — tool-missing warnings suppressed by toolsWarned flag
    // (the permissions warning is independent and may still fire)
    const output2 = await handleSessionStart('/home/user/test-project', cache);
    expect(output2).not.toContain('rtk is not installed');
    expect(output2).not.toContain('jcodemunch was not detected');
  });

  it('emits active enforcement rules when rules are not all silent', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'which rtk') return '/usr/bin/rtk';
      if (cmd === 'which jcodemunch') return '/usr/bin/jcodemunch';
      if (cmd.includes('list_repos')) return '{"repos":["local/test-project"]}';
      return '';
    });

    const output = await handleSessionStart('/home/user/test-project', cache);
    // Default config has no_mocks: block, which should appear in active rules
    expect(output).toContain('Active enforcement');
    expect(output).toContain('no_mocks');
  });

  it('omits active enforcement line when all constitutional rules are silent', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'which rtk') return '/usr/bin/rtk';
      if (cmd === 'which jcodemunch') return '/usr/bin/jcodemunch';
      if (cmd.includes('list_repos')) return '{"repos":["local/test-project"]}';
      return '';
    });

    // Create a test config with all silent constitutional rules
    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const configDir = '/tmp/rig-test-config-' + process.pid;
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, '.harness.yaml'), [
      'rules:',
      '  constitutional:',
      '    no_mocks: silent',
      '    evidence_only: silent',
      '    full_accounting: silent',
    ].join('\n'));

    const output = await handleSessionStart(configDir, cache);
    expect(output).not.toContain('Active enforcement');

    rmSync(configDir, { recursive: true });
  });

  it('includes only non-silent rules in active enforcement', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'which rtk') return '/usr/bin/rtk';
      if (cmd === 'which jcodemunch') return '/usr/bin/jcodemunch';
      if (cmd.includes('list_repos')) return '{"repos":["local/test-project"]}';
      return '';
    });

    // Create a test config with mixed levels
    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const configDir = '/tmp/rig-test-config-' + process.pid + '-mixed';
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, '.harness.yaml'), [
      'rules:',
      '  constitutional:',
      '    no_mocks: block',
      '    evidence_only: silent',
      '    full_accounting: advise',
    ].join('\n'));

    const output = await handleSessionStart(configDir, cache);
    expect(output).toContain('Active enforcement');
    expect(output).toContain('no_mocks (block)');
    expect(output).toContain('full_accounting (advise)');
    expect(output).not.toContain('evidence_only');

    rmSync(configDir, { recursive: true });
  });

  describe('graphify integration', () => {
    it('detects graphify and emits graphify line in session output', async () => {
      const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
      const { join } = await import('node:path');
      const tmpDir = '/tmp/rig-test-graphify-' + process.pid;
      mkdirSync(join(tmpDir, 'graphify-out'), { recursive: true });
      const graphObj = {
        nodes: [{ id: 'a', community: 0 }, { id: 'b', community: 0 }, { id: 'c', community: 1 }],
        links: [
          { source: 'a', target: 'b', confidence: 'EXTRACTED' },
          { source: 'b', target: 'c', confidence: 'INFERRED' },
        ],
      };
      // Pad to exceed 1KB placeholder threshold
      const graphData = JSON.stringify(graphObj) + ' '.repeat(1100);
      writeFileSync(join(tmpDir, 'graphify-out', 'graph.json'), graphData);
      const reportContent = '3 nodes · 2 edges · 2 communities detected\nExtraction: 50% EXTRACTED · 50% INFERRED · 0% AMBIGUOUS';
      writeFileSync(join(tmpDir, 'graphify-out', 'GRAPH_REPORT.md'), reportContent);

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === 'which rtk') throw new Error('not found');
        if (cmd === 'which jcodemunch') throw new Error('not found');
        if (cmd === 'which graphify') return '/usr/bin/graphify';
        if (cmd === 'git branch --show-current') return 'feat/test';
        if (cmd.includes('GRAPH_REPORT.md')) return reportContent;
        return '';
      });

      const output = await handleSessionStart(tmpDir, cache);
      expect(output).toContain('graphify: available');
      expect(output).toContain('3 nodes');
      expect(output).toContain('2 edges');
      expect(output).toContain('2 communities');
      expect(output).toContain('50% EXTRACTED');
      rmSync(tmpDir, { recursive: true });
    });

    it('omits graphify line when graphify not installed', async () => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === 'which rtk') throw new Error('not found');
        if (cmd === 'which jcodemunch') throw new Error('not found');
        if (cmd === 'which graphify' || cmd === 'which graphifyy') throw new Error('not found');
        if (cmd === 'git branch --show-current') return 'feat/test';
        return '';
      });

      const output = await handleSessionStart('/home/user/test-project', cache);
      expect(output).toContain('graphify: not found');
      expect(output).not.toContain('nodes');
    });

    it('emits graphify MCP tools in delegation instructions when available', async () => {
      const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
      const { join } = await import('node:path');
      const tmpDir = '/tmp/rig-test-graphify-deleg-' + process.pid;
      mkdirSync(join(tmpDir, 'graphify-out'), { recursive: true });
      writeFileSync(join(tmpDir, 'graphify-out', 'graph.json'), JSON.stringify({
        nodes: [{ id: 'a' }],
        links: [],
      }) + ' '.repeat(1100));

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === 'which rtk') throw new Error('not found');
        if (cmd === 'which jcodemunch') throw new Error('not found');
        if (cmd === 'which graphify') return '/usr/bin/graphify';
        if (cmd === 'git branch --show-current') return 'feat/test';
        return '';
      });

      const output = await handleSessionStart(tmpDir, cache);
      expect(output).toContain('mcp__graphify__query_graph');
      expect(output).toContain('mcp__graphify__god_nodes');
      expect(output).toContain('mcp__graphify__get_community');
      expect(output).toContain('mcp__graphify__shortest_path');
      rmSync(tmpDir, { recursive: true });
    });

    it('emits graphify hint when not installed', async () => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === 'which rtk') throw new Error('not found');
        if (cmd === 'which jcodemunch') throw new Error('not found');
        if (cmd === 'which graphify' || cmd === 'which graphifyy') throw new Error('not found');
        if (cmd === 'git branch --show-current') return 'feat/test';
        return '';
      });

      const output = await handleSessionStart('/home/user/test-project', cache);
      expect(output).toContain('HINT');
      expect(output).toContain('graphify');
    });

    it('stores graphify stats in session cache', async () => {
      const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
      const { join } = await import('node:path');
      const tmpDir = '/tmp/rig-test-graphify-cache-' + process.pid;
      mkdirSync(join(tmpDir, 'graphify-out'), { recursive: true });
      const graphObj = {
        nodes: [{ id: 'a', community: 0 }, { id: 'b', community: 0 }],
        links: [{ source: 'a', target: 'b', confidence: 'EXTRACTED' }],
      };
      const graphData = JSON.stringify(graphObj) + ' '.repeat(1100);
      writeFileSync(join(tmpDir, 'graphify-out', 'graph.json'), graphData);
      const reportContent = '2 nodes · 1 edges · 1 communities detected\nExtraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS';
      writeFileSync(join(tmpDir, 'graphify-out', 'GRAPH_REPORT.md'), reportContent);

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === 'which rtk') throw new Error('not found');
        if (cmd === 'which jcodemunch') throw new Error('not found');
        if (cmd === 'which graphify') return '/usr/bin/graphify';
        if (cmd === 'git branch --show-current') return 'feat/test';
        if (cmd.includes('GRAPH_REPORT.md')) return reportContent;
        return '';
      });

      await handleSessionStart(tmpDir, cache);
      const baseline = cache.getMetricsBaseline();
      expect(baseline?.graphifyStats).toBeDefined();
      const entries = Object.entries(baseline!.graphifyStats!);
      expect(entries.length).toBe(1);
      const [, stats] = entries[0];
      expect(stats.nodes).toBe(2);
      expect(stats.edges).toBe(1);
      expect(stats.extractedPct).toBe(100);
      rmSync(tmpDir, { recursive: true });
    });
  });

  describe('baseline preservation', () => {
    it('preserves existing baseline when recapture yields zero', async () => {
      // Pre-populate cache with a valid baseline
      cache.setMetricsBaseline({ totalSaved: 5000000, capturedAt: Date.now() - 1000 });

      // Simulate rtk being temporarily unavailable on restart
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === 'which rtk') throw new Error('not found');
        if (cmd === 'which jcodemunch') throw new Error('not found');
        if (cmd === 'which graphify') throw new Error('not found');
        if (cmd === 'git branch --show-current') return 'feat/test';
        if (cmd === 'rtk gain --format json') throw new Error('not found');
        return '';
      });

      await handleSessionStart('/home/user/test-project', cache);
      const baseline = cache.getMetricsBaseline();
      expect(baseline).toBeDefined();
      expect(baseline!.totalSaved).toBe(5000000);
    });

    it('preserves existing graphify stats when recapture yields zero baseline', async () => {
      // Pre-populate cache with baseline including graphify stats
      cache.setMetricsBaseline({
        totalSaved: 5000000,
        capturedAt: Date.now() - 1000,
        graphifyStats: { '/home/user/test-project': { nodes: 100, edges: 200, communities: 5, extractedPct: 90, inferredPct: 10, ambiguousPct: 0 } },
      });

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === 'which rtk') throw new Error('not found');
        if (cmd === 'which jcodemunch') throw new Error('not found');
        if (cmd === 'which graphify') throw new Error('not found');
        if (cmd === 'git branch --show-current') return 'feat/test';
        if (cmd === 'rtk gain --format json') throw new Error('not found');
        return '';
      });

      await handleSessionStart('/home/user/test-project', cache);
      const baseline = cache.getMetricsBaseline();
      expect(baseline?.graphifyStats).toBeDefined();
      const entries = Object.entries(baseline!.graphifyStats!);
      expect(entries.length).toBe(1);
      expect(entries[0][1].nodes).toBe(100);
    });

    it('uses new baseline when recapture succeeds', async () => {
      cache.setMetricsBaseline({ totalSaved: 5000000, capturedAt: Date.now() - 1000 });

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === 'which rtk') return '/usr/bin/rtk';
        if (cmd === 'which jcodemunch') throw new Error('not found');
        if (cmd === 'git branch --show-current') return 'feat/test';
        if (cmd === 'rtk gain --format json') return JSON.stringify({ summary: { total_saved: 6000000 } });
        return '';
      });

      await handleSessionStart('/home/user/test-project', cache);
      const baseline = cache.getMetricsBaseline();
      expect(baseline!.totalSaved).toBe(6000000);
    });
  });

  describe('jcodemunch file cap warning', () => {
    it('warns when auto-index hits file limit', async () => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === 'which rtk') return '/usr/bin/rtk';
        if (cmd === 'which jcodemunch') return '/usr/bin/jcodemunch';
        if (cmd.includes('list_repos')) return '{"repos":[]}';
        if (cmd.includes('index_folder')) {
          return JSON.stringify({
            success: true,
            repo: 'local/big-project',
            file_count: 2000,
            discovery_skip_counts: { file_limit: 4032 },
          });
        }
        return '';
      });

      const output = await handleSessionStart('/home/user/big-project', cache);
      expect(output).toContain('WARNING');
      expect(output).toContain('file limit');
      expect(output).toContain('max_folder_files');
      expect(output).toContain('config.jsonc');
    });

    it('does not warn when no files were skipped', async () => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === 'which rtk') return '/usr/bin/rtk';
        if (cmd === 'which jcodemunch') return '/usr/bin/jcodemunch';
        if (cmd.includes('list_repos')) return '{"repos":[]}';
        if (cmd.includes('index_folder')) {
          return JSON.stringify({
            success: true,
            repo: 'local/small-project',
            file_count: 50,
            discovery_skip_counts: { file_limit: 0 },
          });
        }
        return '';
      });

      const output = await handleSessionStart('/home/user/small-project', cache);
      expect(output).not.toContain('file limit');
    });
  });

  describe('transport reuse and output states', () => {
    const WHEEL_URL =
      'https://github.com/jgravelle/jcodemunch-mcp/releases/download/v1.108.20/jcodemunch_mcp-1.108.20-py3-none-any.whl';
    const wheelRegistration = {
      command: 'uvx',
      args: ['--from', WHEEL_URL, 'jcodemunch-mcp'],
      source: 'user' as const,
    };

    const noBinariesExec: ExecFn = (cmd: string) => {
      if (cmd === 'which uvx') return '/opt/homebrew/bin/uvx';
      throw new Error(`not found: ${cmd}`);
    };

    function listReposResponse(
      repos: Array<{ repo: string; source_root?: string }>,
      protocolVersion = '2025-03-26',
    ): string {
      const init = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion } });
      const tool = JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: { content: [{ type: 'text', text: JSON.stringify({ repos }) }], isError: false },
      });
      return init + '\n' + tool;
    }

    function toolCallResponse(payload: object): string {
      const init = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } });
      const tool = JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
      });
      return init + '\n' + tool;
    }

    it('detectAndIndex reuses the config transport verbatim for MCP auto-index', async () => {
      const indexCalls: Array<{ command: string; args: string[] }> = [];
      const mcpQuery: McpQueryFn = async (command, args, messages) => {
        if (messages.some(m => m.includes('index_folder'))) {
          indexCalls.push({ command, args });
          return toolCallResponse({ success: true, repo: 'org/proj' });
        }
        if (command === 'uvx' && args.includes(WHEEL_URL)) {
          return listReposResponse([]);
        }
        return null;
      };

      const { env, autoIndex } = await detectAndIndex(
        '/work/proj', noBinariesExec, () => false, () => undefined, mcpQuery, () => wheelRegistration,
      );

      expect(autoIndex).toBe('succeeded');
      expect(env.jcodemunchCwdIndexed).toBe(true);
      expect(env.jcodemunchCwdRepo).toBe('org/proj');
      expect(indexCalls[0]).toEqual({
        command: 'uvx',
        args: ['--from', WHEEL_URL, 'jcodemunch-mcp'],
      });
    });

    it('detectAndIndex reports failed when the index attempt yields nothing', async () => {
      const mcpQuery: McpQueryFn = async (command, args, messages) => {
        if (messages.some(m => m.includes('index_folder'))) return null;
        if (command === 'uvx' && args.includes(WHEEL_URL)) return listReposResponse([]);
        return null;
      };

      const { autoIndex } = await detectAndIndex(
        '/work/proj', noBinariesExec, () => false, () => undefined, mcpQuery, () => wheelRegistration,
      );

      expect(autoIndex).toBe('failed');
    });

    it('detectAndIndex reports not_needed when CWD is already indexed', async () => {
      const mcpQuery: McpQueryFn = async (command, args) => {
        if (command === 'uvx' && args.includes(WHEEL_URL)) {
          return listReposResponse([{ repo: 'org/proj', source_root: '/work/proj' }]);
        }
        return null;
      };

      const { autoIndex, env } = await detectAndIndex(
        '/work/proj', noBinariesExec, () => false, () => undefined, mcpQuery, () => wheelRegistration,
      );

      expect(env.jcodemunchCwdIndexed).toBe(true);
      expect(autoIndex).toBe('not_needed');
    });

    it('detectAndIndex routes CLI auto-index through the injectable exec', async () => {
      const seen: string[] = [];
      const exec: ExecFn = (cmd: string) => {
        seen.push(cmd);
        if (cmd === 'which jcodemunch') return '/usr/bin/jcodemunch';
        if (cmd.includes('list_repos')) return '{"repos":[]}';
        if (cmd.includes('index_folder')) return JSON.stringify({ success: true, repo: 'local/proj' });
        throw new Error(`not found: ${cmd}`);
      };

      const { autoIndex } = await detectAndIndex(
        '/work/proj', exec, () => false, () => undefined, async () => null, () => null,
      );

      expect(autoIndex).toBe('succeeded');
      expect(seen.some(c => c.includes('index_folder'))).toBe(true);
    });

    it('renders cli transport and indexed state', async () => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === 'which rtk') return '/usr/bin/rtk';
        if (cmd === 'which jcodemunch') return '/usr/bin/jcodemunch';
        if (cmd.includes('list_repos')) return '{"repos":["local/test-project"]}';
        return '';
      });

      const output = await handleSessionStart('/home/user/test-project', cache);
      expect(output).toContain('jcodemunch: available (cli)');
      expect(output).toContain('CWD indexed: local/test-project');
    });

    it('renders auto-index failure guidance when indexing fails', async () => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === 'which rtk') throw new Error('not found');
        if (cmd === 'which jcodemunch') return '/usr/bin/jcodemunch';
        if (cmd.includes('list_repos')) return '{"repos":[]}';
        if (cmd.includes('index_folder')) throw new Error('index failed');
        return '';
      });

      const output = await handleSessionStart('/home/user/test-project', cache);
      expect(output).toContain('CWD not indexed (auto-index failed');
      expect(output).toContain('mcp__jcodemunch__index_folder');
    });

    it('renders config transport detail and protocol mismatch warning', async () => {
      vi.mocked(execSync).mockImplementation(() => '');
      const mcpQuery: McpQueryFn = async (command, args) => {
        if (command === 'uvx' && args.includes(WHEEL_URL)) {
          return listReposResponse([{ repo: 'org/proj', source_root: '/work/proj' }], '2024-11-05');
        }
        return null;
      };

      const output = await handleSessionStart('/work/proj', cache, {
        exec: noBinariesExec,
        existsCheck: () => false,
        statCheck: () => undefined,
        mcpQuery,
        registrationLookup: () => wheelRegistration,
        readdir: () => { throw new Error('no dir'); },
      });

      expect(output).toContain('available (mcp via user config: uvx --from');
      expect(output).toContain('[WARNING] jcodemunch MCP protocol version mismatch');
      expect(output).toContain('2024-11-05');
    });

    it('not-installed warning mentions checking the MCP registration', async () => {
      vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });

      const output = await handleSessionStart('/home/user/test-project', cache, {
        exec: () => { throw new Error('not found'); },
        existsCheck: () => false,
        statCheck: () => undefined,
        mcpQuery: async () => null,
        registrationLookup: () => null,
        readdir: () => { throw new Error('no dir'); },
      });

      expect(output).toContain('jcodemunch: not found');
      expect(output).toContain('claude mcp list');
    });

    it('warns about orphaned index data when detection fails but ~/.code-index has dbs', async () => {
      vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });

      const output = await handleSessionStart('/home/user/test-project', cache, {
        exec: () => { throw new Error('not found'); },
        existsCheck: () => false,
        statCheck: () => undefined,
        mcpQuery: async () => null,
        registrationLookup: () => null,
        readdir: () => ['franklywatson-claude-rig.db', 'config.jsonc'],
        homeDir: '/home/user',
      });

      expect(output).toContain('index data found at ~/.code-index');
      expect(output).toContain('claude mcp list');
    });

    it('warns when graphify version is outside the tested range', async () => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === 'which rtk') throw new Error('not found');
        if (cmd === 'which jcodemunch') return '/usr/bin/jcodemunch';
        if (cmd.includes('list_repos')) return '{"repos":["local/test-project"]}';
        if (cmd === 'which graphify') return '/usr/local/bin/graphify';
        if (cmd === 'graphify --version') return 'graphify 0.6.2';
        return '';
      });

      const output = await handleSessionStart('/home/user/test-project', cache);
      expect(output).toContain('graphify 0.6.2 is outside the tested range');
    });

    it('does not warn when graphify version is inside the tested range', async () => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === 'which rtk') throw new Error('not found');
        if (cmd === 'which jcodemunch') return '/usr/bin/jcodemunch';
        if (cmd.includes('list_repos')) return '{"repos":["local/test-project"]}';
        if (cmd === 'which graphify') return '/usr/local/bin/graphify';
        if (cmd === 'graphify --version') return 'graphify 0.7.18';
        return '';
      });

      const output = await handleSessionStart('/home/user/test-project', cache);
      expect(output).not.toContain('outside the tested range');
    });

    it('does not warn about orphaned index data when ~/.code-index is absent', async () => {
      vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });

      const output = await handleSessionStart('/home/user/test-project', cache, {
        exec: () => { throw new Error('not found'); },
        existsCheck: () => false,
        statCheck: () => undefined,
        mcpQuery: async () => null,
        registrationLookup: () => null,
        readdir: () => { throw new Error('ENOENT'); },
        homeDir: '/home/user',
      });

      expect(output).not.toContain('index data found');
    });
  });
});

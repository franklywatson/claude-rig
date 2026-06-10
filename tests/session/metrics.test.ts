import { describe, it, expect, vi } from 'vitest';
import {
  captureMetricsBaseline,
  captureGraphifyStats,
  captureGraphifyStatsViaReport,
  captureExternalGraphifyStats,
  incrementMetric,
  formatSavingsReport,
  resolveGraphifyStats,
} from '../../src/session/metrics.js';
import type { MetricsBaseline, GraphifyProjectStats } from '../../src/types.js';
import { SessionCache } from '../../src/session/cache.js';

function makeExec(results: Record<string, string | Error>) {
  return (cmd: string): string => {
    const result = results[cmd];
    if (result instanceof Error) throw result;
    return result;
  };
}

describe('captureMetricsBaseline', () => {
  it('parses rtk gain JSON output', () => {
    const exec = makeExec({
      'rtk gain --format json': JSON.stringify({ summary: { total_saved: 5000000 } }),
    });
    const baseline = captureMetricsBaseline(exec);
    expect(baseline).toEqual({ totalSaved: 5000000, capturedAt: expect.any(Number) });
  });

  it('returns zero baseline when rtk not available', () => {
    const exec = makeExec({
      'rtk gain --format json': new Error('not found'),
    });
    const baseline = captureMetricsBaseline(exec);
    expect(baseline).toEqual({ totalSaved: 0, capturedAt: expect.any(Number) });
  });

  it('returns zero baseline when JSON is malformed', () => {
    const exec = makeExec({
      'rtk gain --format json': 'not json',
    });
    const baseline = captureMetricsBaseline(exec);
    expect(baseline).toEqual({ totalSaved: 0, capturedAt: expect.any(Number) });
  });

  it.each([
    ['missing total_saved', JSON.stringify({ summary: {} })],
    ['string total_saved', JSON.stringify({ summary: { total_saved: '5000' } })],
    ['array payload', JSON.stringify([1, 2])],
    ['malformed JSON', 'not json'],
  ])('warns on unexpected schema (%s) and returns zero', (_label, raw) => {
    const onWarn = vi.fn();
    const exec = makeExec({ 'rtk gain --format json': raw });

    const baseline = captureMetricsBaseline(exec, onWarn);
    expect(baseline.totalSaved).toBe(0);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('unexpected schema'));
  });

  it('does not warn on a valid payload', () => {
    const onWarn = vi.fn();
    const exec = makeExec({
      'rtk gain --format json': JSON.stringify({ summary: { total_saved: 42 } }),
    });

    expect(captureMetricsBaseline(exec, onWarn).totalSaved).toBe(42);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('does not warn when rtk itself is absent (exec throws)', () => {
    const onWarn = vi.fn();
    const exec = makeExec({ 'rtk gain --format json': new Error('not found') });

    expect(captureMetricsBaseline(exec, onWarn).totalSaved).toBe(0);
    expect(onWarn).not.toHaveBeenCalled();
  });
});

describe('stats-capture exec timeouts', () => {
  const REPORT_TEXT =
    '40994 nodes · 129501 edges · 439 communities detected\nExtraction: 42% EXTRACTED · 58% INFERRED · 0% AMBIGUOUS';

  it('passes a 10s timeout to the GRAPH_REPORT.md read', () => {
    const exec = vi.fn((cmd: string) => {
      if (cmd.includes('GRAPH_REPORT.md')) return REPORT_TEXT;
      throw new Error(`unexpected: ${cmd}`);
    });

    captureGraphifyStatsViaReport('/proj', exec);
    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining('GRAPH_REPORT.md'),
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it('passes a 30s timeout to the graphify benchmark fallback', () => {
    const exec = vi.fn((cmd: string) => {
      if (cmd.includes('GRAPH_REPORT.md')) throw new Error('no report');
      if (cmd.includes('graphify benchmark')) return 'Graph: 1,000 nodes, 2,000 edges';
      throw new Error(`unexpected: ${cmd}`);
    });

    captureGraphifyStatsViaReport('/proj', exec);
    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining('graphify benchmark'),
      expect.objectContaining({ timeout: 30_000 }),
    );
  });

  it('passes a 120s timeout to the external graph build', () => {
    const exec = vi.fn((cmd: string) => {
      if (cmd.startsWith('test -f')) throw new Error('absent');
      if (cmd.includes('graphify update')) return '';
      if (cmd.includes('GRAPH_REPORT.md')) return REPORT_TEXT;
      throw new Error(`unexpected: ${cmd}`);
    });

    captureExternalGraphifyStats('/ext/proj', exec);
    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining('graphify update'),
      expect.objectContaining({ timeout: 120_000 }),
    );
  });

  it('passes a 10s timeout to rtk gain', () => {
    const exec = vi.fn(() => JSON.stringify({ summary: { total_saved: 1 } }));

    captureMetricsBaseline(exec);
    expect(exec).toHaveBeenCalledWith(
      'rtk gain --format json',
      expect.objectContaining({ timeout: 10_000 }),
    );
  });
});

describe('captureGraphifyStatsViaReport warnings', () => {
  const HEALTHY_REPORT =
    '40994 nodes · 129501 edges · 439 communities detected\nExtraction: 42% EXTRACTED · 58% INFERRED · 0% AMBIGUOUS';

  it('emits no warnings for a healthy report', () => {
    const onWarn = vi.fn();
    const exec = vi.fn((cmd: string) => {
      if (cmd.includes('GRAPH_REPORT.md')) return HEALTHY_REPORT;
      throw new Error(`unexpected: ${cmd}`);
    });

    const stats = captureGraphifyStatsViaReport('/proj', exec, onWarn);
    expect(stats?.nodes).toBe(40994);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('warns when the report is present but unparseable, then tries the benchmark', () => {
    const onWarn = vi.fn();
    const exec = vi.fn((cmd: string) => {
      if (cmd.includes('GRAPH_REPORT.md')) return 'TOTALLY NEW REPORT FORMAT';
      if (cmd.includes('graphify benchmark')) return 'Graph: 1,000 nodes, 2,000 edges';
      throw new Error(`unexpected: ${cmd}`);
    });

    const stats = captureGraphifyStatsViaReport('/proj', exec, onWarn);
    expect(stats?.nodes).toBe(1000);
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('unparseable'));
  });

  it('warns when the benchmark fallback is used (confidence breakdown lost)', () => {
    const onWarn = vi.fn();
    const exec = vi.fn((cmd: string) => {
      if (cmd.includes('GRAPH_REPORT.md')) throw new Error('no report');
      if (cmd.includes('graphify benchmark')) return 'Graph: 1,000 nodes, 2,000 edges';
      throw new Error(`unexpected: ${cmd}`);
    });

    const stats = captureGraphifyStatsViaReport('/proj', exec, onWarn);
    expect(stats?.nodes).toBe(1000);
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('benchmark fallback'));
  });

  it('warns when confidence percentages do not sum to ~100 but still returns stats', () => {
    const onWarn = vi.fn();
    const exec = vi.fn((cmd: string) => {
      if (cmd.includes('GRAPH_REPORT.md')) {
        return '10 nodes · 20 edges · 3 communities detected\nExtraction: 40% EXTRACTED · 40% INFERRED · 10% AMBIGUOUS';
      }
      throw new Error(`unexpected: ${cmd}`);
    });

    const stats = captureGraphifyStatsViaReport('/proj', exec, onWarn);
    expect(stats).not.toBeNull();
    expect(stats?.extractedPct).toBe(40);
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('sum to 90'));
  });

  it('accepts rounding slack in the percentage sum (98-102)', () => {
    const onWarn = vi.fn();
    const exec = vi.fn((cmd: string) => {
      if (cmd.includes('GRAPH_REPORT.md')) {
        return '10 nodes · 20 edges · 3 communities detected\nExtraction: 33% EXTRACTED · 33% INFERRED · 33% AMBIGUOUS';
      }
      throw new Error(`unexpected: ${cmd}`);
    });

    captureGraphifyStatsViaReport('/proj', exec, onWarn);
    expect(onWarn).not.toHaveBeenCalled();
  });
});

describe('incrementMetric', () => {
  it('detects rtk usage from Bash tool with rtk command', () => {
    const result = incrementMetric('Bash', { command: 'rtk git status' });
    expect(result).toBe('rtkCalls');
  });

  it('detects rtk usage from Bash tool with rtk in piped command', () => {
    const result = incrementMetric('Bash', { command: 'something | rtk gain --format json' });
    expect(result).toBe('rtkCalls');
  });

  it('detects jcodemunch usage from MCP tool name', () => {
    const result = incrementMetric('mcp__jcodemunch__search_symbols', { query: 'test' });
    expect(result).toBe('jmCalls');
  });

  it('returns null for unrelated tools', () => {
    const result = incrementMetric('Edit', { file_path: '/some/file.txt' });
    expect(result).toBeNull();
  });

  it('returns null for Bash without rtk', () => {
    const result = incrementMetric('Bash', { command: 'ls -la' });
    expect(result).toBeNull();
  });

  it('detects efficient Read on code files', () => {
    const result = incrementMetric('Read', { file_path: '/src/router/resolver.ts' });
    expect(result).toBe('efficientCalls');
  });

  it('detects efficient Grep on code patterns', () => {
    const result = incrementMetric('Grep', { pattern: 'classifyIntent' });
    expect(result).toBe('efficientCalls');
  });

  it('detects efficient Glob on code patterns', () => {
    const result = incrementMetric('Glob', { pattern: '**/*.test.ts' });
    expect(result).toBe('efficientCalls');
  });

  it('returns null for Read on non-code files', () => {
    const result = incrementMetric('Read', { file_path: '/package.json' });
    expect(result).toBeNull();
  });

  it('detects graphify usage from MCP tool name', () => {
    const result = incrementMetric('mcp__graphify__query_graph', { query: 'find cycles' });
    expect(result).toBe('graphifyCalls');
  });

  it('detects graphify usage from any mcp__graphify__ prefix', () => {
    const result = incrementMetric('mcp__graphify__get_stats', {});
    expect(result).toBe('graphifyCalls');
  });
});

describe('formatSavingsReport', () => {
  it('formats report with token delta, call counts, and jcodemunch stats', () => {
    const baseline: MetricsBaseline = { totalSaved: 5000000, capturedAt: Date.now() - 3600000 };
    const currentSaved = 5340000;
    const counters = { rtkCalls: 42, jmCalls: 0, efficientCalls: 0, graphifyCalls: 0 };
    const jmStats = { session_tokens_saved: 85000, session_calls: 23, total_tokens_saved: 150000000 };

    const report = formatSavingsReport(baseline, currentSaved, counters, jmStats);
    expect(report).toContain('[rig] Session Savings');
    expect(report).toContain('rtk:');
    expect(report).toContain('340K');
    expect(report).toContain('42 calls');
    expect(report).toContain('jcodemunch:');
    expect(report).toContain('85K saved');
    expect(report).toContain('23 queries');
    expect(report).toContain('150.0M total all-time');
  });

  it('shows no savings when delta is zero', () => {
    const baseline: MetricsBaseline = { totalSaved: 1000, capturedAt: Date.now() };
    const report = formatSavingsReport(baseline, 1000, { rtkCalls: 0, jmCalls: 0, efficientCalls: 0, graphifyCalls: 0 });
    expect(report).toContain('no token savings');
  });

  it('shows jcodemunch available with no queries', () => {
    const baseline: MetricsBaseline = { totalSaved: 1000, capturedAt: Date.now() };
    const jmStats = { session_tokens_saved: 0, session_calls: 0 };
    const report = formatSavingsReport(baseline, 1000, { rtkCalls: 0, jmCalls: 0, efficientCalls: 0, graphifyCalls: 0 }, jmStats);
    expect(report).toContain('jcodemunch');
    expect(report).toContain('no queries this session');
  });

  it('omits jcodemunch line when stats not provided', () => {
    const baseline: MetricsBaseline = { totalSaved: 1000, capturedAt: Date.now() };
    const report = formatSavingsReport(baseline, 1000, { rtkCalls: 0, jmCalls: 0, efficientCalls: 0, graphifyCalls: 0 });
    expect(report).not.toContain('jcodemunch');
  });

  it('omits jcodemunch line when stats are null', () => {
    const baseline: MetricsBaseline = { totalSaved: 1000, capturedAt: Date.now() };
    const report = formatSavingsReport(baseline, 1000, { rtkCalls: 0, jmCalls: 0, efficientCalls: 0, graphifyCalls: 0 }, null);
    expect(report).not.toContain('jcodemunch');
  });

  it('includes graphify stats line when stats are provided', () => {
    const baseline: MetricsBaseline = { totalSaved: 1000, capturedAt: Date.now() };
    const graphifyStats = {
      '/home/user/project': {
        nodes: 450,
        edges: 1200,
        communities: 8,
        extractedPct: 92,
        inferredPct: 6,
        ambiguousPct: 2,
      },
    };
    const report = formatSavingsReport(
      baseline,
      1000,
      { rtkCalls: 0, jmCalls: 0, efficientCalls: 0, graphifyCalls: 5 },
      undefined,
      graphifyStats,
    );
    expect(report).toContain('graphify:');
    expect(report).toContain('450 nodes');
    expect(report).toContain('1200 edges');
    expect(report).toContain('8 communities');
    expect(report).toContain('92% EXTRACTED');
    expect(report).toContain('6% INFERRED');
    expect(report).toContain('2% AMBIGUOUS');
    expect(report).toContain('5 queries');
  });

  it('omits graphify line when stats are null', () => {
    const baseline: MetricsBaseline = { totalSaved: 1000, capturedAt: Date.now() };
    const report = formatSavingsReport(
      baseline,
      1000,
      { rtkCalls: 0, jmCalls: 0, efficientCalls: 0, graphifyCalls: 0 },
      undefined,
      null,
    );
    expect(report).not.toContain('graphify');
  });

  it('omits graphify line when stats are undefined', () => {
    const baseline: MetricsBaseline = { totalSaved: 1000, capturedAt: Date.now() };
    const report = formatSavingsReport(
      baseline,
      1000,
      { rtkCalls: 0, jmCalls: 0, efficientCalls: 0, graphifyCalls: 0 },
    );
    expect(report).not.toContain('graphify');
  });

  it('falls back to all-time format when baseline is null', () => {
    const report = formatSavingsReport(
      null,
      5955925,
      { rtkCalls: 13, jmCalls: 0, efficientCalls: 0, graphifyCalls: 0 },
    );
    expect(report).toContain('[rig] Session Savings (all-time)');
    expect(report).toContain('rtk:');
    expect(report).toContain('6.0M saved');
    expect(report).toContain('all-time');
  });

  it('falls back to all-time format when baseline is undefined', () => {
    const report = formatSavingsReport(
      undefined,
      5955925,
      { rtkCalls: 13, jmCalls: 0, efficientCalls: 0, graphifyCalls: 0 },
    );
    expect(report).toContain('[rig] Session Savings (all-time)');
    expect(report).toContain('rtk:');
  });

  it('shows jcodemunch all-time stats when baseline is null and no session calls', () => {
    const jmStats = { session_tokens_saved: 0, session_calls: 0, total_tokens_saved: 181819680 };
    const report = formatSavingsReport(
      null,
      5955925,
      { rtkCalls: 13, jmCalls: 0, efficientCalls: 0, graphifyCalls: 0 },
      jmStats,
    );
    expect(report).toContain('jcodemunch:');
    expect(report).toContain('181.8M saved all-time');
    expect(report).toContain('no queries this session');
  });

  it('shows graphify stats in all-time format', () => {
    const graphifyStats = {
      '/home/user/project': {
        nodes: 261,
        edges: 460,
        communities: 21,
        extractedPct: 90,
        inferredPct: 10,
        ambiguousPct: 0,
      },
    };
    const report = formatSavingsReport(
      null,
      5955925,
      { rtkCalls: 13, jmCalls: 0, efficientCalls: 0, graphifyCalls: 0 },
      undefined,
      graphifyStats,
    );
    expect(report).toContain('graphify:');
    expect(report).toContain('261 nodes');
    expect(report).toContain('460 edges');
    expect(report).toContain('21 communities');
    expect(report).toContain('90% EXTRACTED');
  });

  it('shows all tools in all-time format', () => {
    const jmStats = { session_tokens_saved: 0, session_calls: 0, total_tokens_saved: 50000000 };
    const graphifyStats = {
      '/home/user/project': {
        nodes: 100,
        edges: 200,
        communities: 5,
        extractedPct: 80,
        inferredPct: 20,
        ambiguousPct: 0,
      },
    };
    const report = formatSavingsReport(
      null,
      5955925,
      { rtkCalls: 13, jmCalls: 0, efficientCalls: 14, graphifyCalls: 3 },
      jmStats,
      graphifyStats,
    );
    expect(report).toContain('[rig] Session Savings (all-time)');
    expect(report).toContain('rtk:');
    expect(report).toContain('jcodemunch:');
    expect(report).toContain('graphify:');
    expect(report).toContain('efficient tools:');
  });

  it('handles null baseline with zero rtk savings', () => {
    const report = formatSavingsReport(
      null,
      0,
      { rtkCalls: 0, jmCalls: 0, efficientCalls: 0, graphifyCalls: 0 },
    );
    expect(report).toContain('[rig] Session Savings (all-time)');
    expect(report).toContain('rtk: no data');
  });
});

describe('captureGraphifyStats', () => {
  it('returns null when graph.json not available (exec throws)', () => {
    const exec = makeExec({
      'cat "/project/graphify-out/graph.json"': new Error('no such file'),
    });
    const result = captureGraphifyStats('/project', exec);
    expect(result).toBeNull();
  });

  it('parses valid graph.json into correct shape', () => {
    const graphData = {
      nodes: [
        { id: 'n1', label: 'ModuleA', community: 1 },
        { id: 'n2', label: 'ModuleB', community: 1 },
        { id: 'n3', label: 'ModuleC', community: 2 },
      ],
      links: [
        { source: 'n1', target: 'n2', relation: 'imports', confidence: 'EXTRACTED' },
        { source: 'n1', target: 'n3', relation: 'calls', confidence: 'INFERRED' },
        { source: 'n2', target: 'n3', relation: 'uses', confidence: 'AMBIGUOUS' },
      ],
    };
    const exec = makeExec({
      'cat "/project/graphify-out/graph.json"': JSON.stringify(graphData),
    });
    const result = captureGraphifyStats('/project', exec);
    expect(result).toEqual({
      nodes: 3,
      edges: 3,
      communities: 2,
      extractedPct: 33,
      inferredPct: 33,
      ambiguousPct: 33,
    });
  });

  it('handles malformed JSON gracefully (returns null)', () => {
    const exec = makeExec({
      'cat "/project/graphify-out/graph.json"': 'not valid json {{{',
    });
    const result = captureGraphifyStats('/project', exec);
    expect(result).toBeNull();
  });

  it('handles empty graph (zero nodes and edges)', () => {
    const graphData = { nodes: [], links: [] };
    const exec = makeExec({
      'cat "/project/graphify-out/graph.json"': JSON.stringify(graphData),
    });
    const result = captureGraphifyStats('/project', exec);
    expect(result).toEqual({
      nodes: 0,
      edges: 0,
      communities: 0,
      extractedPct: 0,
      inferredPct: 0,
      ambiguousPct: 0,
    });
  });

  it('treats links without confidence as EXTRACTED', () => {
    const graphData = {
      nodes: [{ id: 'n1' }, { id: 'n2' }],
      links: [{ source: 'n1', target: 'n2' }],
    };
    const exec = makeExec({
      'cat "/project/graphify-out/graph.json"': JSON.stringify(graphData),
    });
    const result = captureGraphifyStats('/project', exec);
    expect(result).toEqual({
      nodes: 2,
      edges: 1,
      communities: 0,
      extractedPct: 100,
      inferredPct: 0,
      ambiguousPct: 0,
    });
  });
});

describe('captureGraphifyStatsViaReport', () => {
  it('parses GRAPH_REPORT.md summary for stats', () => {
    const report = [
      '# Graph Report - /project',
      '',
      '## Summary',
      '- 40994 nodes · 129501 edges · 439 communities detected',
      '- Extraction: 42% EXTRACTED · 58% INFERRED · 0% AMBIGUOUS · INFERRED: 74743 edges (avg confidence: 0.65)',
    ].join('\n');
    const exec = (cmd: string) => {
      if (cmd.includes('GRAPH_REPORT.md')) return report;
      throw new Error('unexpected');
    };

    const result = captureGraphifyStatsViaReport('/project', exec);
    expect(result).toEqual({
      nodes: 40994,
      edges: 129501,
      communities: 439,
      extractedPct: 42,
      inferredPct: 58,
      ambiguousPct: 0,
    });
  });

  it('returns null when report not found', () => {
    const exec = () => { throw new Error('not found'); };
    const result = captureGraphifyStatsViaReport('/project', exec);
    expect(result).toBeNull();
  });

  it('returns null when report does not match expected format', () => {
    const exec = (cmd: string) => {
      if (cmd.includes('GRAPH_REPORT.md')) return '# Some other report\nNo graph data here';
      throw new Error('unexpected');
    };
    const result = captureGraphifyStatsViaReport('/project', exec);
    expect(result).toBeNull();
  });

  it('falls back to benchmark CLI when report unavailable', () => {
    const benchmarkOutput = [
      'graphify token reduction benchmark',
      '──────────────────',
      '  Graph:           40994 nodes, 129501 edges',
      '  Reduction:       2.8x fewer tokens per query',
    ].join('\n');
    const exec = (cmd: string) => {
      if (cmd.includes('GRAPH_REPORT.md')) throw new Error('not found');
      if (cmd.includes('graphify benchmark')) return benchmarkOutput;
      throw new Error(`unexpected: ${cmd}`);
    };

    const result = captureGraphifyStatsViaReport('/project', exec);
    expect(result).toEqual({
      nodes: 40994,
      edges: 129501,
      communities: 0,
      extractedPct: 0,
      inferredPct: 0,
      ambiguousPct: 0,
    });
  });
});

describe('captureExternalGraphifyStats', () => {
  it('triggers graphify build and captures stats for external dir', () => {
    const report = [
      '# Graph Report - /external/meridian',
      '',
      '## Summary',
      '- 420 nodes · 891 edges · 67 communities detected',
      '- Extraction: 91% EXTRACTED · 9% INFERRED · 0% AMBIGUOUS',
    ].join('\n');
    const commands: string[] = [];
    const exec = (cmd: string) => {
      commands.push(cmd);
      if (cmd.includes('test -f') && cmd.includes('graph.json')) throw new Error('not found');
      if (cmd.includes('graphify update')) return '';
      if (cmd.includes('GRAPH_REPORT.md')) return report;
      throw new Error(`unexpected: ${cmd}`);
    };

    const result = captureExternalGraphifyStats('/external/meridian', exec);
    expect(result).toEqual({
      nodes: 420, edges: 891, communities: 67,
      extractedPct: 91, inferredPct: 9, ambiguousPct: 0,
    });
    expect(commands.some(c => c.includes('graphify update'))).toBe(true);
    expect(commands.some(c => c.includes('GRAPH_REPORT.md'))).toBe(true);
  });

  it('skips build when graph already exists', () => {
    const report = [
      '# Graph Report - /external/meridian',
      '',
      '## Summary',
      '- 420 nodes · 891 edges · 67 communities detected',
      '- Extraction: 91% EXTRACTED · 9% INFERRED · 0% AMBIGUOUS',
    ].join('\n');
    const commands: string[] = [];
    const exec = (cmd: string) => {
      commands.push(cmd);
      if (cmd.includes('test -f') && cmd.includes('graph.json')) return ''; // exists check passes
      if (cmd.includes('GRAPH_REPORT.md')) return report;
      if (cmd.includes('graphify update')) return '';
      throw new Error(`unexpected: ${cmd}`);
    };

    const result = captureExternalGraphifyStats('/external/meridian', exec);
    expect(result).not.toBeNull();
    expect(result!.nodes).toBe(420);
    // Should NOT have called graphify update since graph already existed
    expect(commands.some(c => c.includes('graphify update'))).toBe(false);
  });

  it('returns null when graphify build fails', () => {
    const commands: string[] = [];
    const exec = (cmd: string) => {
      commands.push(cmd);
      if (cmd.includes('test -f')) throw new Error('not found');
      if (cmd.includes('graphify update')) throw new Error('build failed');
      throw new Error(`unexpected: ${cmd}`);
    };

    const result = captureExternalGraphifyStats('/external/broken', exec);
    expect(result).toBeNull();
  });

  it('returns null when stats capture fails after build', () => {
    const commands: string[] = [];
    const exec = (cmd: string) => {
      commands.push(cmd);
      if (cmd.includes('test -f')) throw new Error('not found');
      if (cmd.includes('graphify update')) return '';
      if (cmd.includes('GRAPH_REPORT.md')) throw new Error('report not found');
      if (cmd.includes('graphify benchmark')) throw new Error('benchmark failed');
      throw new Error(`unexpected: ${cmd}`);
    };

    const result = captureExternalGraphifyStats('/external/empty', exec);
    expect(result).toBeNull();
  });
});

describe('multi-project graphify round-trip', () => {
  it('session-start + external index + savings report shows both projects', () => {
    const cache = new SessionCache();

    // Simulate session-start capturing CWD stats
    const cwdStats: GraphifyProjectStats = {
      nodes: 287, edges: 385, communities: 52,
      extractedPct: 84, inferredPct: 16, ambiguousPct: 0,
    };
    cache.setMetricsBaseline({
      totalSaved: 5000000,
      capturedAt: Date.now(),
      graphifyStats: { '/home/user/claude-rig': cwdStats },
    });

    // Simulate post-tool-use capturing external dir stats
    const meridianReport = [
      '# Graph Report - /home/user/meridian',
      '',
      '## Summary',
      '- 420 nodes · 891 edges · 67 communities detected',
      '- Extraction: 91% EXTRACTED · 9% INFERRED · 0% AMBIGUOUS',
    ].join('\n');
    const exec = (cmd: string) => {
      if (cmd.includes('test -f')) throw new Error('not found');
      if (cmd.includes('graphify update')) return '';
      if (cmd.includes('GRAPH_REPORT.md')) return meridianReport;
      throw new Error(`unexpected: ${cmd}`);
    };
    const externalStats = captureExternalGraphifyStats('/home/user/meridian', exec);
    expect(externalStats).not.toBeNull();
    cache.setGraphifyStats('/home/user/meridian', externalStats!);

    // Generate savings report — should show both projects
    const allStats = cache.getAllGraphifyStats()!;
    const report = formatSavingsReport(
      cache.getMetricsBaseline()!,
      5340000,
      { rtkCalls: 3, jmCalls: 0, efficientCalls: 0, graphifyCalls: 2 },
      undefined,
      allStats,
    );

    // Both projects appear in multi-project format
    expect(report).toContain('graphify:');
    expect(report).toContain('claude-rig:');
    expect(report).toContain('287 nodes');
    expect(report).toContain('meridian:');
    expect(report).toContain('420 nodes');
  });
});

describe('resolveGraphifyStats', () => {
  it('passes through singleton format unchanged', () => {
    const stats: GraphifyProjectStats = { nodes: 100, edges: 200, communities: 5, extractedPct: 90, inferredPct: 10, ambiguousPct: 0 };
    const record: Record<string, GraphifyProjectStats> = { '/home/user/project': stats };
    const result = resolveGraphifyStats(record, '/home/user/project');
    expect(result).toEqual(stats);
  });

  it('extracts from Record format by cwd key', () => {
    const inner: GraphifyProjectStats = { nodes: 1742, edges: 6236, communities: 42, extractedPct: 88, inferredPct: 12, ambiguousPct: 0 };
    const record: Record<string, GraphifyProjectStats> = { '/home/user/project': inner };
    const result = resolveGraphifyStats(record, '/home/user/project');
    expect(result).toEqual(inner);
  });

  it('returns null when Record has no matching cwd key', () => {
    const record: Record<string, GraphifyProjectStats> = { '/other/project': { nodes: 100, edges: 200, communities: 5, extractedPct: 90, inferredPct: 10, ambiguousPct: 0 } };
    const result = resolveGraphifyStats(record, '/home/user/project');
    expect(result).toBeNull();
  });

  it('returns null when input is null', () => {
    const result = resolveGraphifyStats(null, '/home/user/project');
    expect(result).toBeNull();
  });

  it('returns null when input is undefined', () => {
    const result = resolveGraphifyStats(undefined, '/home/user/project');
    expect(result).toBeNull();
  });
});

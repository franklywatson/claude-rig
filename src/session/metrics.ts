import type { GraphifyProjectStats, MetricsBaseline } from '../types.js';
import { basename } from 'node:path';
import { graphJsonPath, graphReportPath } from '../constants.js';

export type ExecFn = (cmd: string, opts?: { timeout?: number }) => string;

// Hooks must never hang on a stuck child process — every exec is bounded.
const REPORT_TIMEOUT_MS = 10_000;
const BENCHMARK_TIMEOUT_MS = 30_000;
const BUILD_TIMEOUT_MS = 120_000;
const GAIN_TIMEOUT_MS = 10_000;

/**
 * Read graphify-out/graph.json (NetworkX node-link format) and compute stats.
 * Returns null if the file is missing or malformed.
 * @deprecated Use captureGraphifyStatsViaReport instead — avoids reading 74MB files.
 */
export function captureGraphifyStats(cwd: string, exec: ExecFn): GraphifyProjectStats | null {
  try {
    const raw = exec(`cat "${graphJsonPath(cwd)}"`, { timeout: BENCHMARK_TIMEOUT_MS });
    const data = JSON.parse(raw) as { nodes?: unknown[]; links?: unknown[] };
    const nodes = data.nodes ?? [];
    const links = data.links ?? [];
    const communities = new Set<number>(
      nodes
        .map((n: unknown) => (n as Record<string, unknown>)?.community)
        .filter((c): c is number => c != null),
    );
    const confidences = links.map(
      (l: unknown) => ((l as Record<string, unknown>)?.confidence as string) ?? 'EXTRACTED',
    );
    const total = confidences.length || 1;
    return {
      nodes: nodes.length,
      edges: links.length,
      communities: communities.size,
      extractedPct: Math.round((confidences.filter(c => c === 'EXTRACTED').length / total) * 100),
      inferredPct: Math.round((confidences.filter(c => c === 'INFERRED').length / total) * 100),
      ambiguousPct: Math.round((confidences.filter(c => c === 'AMBIGUOUS').length / total) * 100),
    };
  } catch {
    return null;
  }
}

/**
 * Parse graphify-out/GRAPH_REPORT.md for graph stats.
 * Much lighter than reading graph.json (154KB vs 74MB).
 * Falls back to `graphify benchmark` CLI if report unavailable.
 */
export function captureGraphifyStatsViaReport(
  cwd: string,
  exec: ExecFn,
  onWarn?: (msg: string) => void,
): GraphifyProjectStats | null {
  // Try GRAPH_REPORT.md first (has full stats including confidence breakdown)
  try {
    const report = exec(`cat "${graphReportPath(cwd)}"`, { timeout: REPORT_TIMEOUT_MS });

    // Match: "40994 nodes · 129501 edges · 439 communities detected"
    const summaryMatch = report.match(/(\d+)\s+nodes\s*·\s*(\d+)\s+edges\s*·\s*(\d+)\s+communities/);
    // Match: "Extraction: 42% EXTRACTED · 58% INFERRED · 0% AMBIGUOUS"
    const extractionMatch = report.match(/Extraction:\s*(\d+)%\s*EXTRACTED\s*·\s*(\d+)%\s*INFERRED\s*·\s*(\d+)%\s*AMBIGUOUS/);

    if (summaryMatch) {
      const stats: GraphifyProjectStats = {
        nodes: parseInt(summaryMatch[1], 10),
        edges: parseInt(summaryMatch[2], 10),
        communities: parseInt(summaryMatch[3], 10),
        extractedPct: extractionMatch ? parseInt(extractionMatch[1], 10) : 0,
        inferredPct: extractionMatch ? parseInt(extractionMatch[2], 10) : 0,
        ambiguousPct: extractionMatch ? parseInt(extractionMatch[3], 10) : 0,
      };
      if (extractionMatch) {
        const sum = stats.extractedPct + stats.inferredPct + stats.ambiguousPct;
        if (sum < 98 || sum > 102) {
          onWarn?.(`graphify: confidence percentages sum to ${sum} (expected ~100) — report format may have drifted`);
        }
      }
      return stats;
    }
    // Report exists but didn't match the expected layout — format drift
    onWarn?.('graphify: GRAPH_REPORT.md present but unparseable — format may have changed');
  } catch {
    // Report not available — fall through to benchmark
  }

  // Fallback: graphify benchmark CLI (nodes/edges only)
  try {
    const output = exec(`graphify benchmark "${graphJsonPath(cwd)}"`, { timeout: BENCHMARK_TIMEOUT_MS });
    const match = output.match(/Graph:\s*(\d[\d,]*)\s+nodes,\s*(\d[\d,]*)\s+edges/);
    if (match) {
      onWarn?.('graphify: using benchmark fallback — confidence breakdown unavailable');
      return {
        nodes: parseInt(match[1].replace(/,/g, ''), 10),
        edges: parseInt(match[2].replace(/,/g, ''), 10),
        communities: 0,
        extractedPct: 0,
        inferredPct: 0,
        ambiguousPct: 0,
      };
    }
  } catch {
    // benchmark also unavailable
  }

  return null;
}

/**
 * Build graphify graph for an external directory (if not already built)
 * and capture its stats. Returns null if graphify is unavailable or build fails.
 */
export function captureExternalGraphifyStats(
  directory: string,
  exec: ExecFn,
  onWarn?: (msg: string) => void,
): GraphifyProjectStats | null {
  const graphPath = graphJsonPath(directory);

  // Check if graph already exists
  let graphExists = false;
  try {
    exec(`test -f "${graphPath}"`, { timeout: REPORT_TIMEOUT_MS });
    graphExists = true;
  } catch {
    // Graph doesn't exist — trigger build
  }

  if (!graphExists) {
    try {
      exec(`graphify update "${directory}"`, { timeout: BUILD_TIMEOUT_MS });
    } catch {
      return null;
    }
  }

  return captureGraphifyStatsViaReport(directory, exec, onWarn);
}

export function captureMetricsBaseline(
  exec: ExecFn,
  onWarn?: (msg: string) => void,
): MetricsBaseline {
  let raw: string;
  try {
    raw = exec('rtk gain --format json', { timeout: GAIN_TIMEOUT_MS });
  } catch {
    // rtk absent — covered by the session-start not-installed warning
    return { totalSaved: 0, capturedAt: Date.now() };
  }

  try {
    const parsed = JSON.parse(raw);
    const totalSaved = parsed?.summary?.total_saved;
    if (typeof totalSaved === 'number' && Number.isFinite(totalSaved)) {
      return { totalSaved, capturedAt: Date.now() };
    }
  } catch {
    // Fall through — schema warning below
  }
  // rtk ran but the output shape is wrong: format drift, not absence
  onWarn?.("rtk: 'rtk gain --format json' returned an unexpected schema — savings baseline unavailable");
  return { totalSaved: 0, capturedAt: Date.now() };
}

export function incrementMetric(
  toolName: string,
  toolInput: Record<string, unknown>,
): 'rtkCalls' | 'jmCalls' | 'efficientCalls' | 'graphifyCalls' | null {
  if (toolName === 'Bash' && typeof toolInput.command === 'string') {
    if (/\brtk\b/.test(toolInput.command)) {
      return 'rtkCalls';
    }
  }
  if (toolName.startsWith('mcp__jcodemunch__')) {
    return 'jmCalls';
  }
  if (toolName.startsWith('mcp__graphify__')) {
    return 'graphifyCalls';
  }
  // Track efficient native tool usage on code files
  if (toolName === 'Read' && typeof toolInput.file_path === 'string') {
    if (isCodeFile(toolInput.file_path)) return 'efficientCalls';
  }
  if (toolName === 'Grep') {
    return 'efficientCalls';
  }
  if (toolName === 'Glob') {
    return 'efficientCalls';
  }
  return null;
}

function isCodeFile(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx|py|rs|go|java|rb|php|c|cpp|h|cs|swift|kt)$/i.test(filePath);
}

export interface JcodemunchSessionStats {
  session_tokens_saved: number;
  session_calls: number;
  total_tokens_saved?: number;
  tool_breakdown?: Record<string, number>;
  result_cache?: {
    hit_rate: number;
    total_hits: number;
  };
}

export function formatSavingsReport(
  baseline: MetricsBaseline | null | undefined,
  currentSaved: number,
  counters: { rtkCalls: number; jmCalls: number; efficientCalls: number; graphifyCalls: number },
  jmStats?: JcodemunchSessionStats | null,
  graphifyStats?: Record<string, GraphifyProjectStats> | null,
): string {
  const hasBaseline = baseline != null && baseline.totalSaved > 0;
  const lines: string[] = [];

  if (hasBaseline) {
    lines.push('[rig] Session Savings');
    const delta = currentSaved - baseline.totalSaved;
    if (delta > 0 || counters.rtkCalls > 0) {
      const deltaStr = formatTokens(delta);
      const totalStr = formatTokens(currentSaved);
      lines.push(`  rtk: ${totalStr} saved (${counters.rtkCalls} calls, +${deltaStr} this session)`);
    } else {
      lines.push(`  rtk: no token savings this session`);
    }
  } else {
    lines.push('[rig] Session Savings (all-time)');
    if (currentSaved > 0) {
      const totalStr = formatTokens(currentSaved);
      lines.push(`  rtk: ${totalStr} saved (${counters.rtkCalls} calls, all-time)`);
    } else {
      lines.push(`  rtk: no data`);
    }
  }

  if (jmStats && jmStats.session_calls > 0) {
    const saved = formatTokens(jmStats.session_tokens_saved);
    const totalStr = jmStats.total_tokens_saved ? formatTokens(jmStats.total_tokens_saved) : '';
    const totalSuffix = totalStr ? `, ${totalStr} total all-time` : '';
    lines.push(`  jcodemunch: ${saved} saved (${jmStats.session_calls} queries${totalSuffix})`);
  } else if (jmStats && jmStats.total_tokens_saved && jmStats.total_tokens_saved > 0) {
    const totalStr = formatTokens(jmStats.total_tokens_saved);
    lines.push(`  jcodemunch: ${totalStr} saved all-time (no queries this session)`);
  } else if (jmStats) {
    lines.push(`  jcodemunch: available (no queries this session)`);
  }

  if (counters.efficientCalls > 0) {
    lines.push(`  efficient tools: ${counters.efficientCalls} calls (Read/Grep/Glob on code files)`);
  }

  if (graphifyStats && Object.keys(graphifyStats).length > 0) {
    const querySuffix = counters.graphifyCalls > 0 ? `, ${counters.graphifyCalls} queries` : '';
    const entries = Object.entries(graphifyStats);
    if (entries.length === 1) {
      const [, s] = entries[0];
      lines.push(
        `  graphify: ${s.nodes} nodes, ${s.edges} edges, ${s.communities} communities (${s.extractedPct}% EXTRACTED, ${s.inferredPct}% INFERRED, ${s.ambiguousPct}% AMBIGUOUS)${querySuffix}`,
      );
    } else {
      lines.push('  graphify:');
      for (const [dir, s] of entries) {
        const label = basename(dir);
        lines.push(
          `    ${label}: ${s.nodes} nodes, ${s.edges} edges, ${s.communities} communities (${s.extractedPct}% EXTRACTED, ${s.inferredPct}% INFERRED, ${s.ambiguousPct}% AMBIGUOUS)`,
        );
      }
    }
  }

  return lines.join('\n');
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return `${n}`;
}

/**
 * Resolve graphifyStats from cache to a single project's stats.
 * The cache stores `Record<string, GraphifyProjectStats>` keyed by directory path.
 */
export function resolveGraphifyStats(
  raw: Record<string, GraphifyProjectStats> | null | undefined,
  cwd: string,
): GraphifyProjectStats | null {
  if (!raw) return null;
  return raw[cwd] ?? null;
}

import { execSync } from 'node:child_process';
import { join, resolve, basename } from 'node:path';
import { SessionCache } from './cache.js';
import type { Environment, GraphBuildInfo, HarnessConfig } from '../types.js';
import { detectEnvironment, callJcodemunchMcpTool } from './environment.js';
import { detectPythonEnv } from './python-env.js';
import { checkWorktreeSuggestion } from './worktree.js';
import { captureMetricsBaseline, captureGraphifyStatsViaReport } from './metrics.js';
import { triggerBuild, waitForBuild } from '../scout/graph-state.js';
import { loadConfig } from '../config.js';
import { checkGraphifyMcpReadiness } from './graphify-self-check.js';
import { checkPermissionsReadiness } from './permissions-self-check.js';
import { readFileSync, existsSync } from 'node:fs';

interface FileCapWarning {
  indexed: number;
  total: number;
}

/**
 * SessionStart hook handler. Detects environment and auto-indexes CWD
 * with jcodemunch if available but not yet indexed.
 */
export async function handleSessionStart(cwd: string, cache: SessionCache): Promise<string> {
  const { env, fileCapHit } = await detectAndIndex(cwd);
  cache.setEnvironment(env);

  const pyEnv = await detectPythonEnv(cwd);
  cache.setPythonEnv(pyEnv);

  const baseline = captureMetricsBaseline((cmd) => execSync(cmd, { encoding: 'utf-8' }));
  // Capture graphify stats via report (not the 74MB graph.json)
  const graphInfo = env.graphBuildInfo;
  const execFn = (cmd: string) => execSync(cmd, { encoding: 'utf-8' });
  if (graphInfo?.state === 'ready') {
    const cwdStats = captureGraphifyStatsViaReport(cwd, execFn);
    if (cwdStats) {
      baseline.graphifyStats = { [resolve(cwd)]: cwdStats };
    }
  } else if (graphInfo?.state === 'absent') {
    // Async build: trigger in background, mark as building
    const buildResult = triggerBuild(cwd, execFn);
    if (buildResult.state === 'building') {
      // Check if it completed quickly (small projects)
      const checkResult = waitForBuild(buildResult, cwd,
        (p) => { try { execSync(`test -f "${p}"`, { encoding: 'utf-8' }); return true; } catch { return false; } },
        (p) => { try { return require('node:fs').statSync(p); } catch { return undefined; } },
      );
      if (checkResult.state === 'ready') {
        env.graphBuildInfo = checkResult;
        env.graphifyAvailable = true;
        env.graphifyGraphPath = checkResult.graphPath ?? null;
        const buildStats = captureGraphifyStatsViaReport(cwd, execFn);
        if (buildStats) {
          baseline.graphifyStats = { [resolve(cwd)]: buildStats };
        }
      } else {
        env.graphBuildInfo = { state: 'failed' };
      }
    } else {
      env.graphBuildInfo = buildResult;
    }
    cache.setGraphBuildInfo(env.graphBuildInfo);
  }
  // Persist graphBuildInfo to session cache
  if (env.graphBuildInfo) {
    cache.setGraphBuildInfo(env.graphBuildInfo);
  }
  // Preserve existing baseline if recapture yields zero (e.g. rtk temporarily unavailable)
  const existingBaseline = cache.getMetricsBaseline();
  if (existingBaseline && existingBaseline.totalSaved > 0 && baseline.totalSaved === 0) {
    baseline.totalSaved = existingBaseline.totalSaved;
    baseline.graphifyStats = baseline.graphifyStats ?? existingBaseline.graphifyStats;
  }
  cache.setMetricsBaseline(baseline);

  // Capture changed files for failure classification
  try {
    const diff = execSync('git diff --name-only HEAD', { encoding: 'utf-8' }).trim();
    if (diff) {
      cache.setChangedFiles(diff.split('\n').filter(Boolean));
    }
  } catch {
    // Not a git repo or no commits — skip
  }

  const lines = [
    '[rig] Session initialized',
    `  rtk: ${env.rtkAvailable ? `available (${env.rtkPath})` : 'not found'}`,
    `  jcodemunch: ${env.jcodemunchAvailable ? 'available' : 'not found'}`,
    `  graphify: ${graphInfo?.state === 'ready' ? 'available' : graphInfo?.state === 'building' ? 'building graph...' : graphInfo?.state === 'failed' ? 'build failed' : 'not found'}`,
  ];

  if (env.jcodemunchAvailable) {
    if (env.jcodemunchCwdIndexed) {
      lines.push(`  CWD indexed: ${env.jcodemunchCwdRepo}`);
    } else {
      lines.push(`  CWD: not indexed (auto-indexing skipped)`);
    }
  }

  if (graphInfo?.state === 'ready' && baseline.graphifyStats) {
    const entries = Object.entries(baseline.graphifyStats);
    if (entries.length > 0) {
      const [dir, gs] = entries[0];
      const label = basename(dir);
      lines.push(`  Graph (${label}): ${gs.nodes} nodes, ${gs.edges} edges, ${gs.communities} communities (${gs.extractedPct}% EXTRACTED)`);
    }
  }

  lines.push(`  Detected at: ${new Date(env.detectedAt).toISOString()}`);

  if (fileCapHit) {
    lines.push(`[WARNING] jcodemunch indexed ${fileCapHit.indexed} of ${fileCapHit.total} files (file limit reached).`);
    lines.push(`  Search quality is degraded. Increase max_folder_files in ~/.code-index/config.jsonc`);
  }

  // Emit active enforcement rules from config
  const configPath = join(resolve(cwd), '.harness.yaml');
  const config = await loadConfig(configPath);
  const activeRules = formatActiveRules(config);
  if (activeRules) {
    lines.push(activeRules);
  }

  const suggestion = checkWorktreeSuggestion(cwd, (cmd) => execSync(cmd, { encoding: 'utf-8' }));
  if (suggestion) {
    lines.push(suggestion);
  }

  // Subagent delegation instructions — main agent passes these to spawned agents
  if (env.jcodemunchAvailable) {
    lines.push('[rig] When spawning subagents (Explore, Plan, etc.), include this instruction:');
    lines.push('  Prefer jcodemunch MCP tools over Bash find/grep/cat for token savings:');
    lines.push('  - mcp__jcodemunch__search_text instead of grep/rg');
    lines.push('  - mcp__jcodemunch__get_file_tree instead of find/fd');
    lines.push('  - mcp__jcodemunch__get_file_outline instead of cat/head on code files');
    lines.push('[rig] For codebase exploration, you MUST use the scout agent instead of Explore:');
    lines.push('  Use Agent(subagent_type: "scout") instead of Explore for 80%+ token savings');
    lines.push('  Scout uses jcodemunch and graphify MCP tools; Explore uses raw find/grep/cat');
    lines.push('  Do NOT dismiss this advisory — always use scout for codebase exploration tasks');
  }

  if (graphInfo?.state === 'ready') {
    lines.push('[rig] Graphify graph tools available for relationship queries:');
    lines.push('  - mcp__graphify__query_graph for relationship context');
    lines.push('  - mcp__graphify__god_nodes for core abstractions');
    lines.push('  - mcp__graphify__get_community for module clustering');
    lines.push('  - mcp__graphify__shortest_path for dependency paths');
  }

  // Graphify MCP server self-check (only when CLI is present but MCP not ready)
  const execFnForCheck = (cmd: string, opts?: { encoding?: string; timeout?: number }) =>
    execSync(cmd, { encoding: 'utf-8', ...opts } as Parameters<typeof execSync>[1]) as string;
  const mcpReadiness = checkGraphifyMcpReadiness(cwd, env, execFnForCheck);
  if (mcpReadiness.status !== 'ready' && mcpReadiness.status !== 'cli_missing') {
    if (mcpReadiness.status === 'no_graph') {
      lines.push(`[WARNING] graphify CLI present but no graph built. Run: ${mcpReadiness.fixCommand}`);
    } else if (mcpReadiness.status === 'cli_only_mcp_dep_missing') {
      lines.push('[WARNING] graphify MCP server unavailable: missing Python "mcp" dependency.');
      lines.push(`  Fix: ${mcpReadiness.fixCommand}`);
    } else if (mcpReadiness.status === 'cli_only_not_registered') {
      lines.push('[WARNING] graphify CLI present but MCP server not registered with Claude Code.');
      lines.push('  Scout will fall back to parsing graph.json instead of using mcp__graphify__* tools.');
      lines.push(`  Fix: ${mcpReadiness.fixCommand}`);
    }
  }

  // Permissions self-check: settings.json should auto-allow rig's required entries
  const permsReadiness = checkPermissionsReadiness(
    cwd,
    (p) => readFileSync(p, 'utf-8'),
    existsSync,
  );
  if (permsReadiness.status === 'missing') {
    lines.push('[WARNING] .claude/settings.json is missing rig-required permission entries.');
    lines.push(`  Missing: ${permsReadiness.missing.join(', ')}`);
    lines.push(`  Fix: ${permsReadiness.fixCommand}`);
  } else if (permsReadiness.status === 'no_settings') {
    lines.push('[WARNING] .claude/settings.json missing or unreadable — rig permissions cannot be verified.');
    lines.push(`  Fix: ${permsReadiness.fixCommand}`);
  }

  // One-time warning for missing tools
  if (!cache.getToolsWarned()) {
    if (!env.rtkAvailable) {
      lines.push('[WARNING] rtk is not installed. Install for 60-90% token savings on dev operations: https://github.com/franklywatson/rtk');
    }
    if (!env.jcodemunchAvailable) {
      lines.push('[WARNING] jcodemunch is not installed. Install for indexed code search: https://github.com/franklywatson/jcodemunch');
    }
    if (!graphInfo) {
      lines.push('[HINT] graphify is not installed. Install for knowledge graph analysis: https://github.com/safishamsi/graphify');
    }
    cache.setToolsWarned(true);
  }

  return lines.join('\n');
}

function formatActiveRules(config: HarnessConfig): string | null {
  const active: string[] = [];

  const constitutional = config.rules.constitutional;
  if (constitutional) {
    for (const [rule, level] of Object.entries(constitutional)) {
      if (level && level !== 'silent') {
        active.push(`${rule} (${level})`);
      }
    }
  }

  if (active.length === 0) return null;
  return `  Active enforcement: ${active.join(', ')}`;
}

async function detectAndIndex(
  cwd: string,
  exec?: import('./environment.js').ExecFn,
  existsCheck?: (path: string) => boolean,
  statCheck?: (path: string) => { size: number } | undefined,
): Promise<{ env: Environment; fileCapHit?: FileCapWarning }> {
  const env = await detectEnvironment(cwd, exec, existsCheck, statCheck);
  let fileCapHit: FileCapWarning | undefined;

  // Auto-index if jcodemunch is available but CWD isn't indexed
  if (env.jcodemunchAvailable && !env.jcodemunchCwdIndexed) {
    // Try CLI auto-index first (only works when jcodemunch CLI binary is installed)
    try {
      execSync('which jcodemunch', { encoding: 'utf-8' });
      const indexResult = execSync(
        `jcodemunch index_folder --path "${cwd}"`,
        { encoding: 'utf-8', timeout: 60_000 },
      ).trim();
      const parsedResult = JSON.parse(indexResult);
      if (parsedResult.success) {
        env.jcodemunchCwdIndexed = true;
        env.jcodemunchCwdRepo = parsedResult.repo ?? env.jcodemunchCwdRepo;
        if (env.jcodemunchCwdRepo && !env.jcodemunchKnownRepos.includes(env.jcodemunchCwdRepo)) {
          env.jcodemunchKnownRepos.push(env.jcodemunchCwdRepo);
        }
        const skipped = parsedResult.discovery_skip_counts?.file_limit ?? 0;
        if (skipped > 0 && parsedResult.file_count) {
          fileCapHit = { indexed: parsedResult.file_count, total: parsedResult.file_count + skipped };
        }
      }
    } catch {
      // CLI not available — try MCP auto-index via JSON-RPC
      try {
        const mcpPath = execSync('which jcodemunch-mcp', { encoding: 'utf-8' }).trim();
        if (mcpPath) {
          const execFn = (cmd: string, opts?: { encoding?: string; timeout?: number }) =>
            execSync(cmd, { encoding: 'utf-8', ...opts } as Parameters<typeof execSync>[1]) as string;
          const text = callJcodemunchMcpTool(mcpPath, 'index_folder', { path: cwd }, execFn);
          if (text) {
            const parsedResult = JSON.parse(text);
            if (parsedResult.success) {
              env.jcodemunchCwdIndexed = true;
              env.jcodemunchCwdRepo = parsedResult.repo ?? env.jcodemunchCwdRepo;
              if (env.jcodemunchCwdRepo && !env.jcodemunchKnownRepos.includes(env.jcodemunchCwdRepo)) {
                env.jcodemunchKnownRepos.push(env.jcodemunchCwdRepo);
              }
              const skipped = parsedResult.discovery_skip_counts?.file_limit ?? 0;
              if (skipped > 0 && parsedResult.file_count) {
                fileCapHit = { indexed: parsedResult.file_count, total: parsedResult.file_count + skipped };
              }
            }
          }
        }
      } catch {
        // MCP auto-index failed — agent can index via MCP directly
      }
    }
  }

  return { env, fileCapHit };
}

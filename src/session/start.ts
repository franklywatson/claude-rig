import { execSync } from 'node:child_process';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { SessionCache } from './cache.js';
import type { Environment, GraphBuildInfo, HarnessConfig } from '../types.js';
import { detectEnvironment, callJcodemunchMcpTool } from './environment.js';
import type { ExecFn, McpQueryFn, RegistrationLookupFn } from './environment.js';
import { detectPythonEnv } from './python-env.js';
import { checkBranchDiscipline, WORKFLOW_DEFAULTS } from './worktree.js';
import { captureMetricsBaseline, captureGraphifyStatsViaReport } from './metrics.js';
import { triggerBuild, waitForBuild } from '../scout/graph-state.js';
import type { WaitForBuildOpts } from '../scout/graph-state.js';
import { loadConfig } from '../config.js';
import { checkGraphifyMcpReadiness } from './graphify-self-check.js';
import { checkPermissionsReadiness } from './permissions-self-check.js';
import { detectHeadroom } from './headroom.js';
import { detectSuperpowers } from './superpowers.js';
import { detectRtkGlobalHook } from './rtk-global-hook.js';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';

interface FileCapWarning {
  indexed: number;
  total: number;
}

export type AutoIndexOutcome = 'succeeded' | 'failed' | 'not_needed';

// graphify versions rig's stats parsing and state handling are tested against
const GRAPHIFY_TESTED_MIN = '0.9.0';
const GRAPHIFY_TESTED_MAX_EXCLUSIVE = '0.10.0';

function versionInRange(version: string, min: string, maxExclusive: string): boolean {
  const segments = (v: string): number[] => v.split('.').map(Number);
  const compare = (a: number[], b: number[]): number => {
    for (let i = 0; i < 3; i++) {
      const diff = (a[i] ?? 0) - (b[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  };
  const v = segments(version);
  return compare(v, segments(min)) >= 0 && compare(v, segments(maxExclusive)) < 0;
}

/** Injectable seams for handleSessionStart; production callers pass nothing. */
export interface SessionStartDeps {
  exec?: ExecFn;
  existsCheck?: (path: string) => boolean;
  statCheck?: (path: string) => { size: number } | undefined;
  mcpQuery?: McpQueryFn;
  registrationLookup?: RegistrationLookupFn;
  readdir?: (path: string) => string[];
  readFile?: (path: string) => string;
  homeDir?: string;
  graphWait?: WaitForBuildOpts;
  envVars?: Record<string, string | undefined>;
}

// graphify update can return before graph.json is fully written; poll across
// that window instead of caching a false "failed" for the whole session.
const GRAPH_WAIT_DEFAULT: WaitForBuildOpts = { deadlineMs: 5000, intervalMs: 250 };

/**
 * SessionStart hook handler. Detects environment and auto-indexes CWD
 * with jcodemunch if available but not yet indexed.
 */
export async function handleSessionStart(
  cwd: string,
  cache: SessionCache,
  deps: SessionStartDeps = {},
): Promise<string> {
  const { env, fileCapHit, autoIndex } = await detectAndIndex(
    cwd, deps.exec, deps.existsCheck, deps.statCheck, deps.mcpQuery, deps.registrationLookup,
    deps.envVars,
  );

  // Headroom (context-compression proxy) is complementary to rig — record
  // whether it is configured so /savings can include context-layer stats.
  const headroom = detectHeadroom(
    cwd,
    deps.exec ?? ((cmd, opts) => execSync(cmd, { encoding: 'utf-8', ...opts } as Parameters<typeof execSync>[1]) as string),
    deps.readFile,
    deps.existsCheck ?? existsSync,
    deps.homeDir,
  );
  env.headroomAvailable = headroom.available;
  env.headroomInitialized = headroom.initialized;
  const superpowers = detectSuperpowers(deps.readFile, deps.existsCheck ?? existsSync, deps.homeDir);
  env.superpowers = superpowers;
  cache.setEnvironment(env);

  const pyEnv = await detectPythonEnv(cwd);
  cache.setPythonEnv(pyEnv);

  const execFn: ExecFn = (cmd, opts) =>
    execSync(cmd, { encoding: 'utf-8', ...opts } as Parameters<typeof execSync>[1]) as string;
  const statsWarnings: string[] = [];
  const onStatsWarn = (msg: string): void => { statsWarnings.push(msg); };
  const baseline = captureMetricsBaseline(execFn, onStatsWarn);
  // Capture graphify stats via report (not the 74MB graph.json)
  const graphInfo = env.graphBuildInfo;
  if (graphInfo?.state === 'ready') {
    const cwdStats = captureGraphifyStatsViaReport(cwd, execFn, onStatsWarn);
    if (cwdStats) {
      baseline.graphifyStats = { [resolve(cwd)]: cwdStats };
    }
  } else if (graphInfo?.state === 'absent') {
    // Async build: trigger in background, mark as building
    const buildResult = triggerBuild(cwd, execFn);
    if (buildResult.state === 'building') {
      // Poll briefly — graphify update can return before graph.json lands
      const checkResult = waitForBuild(buildResult, cwd,
        deps.existsCheck ?? ((p) => { try { execSync(`test -f "${p}"`, { encoding: 'utf-8' }); return true; } catch { return false; } }),
        deps.statCheck ?? ((p) => { try { return statSync(p); } catch { return undefined; } }),
        // (direct import, not require() — dist is ESM, where require is a ReferenceError)
        deps.graphWait ?? GRAPH_WAIT_DEFAULT,
      );
      if (checkResult.state === 'ready') {
        env.graphBuildInfo = checkResult;
        env.graphifyAvailable = true;
        env.graphifyGraphPath = checkResult.graphPath ?? null;
        const buildStats = captureGraphifyStatsViaReport(cwd, execFn, onStatsWarn);
        if (buildStats) {
          baseline.graphifyStats = { [resolve(cwd)]: buildStats };
        }
      } else {
        env.graphBuildInfo = checkResult;
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
    `  rtk: ${env.rtkAvailable ? `available (${env.rtkPath}${env.rtkVersion ? `, v${env.rtkVersion}` : ''})` : 'not found'}`,
    `  jcodemunch: ${describeJcodemunch(env)}`,
    `  graphify: ${describeGraphify(env.graphBuildInfo)}`,
  ];

  if (env.rtkAvailable && detectRtkGlobalHook(deps.readFile, deps.existsCheck ?? existsSync, deps.homeDir)) {
    lines.push(
      "[HINT] rtk's global PreToolUse hook is also installed (~/.claude/settings.json) — redundant with rig's project hook (double-rewrites Bash commands). Remove with: rtk init --uninstall -g",
    );
  }

  if (env.headroomInitialized) {
    lines.push('  headroom: proxy configured (context-layer compression)');
  }
  lines.push(
    `  superpowers: ${env.superpowers?.installed ? `installed${env.superpowers.version ? ` (v${env.superpowers.version})` : ''}` : 'not found'}`,
  );

  if (env.agentTeamsAvailable) {
    lines.push('  agent-teams: available (experimental)');
  }

  if (env.jcodemunchAvailable) {
    if (env.jcodemunchCwdIndexed) {
      lines.push(`  CWD indexed: ${env.jcodemunchCwdRepo}`);
    } else if (autoIndex === 'failed') {
      lines.push('  CWD not indexed (auto-index failed — run mcp__jcodemunch__index_folder manually)');
    } else {
      lines.push('  CWD: not indexed');
    }
  }

  if (env.jcodemunchProtocolWarning) {
    lines.push(`[WARNING] ${env.jcodemunchProtocolWarning}`);
  }

  if (env.graphifyVersion && !versionInRange(env.graphifyVersion, GRAPHIFY_TESTED_MIN, GRAPHIFY_TESTED_MAX_EXCLUSIVE)) {
    lines.push(`[WARNING] graphify ${env.graphifyVersion} is outside the tested range (>=${GRAPHIFY_TESTED_MIN} <${GRAPHIFY_TESTED_MAX_EXCLUSIVE}) — proceeding anyway`);
  }

  for (const warning of statsWarnings) {
    lines.push(`[WARNING] ${warning}`);
  }

  if (env.graphBuildInfo?.state === 'ready' && baseline.graphifyStats) {
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

  const suggestion = checkBranchDiscipline((cmd) => execSync(cmd, { encoding: 'utf-8' }), config);
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

  if (env.graphBuildInfo?.state === 'ready') {
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
      lines.push('[WARNING] rtk is not installed. Install for 60-90% token savings on dev operations: https://github.com/rtk-ai/rtk');
    }
    if (!env.jcodemunchAvailable) {
      lines.push('[WARNING] jcodemunch was not detected. Install for indexed code search: https://github.com/jgravelle/jcodemunch-mcp');
      lines.push("  If installed as an MCP server, verify its registration with 'claude mcp list'.");
      if (hasOrphanedIndexData(deps.homeDir ?? homedir(), deps.readdir ?? readdirSync)) {
        lines.push('[WARNING] jcodemunch index data found at ~/.code-index but no working transport detected.');
        lines.push("  The server is likely registered but unreachable — check 'claude mcp list' output.");
      }
    }
    if (!env.graphBuildInfo) {
      lines.push('[HINT] graphify is not installed. Install for knowledge graph analysis: https://github.com/safishamsi/graphify');
    }
    if (!env.superpowers?.installed) {
      lines.push(
        "[WARNING] superpowers not detected — rig's skill chain wraps superpowers:* skills and requires it. Install: /plugin install superpowers@claude-plugins-official",
      );
    }
    cache.setToolsWarned(true);
  }

  return lines.join('\n');
}

function describeGraphify(info: GraphBuildInfo | undefined): string {
  switch (info?.state) {
    case 'ready':
      return 'available';
    case 'building':
      return 'building graph...';
    case 'failed':
      return info.errorReason ? `build failed (${info.errorReason})` : 'build failed';
    default:
      return 'not found';
  }
}

function describeJcodemunch(env: Environment): string {
  if (!env.jcodemunchAvailable) return 'not found';
  const t = env.jcodemunchTransport;
  if (!t) return 'available';
  switch (t.kind) {
    case 'cli':
      return 'available (cli)';
    case 'binary':
      return `available (mcp binary: ${t.command})`;
    case 'uvx':
      return 'available (mcp via uvx)';
    case 'config': {
      const cmd = `${t.command} ${t.args.join(' ')}`.trim();
      const shown = cmd.length > 100 ? cmd.slice(0, 97) + '...' : cmd;
      return `available (mcp via ${t.source ?? 'claude'} config: ${shown})`;
    }
  }
}

/** Index DBs on disk + failed detection = registration/transport problem, not a missing install. */
function hasOrphanedIndexData(homeDir: string, readdir: (path: string) => string[]): boolean {
  try {
    return readdir(join(homeDir, '.code-index')).some(f => f.endsWith('.db'));
  } catch {
    return false;
  }
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

  // Branch discipline belongs in the active-rules line too — skill templates
  // anchor on "see session-start output", which must not be empty for
  // sessions started on feature branches (where the protected-branch hint
  // does not fire).
  const branchLevel = config.rules.workflow?.branch_discipline ?? WORKFLOW_DEFAULTS.branch_discipline;
  if (branchLevel !== 'silent') {
    active.push(`branch_discipline (${branchLevel})`);
  }

  if (active.length === 0) return null;
  return `  Active enforcement: ${active.join(', ')}`;
}

export async function detectAndIndex(
  cwd: string,
  exec?: ExecFn,
  existsCheck?: (path: string) => boolean,
  statCheck?: (path: string) => { size: number } | undefined,
  mcpQuery?: McpQueryFn,
  registrationLookup?: RegistrationLookupFn,
  envVars?: Record<string, string | undefined>,
): Promise<{ env: Environment; fileCapHit?: FileCapWarning; autoIndex: AutoIndexOutcome }> {
  const env = await detectEnvironment(cwd, exec, existsCheck, statCheck, mcpQuery, registrationLookup, envVars);
  let fileCapHit: FileCapWarning | undefined;
  let autoIndex: AutoIndexOutcome = 'not_needed';

  // Auto-index if jcodemunch is available but CWD isn't indexed, reusing the
  // exact transport that detection succeeded with — never re-derive it.
  if (env.jcodemunchAvailable && !env.jcodemunchCwdIndexed) {
    autoIndex = 'failed';
    const transport = env.jcodemunchTransport;
    const execFn: ExecFn = exec ??
      ((cmd, opts) => execSync(cmd, { encoding: 'utf-8', ...opts } as Parameters<typeof execSync>[1]) as string);

    if (transport?.kind === 'cli') {
      try {
        const indexResult = execFn(
          `jcodemunch index_folder --path "${cwd}"`,
          { timeout: 60_000 },
        ).trim();
        if (applyIndexResult(env, JSON.parse(indexResult), (cap) => { fileCapHit = cap; })) {
          autoIndex = 'succeeded';
        }
      } catch {
        // CLI auto-index failed — surfaced via the autoIndex outcome
      }
    } else if (transport) {
      try {
        const text = await callJcodemunchMcpTool(
          transport.command,
          transport.args,
          'index_folder',
          { path: cwd },
          mcpQuery,
        );
        if (text && applyIndexResult(env, JSON.parse(text), (cap) => { fileCapHit = cap; })) {
          autoIndex = 'succeeded';
        }
      } catch {
        // MCP auto-index failed — agent can index via MCP directly
      }
    }
  }

  return { env, fileCapHit, autoIndex };
}

function applyIndexResult(
  env: Environment,
  parsedResult: { success?: boolean; repo?: string; file_count?: number; discovery_skip_counts?: { file_limit?: number } },
  onFileCap: (cap: FileCapWarning) => void,
): boolean {
  if (!parsedResult.success) return false;
  env.jcodemunchCwdIndexed = true;
  env.jcodemunchCwdRepo = parsedResult.repo ?? env.jcodemunchCwdRepo;
  if (env.jcodemunchCwdRepo && !env.jcodemunchKnownRepos.includes(env.jcodemunchCwdRepo)) {
    env.jcodemunchKnownRepos.push(env.jcodemunchCwdRepo);
  }
  const skipped = parsedResult.discovery_skip_counts?.file_limit ?? 0;
  if (skipped > 0 && parsedResult.file_count) {
    onFileCap({ indexed: parsedResult.file_count, total: parsedResult.file_count + skipped });
  }
  return true;
}

import { execFileSync, execSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import type { HarnessConfig, RewriteResult } from '../types.js';
import { SessionCache } from '../session/cache.js';
import { findMatchingRule, getDefaultRules } from './rules.js';
import { resolve } from './resolver.js';
import { tryPythonRewrite } from './python-rewrite.js';
import { isCompoundCommand } from './intent.js';
import { checkTestScope } from '../enforcement/test-scope.js';
import { checkBranchDisciplineCommand } from './branch-discipline.js';
import type { ExecFn } from '../session/worktree.js';

export type ExecRewriteFn = (rtkPath: string, args: string[]) => string | null;
export type ExistsCheckFn = (path: string) => boolean;

export interface HookOptions {
  execRewrite?: ExecRewriteFn;
  existsCheck?: ExistsCheckFn;
  /** Injectable exec for branch-discipline git probes (testability). */
  branchExec?: ExecFn;
}

export type RawExecFileFn = (file: string, args: string[], opts: object) => string;

const RTK_DIAG_LOG = '/tmp/rig-rtk-rewrite-failures.log';

const defaultWriteDiag = (line: string): void => {
  try {
    appendFileSync(RTK_DIAG_LOG, line + '\n');
  } catch {
    // Best-effort diagnostics — never break the hook
  }
};

/**
 * Build the default ExecRewriteFn implementing rtk's rewrite exit-code
 * protocol (rtk src/hooks/rewrite_cmd.rs):
 *
 *   0 + stdout  rewrite, safe to auto-allow
 *   1           no RTK equivalent — pass through
 *   2           deny rule matched — pass through (never use stdout)
 *   3 + stdout  "Ask" verdict — rewrite valid, but must not be auto-allowed
 *
 * rig never auto-allows (the hook emits updatedInput without a
 * permissionDecision, so Claude Code's own permission flow applies to the
 * rewritten command), which makes exit 3 equivalent to exit 0 here. rtk maps
 * commands without an explicit allow rule — notably all git commands — to
 * Ask, so dropping exit-3 output would lose the most common rewrites.
 *
 * Anything outside the protocol — exit 3 without output, other exit codes,
 * signals, ENOENT — is appended as a JSON line to the diagnostic log so
 * silent fallthroughs become debuggable in the field. Set RIG_DEBUG to log
 * expected declines too. Null-fallthrough is unchanged.
 */
export function makeDefaultExecRewrite(
  writeDiag: (line: string) => void = defaultWriteDiag,
  rawExec: RawExecFileFn = execFileSync as unknown as RawExecFileFn,
): ExecRewriteFn {
  return (rtkPath: string, args: string[]): string | null => {
    try {
      const result = rawExec(rtkPath, args, {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return result.trim() || null;
    } catch (err) {
      const e = err as { status?: number; signal?: string; code?: string; stdout?: unknown; stderr?: unknown };

      // Exit 3 = rtk's "Ask" verdict: the rewrite is on stdout.
      if (e?.status === 3) {
        const stdout =
          typeof e.stdout === 'string'
            ? e.stdout
            : Buffer.isBuffer(e.stdout)
              ? e.stdout.toString('utf-8')
              : '';
        const rewritten = stdout.trim();
        if (rewritten) return rewritten;
        // Exit 3 without output violates the protocol — fall through to diag.
      }

      const expectedDecline = e?.status === 1 || e?.status === 2;
      if (!expectedDecline || process.env.RIG_DEBUG) {
        const stderr =
          typeof e?.stderr === 'string'
            ? e.stderr
            : Buffer.isBuffer(e?.stderr)
              ? e.stderr.toString('utf-8')
              : '';
        writeDiag(
          JSON.stringify({
            ts: Date.now(),
            command: args.join(' '),
            exitCode: e?.status ?? null,
            signal: e?.signal ?? e?.code ?? null,
            stderr: stderr.slice(0, 300),
          }),
        );
      }
      return null;
    }
  };
}

const defaultExecRewrite: ExecRewriteFn = makeDefaultExecRewrite();

/**
 * Try to rewrite a Bash command using `rtk rewrite`.
 * Returns the rewritten command or null if rtk can't/won't rewrite it.
 */
const RTK_PREFIXES = ['git ', 'grep ', 'rg ', 'find ', 'fd ', 'cat ', 'head ', 'tail ', 'ls ', 'diff ', 'wc '];

export function tryRtkRewrite(
  command: string,
  rtkPath: string,
  execRewrite: ExecRewriteFn = defaultExecRewrite,
): string | null {
  // Only attempt rewrite for commands rtk is designed to handle
  const binary = command.trimStart().split(/\s+/)[0] ?? '';
  if (!RTK_PREFIXES.some(p => command.trimStart().startsWith(p)) && binary !== 'git') {
    return null;
  }
  const rewritten = execRewrite(rtkPath, ['rewrite', command]);
  if (!rewritten || rewritten === command) return null;
  return rewritten;
}

function defaultEnv() {
  return {
    rtkAvailable: false,
    rtkPath: null,
    jcodemunchAvailable: false,
    jcodemunchCwdIndexed: false,
    jcodemunchCwdRepo: null,
    jcodemunchKnownRepos: [] as string[],
    graphifyAvailable: false,
    graphifyGraphPath: null,
    detectedAt: Date.now(),
  };
}

/**
 * PreToolUse hook handler. Returns null to allow, a string to advise/block,
 * or a RewriteResult to transparently rewrite the tool call.
 *
 * Flow:
 * 1. Resolution-level blocks (file_modify, rtk_cat_code) — always block
 * 2. Transparent rewrite via rtk for Bash commands when rtk available
 * 3. Enforcement-level blocks (text_search with block enforcement) — block when rtk can't rewrite
 * 4. Advises and allows for remaining rules
 */
export function handlePreToolUse(
  tool: string,
  args: Record<string, unknown>,
  cache: SessionCache,
  config: HarnessConfig,
  cwd?: string,
  options?: ExecRewriteFn | HookOptions,
): string | RewriteResult | null {
  const effectiveCwd = cwd ?? process.cwd();
  const resolvedOptions: HookOptions = typeof options === 'function'
    ? { execRewrite: options }
    : options ?? {};
  const rules = getDefaultRules(effectiveCwd);
  let match = findMatchingRule(tool, args, rules);
  const env = cache.getEnvironment() ?? defaultEnv();

  // Step 0: Scout explore — advise scout when jcodemunch available, fall through otherwise
  if (match?.intent === 'scout_explore') {
    if (env.jcodemunchAvailable) {
      const enforcement = getEffectiveEnforcement('scout_explore', config, match.enforcement);
      if (enforcement === 'silent') return null;
      // First-occurrence suppression for scout_explore advisory
      if (enforcement === 'advise' && cache.hasAdvised('scout_explore')) return null;
      cache.markAdvised('scout_explore');
      const prefix = enforcement === 'block' ? '[BLOCK]' : '[ADVISE]';
      return [
        `${prefix} Tool Router: scout_explore detected`,
        `advise: use scout — You MUST use Agent with subagent_type: "scout" instead of Explore when examining codebases. Scout uses jcodemunch and graphify MCP tools for token-efficient exploration (80%+ fewer tokens).`,
        enforcement === 'block'
          ? 'This operation is blocked by .harness.yaml. Use the recommended tool instead.'
          : 'Do not dismiss this advisory. Switch to subagent_type: "scout" now.',
      ].join('\n');
    }
    // jcodemunch not available — fall through to file_discovery
    match = findMatchingRule(tool, args, rules, new Set(['scout_explore']));
  }

  // Step 1: Resolution-level blocks always win (file_modify, rtk_cat_code)
  if (match) {
    const resolution = resolve(match, env);
    if (resolution.action === 'block') {
      return [
        `[BLOCK] Tool Router: ${match.intent} operation blocked`,
        `Reason: ${resolution.reason}`,
        'This operation is always blocked. Use the recommended alternative.',
      ].join('\n');
    }
  }

  // Steps 1.5 + 1.6: pre-rewrite Bash checks, evaluated collect-then-pick:
  // every check runs before anything is returned, any block-level result
  // wins over any advisory, and only when nothing blocks does the first
  // advisory surface. This guarantees an advisory from one check can never
  // preempt a block from another. Both run before the rewrite steps (2 and
  // 3) because a block must win over a rewrite; that early return is safe
  // today because no UNSCOPED_TEST_PATTERNS command is rtk- or
  // python-rewritable — revisit if RTK_PREFIXES ever gains test runners.
  if (tool === 'Bash' && typeof args.command === 'string') {
    const preflight: { level: 'advise' | 'block'; message: string }[] = [];

    // Step 1.5: Test-scope check — during tdd+/sdd+, advise a scoped run
    // before a full-suite command executes. Hooks are separate processes, so
    // phase and source-edit history come from the session cache (persisted
    // by the PostToolUse hook), not a FileTracker. No first-occurrence
    // suppression: every unscoped run is flagged.
    const scopeViolation = checkTestScope(
      args.command,
      cache.getCurrentPhase(),
      cache.getEditedFiles('source'),
      config,
    );
    if (scopeViolation) {
      preflight.push({
        level: scopeViolation.startsWith('[BLOCK]') ? 'block' : 'advise',
        message: scopeViolation,
      });
    }

    // Step 1.6: Branch discipline — git commit/push on a protected branch
    // advises once per session (or blocks, per rules.workflow). Scans every
    // quote-aware compound segment, so `cd /tmp && git commit` is still
    // caught. The once-per-session advisory costs at most one rtk rewrite.
    const branchExec: ExecFn = resolvedOptions.branchExec
      ?? ((cmd) => execSync(cmd, { encoding: 'utf-8', cwd: effectiveCwd, timeout: 5000 }) as string);
    const discipline = checkBranchDisciplineCommand(args.command, config, cache, branchExec);
    if (discipline) preflight.push(discipline);

    const blocked = preflight.find(r => r.level === 'block');
    if (blocked) return blocked.message;
    if (preflight.length > 0) return preflight[0].message;
  }

  // Step 2: Python environment rewrite for Bash commands (skip compound commands)
  if (tool === 'Bash' && typeof args.command === 'string' && !isCompoundCommand(args.command)) {
    const pythonEnv = cache.getPythonEnv();
    if (pythonEnv) {
      const rewritten = tryPythonRewrite(args.command, effectiveCwd, pythonEnv, resolvedOptions.existsCheck);
      if (rewritten) {
        return { type: 'rewrite', command: rewritten, original: args.command };
      }
    }
  }

  // Step 3: Transparent rewrite via rtk for Bash commands (skip compound commands)
  if (tool === 'Bash' && typeof args.command === 'string') {
    if (env.rtkAvailable && env.rtkPath && !isCompoundCommand(args.command)) {
      const rewritten = tryRtkRewrite(args.command, env.rtkPath, resolvedOptions.execRewrite);
      if (rewritten) {
        return { type: 'rewrite', command: rewritten, original: args.command };
      }
    }
  }

  // Step 4: No match = pass through
  if (!match) return null;

  // Step 4b: Compound commands skip advisory (but file_modify still blocks above).
  if (
    tool === 'Bash' &&
    typeof args.command === 'string' &&
    isCompoundCommand(args.command)
  ) {
    return null;
  }

  // Step 5: Enforcement-level blocks and advises
  const resolution = resolve(match, env);
  if (resolution.action === 'allow') return null;

  const enforcementLevel = getEffectiveEnforcement(match.intent, config, match.enforcement);

  if (enforcementLevel === 'silent') return null;

  // First-occurrence suppression: advise once per intent per session
  if (resolution.action === 'advise' && enforcementLevel === 'advise') {
    if (cache.hasAdvised(match.intent)) return null;
    cache.markAdvised(match.intent);
  }

  const prefix = enforcementLevel === 'block' ? '[BLOCK]' : '[ADVISE]';

  if (resolution.action === 'advise') {
    return [
      `${prefix} Tool Router: ${match.intent} detected`,
      `advise: use ${resolution.tool} — ${resolution.reason}`,
      enforcementLevel === 'block'
        ? 'This operation is blocked by .harness.yaml. Use the recommended tool instead.'
        : 'Consider using the recommended tool for better efficiency.',
    ].join('\n');
  }

  return null;
}

const INTENT_CONFIG_KEYS: Record<string, string> = {
  text_search: 'grep',
  file_discovery: 'find',
  file_read: 'cat',
  file_modify: 'sed_i',
  native_read: 'native_read',
  native_grep: 'native_grep',
  native_glob: 'native_glob',
  rtk_cat_code: 'rtk_cat_code',
  scout_explore: 'scout_explore',
};

function getEffectiveEnforcement(
  intent: string,
  config: HarnessConfig,
  ruleDefault: string,
): string {
  const configRules = config.rules as Record<string, Record<string, unknown>>;
  const toolRouting = configRules.tool_routing;
  if (toolRouting) {
    const configKey = INTENT_CONFIG_KEYS[intent] ?? intent;
    if (typeof toolRouting[configKey] === 'string') {
      return toolRouting[configKey] as string;
    }
  }
  return ruleDefault;
}

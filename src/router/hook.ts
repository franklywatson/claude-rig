import { execFileSync } from 'node:child_process';
import type { HarnessConfig, RewriteResult } from '../types.js';
import { SessionCache } from '../session/cache.js';
import { findMatchingRule, getDefaultRules, matchCwdReference } from './rules.js';
import { resolve } from './resolver.js';
import { tryPythonRewrite } from './python-rewrite.js';
import { isCompoundCommand } from './intent.js';

export type ExecRewriteFn = (rtkPath: string, args: string[]) => string | null;
export type ExistsCheckFn = (path: string) => boolean;

export interface HookOptions {
  execRewrite?: ExecRewriteFn;
  existsCheck?: ExistsCheckFn;
}

const defaultExecRewrite: ExecRewriteFn = (rtkPath: string, args: string[]): string | null => {
  try {
    const result = execFileSync(rtkPath, args, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim() || null;
  } catch {
    // exit 1 = no rewrite, exit 2 = denied — both fall through to rig rules
    return null;
  }
};

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
  // Exception: cwd_path_expand is specifically about catching compound commands
  // like `cd <cwd> && <cmd>`, so it must bypass this suppression.
  if (
    tool === 'Bash' &&
    typeof args.command === 'string' &&
    isCompoundCommand(args.command) &&
    match.intent !== 'cwd_path_expand'
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

  // cwd_path_expand has special output format
  if (match.intent === 'cwd_path_expand' && tool === 'Bash') {
    const command = args.command as string;
    const ref = matchCwdReference(command, effectiveCwd);
    if (ref?.isCdForm && ref.isExactCwd) {
      // Pattern: `cd <cwd>[ && cmd]` — the cd is redundant.
      const tail = command.slice(ref.prefixLen).replace(/^\s*&&\s*/, '').trim();
      const suggested = tail.length > 0 ? `\`${tail}\`` : '(nothing — you are already there)';
      return [
        `${prefix} Tool Router: redundant cd to cwd detected`,
        `advise: drop the \`cd\`; run ${suggested} directly. You are already in ${effectiveCwd}.`,
        'Shorter, saves tokens, more portable.',
      ].join('\n');
    }
    if (ref?.isCdForm) {
      // Pattern: `cd <cwd>/subdir[ && cmd]` — suggest relative cd.
      const subdirAndRest = command.slice(ref.prefixLen);
      const subdir = subdirAndRest.split(/[\s&;|]/)[0];
      return [
        `${prefix} Tool Router: fully-qualified CWD path in \`cd\``,
        `advise: use \`cd ./${subdir}\` instead — you are already in ${effectiveCwd}.`,
        'Shorter, saves tokens, more portable.',
      ].join('\n');
    }
    // Default: bare absolute-path invocation, e.g. `/abs/cwd/bin/foo args`.
    const relativePart = command.slice(ref?.prefixLen ?? effectiveCwd.length + 1);
    const binary = relativePart.split(/\s+/)[0];
    return [
      `${prefix} Tool Router: fully-qualified CWD path detected`,
      `advise: use ./${binary} instead of ${command.split(/\s+/)[0]}`,
      'Shorter, saves tokens, more portable.',
    ].join('\n');
  }

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
  cwd_path_expand: 'cwd_path_expand',
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

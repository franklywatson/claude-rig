import type { ToolRule } from '../types.js';
import { classifyIntent } from './intent.js';

const CODE_FILE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.kts', '.scala',
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp',
  '.rb', '.swift',
];

export function isCodeFile(filePath: string): boolean {
  const ext = filePath.includes('.') ? '.' + filePath.split('.').pop() : '';
  return ext !== '' && CODE_FILE_EXTENSIONS.includes(ext);
}

/**
 * Default routing rules — ported and evolved from damage-control-guardrails.
 *
 * Priority resolution for each rule: rtk > jcodemunch > claudeTool > fallback
 * Enforcement: block | advise | silent (configurable per-rule in .harness.yaml)
 */
export function getDefaultRules(cwd?: string): ToolRule[] {
  return [
    // ── Native Read Advisory (code files only, no targeted re-read) ──
    {
      match: (tool: string, args: Record<string, unknown>) => {
        if (tool !== 'Read') return false;
        const filePath = args.file_path as string | undefined;
        if (!filePath || !isCodeFile(filePath)) return false;
        if (args.offset != null || args.limit != null) return false;
        return true;
      },
      intent: 'native_read',
      resolutions: {
        jcodemunch: { action: 'advise', tool: 'jcodemunch get_file_outline or get_symbol', reason: 'For code files, get_file_outline returns structure with signatures (80-85% fewer tokens than full file read)' },
        fallback: { action: 'allow' },
      },
      enforcement: 'advise',
    },

    // ── Native Grep Advisory (suggest jcodemunch when indexed) ──
    {
      match: (tool: string, args: Record<string, unknown>) => {
        return tool === 'Grep';
      },
      intent: 'native_grep',
      resolutions: {
        jcodemunch: { action: 'advise', tool: 'jcodemunch search_text', reason: 'jcodemunch provides indexed, token-efficient search with context lines (80-85% fewer tokens)' },
        fallback: { action: 'allow' },
      },
      enforcement: 'advise',
    },

    // ── Native Glob Advisory (code file patterns only) ──
    {
      match: (tool: string, args: Record<string, unknown>) => {
        if (tool !== 'Glob') return false;
        const pattern = args.pattern as string | undefined;
        if (!pattern) return false;
        return CODE_FILE_EXTENSIONS.some(ext => pattern.includes(ext));
      },
      intent: 'native_glob',
      resolutions: {
        jcodemunch: { action: 'advise', tool: 'jcodemunch get_file_tree', reason: 'jcodemunch provides cached, semantic file listing with symbol counts (80% fewer tokens)' },
        fallback: { action: 'allow' },
      },
      enforcement: 'advise',
    },

    // ── rtk cat on code files (close the bypass) ──
    {
      match: (tool: string, args: Record<string, unknown>) => {
        if (tool !== 'Bash') return false;
        const command = args.command as string | undefined;
        if (!command) return false;
        const rtkCatMatch = command.match(/^rtk\s+cat\s+(\S+)/);
        if (!rtkCatMatch) return false;
        return isCodeFile(rtkCatMatch[1]);
      },
      intent: 'rtk_cat_code',
      resolutions: {
        _: { action: 'block', reason: 'rtk cat on code files wastes tokens. Use jcodemunch get_file_outline for structure, get_symbol_source for definitions.' },
      },
      enforcement: 'block',
    },

    // ── Scout Explore Advisory (Agent with Explore subagent → prefer scout) ──
    {
      match: (tool: string, args: Record<string, unknown>) => {
        return tool === 'Agent' && typeof args.subagent_type === 'string' && args.subagent_type === 'Explore';
      },
      intent: 'scout_explore',
      resolutions: {
        jcodemunch: { action: 'advise', tool: 'scout', reason: 'You MUST use Agent with subagent_type: "scout" instead of Explore when examining codebases. Scout uses jcodemunch and graphify MCP tools for token-efficient exploration (80%+ fewer tokens)' },
        fallback: { action: 'allow' },
      },
      enforcement: 'advise',
    },

    // ── Text Search ──
    {
      match: (tool: string, args: Record<string, unknown>) => {
        return classifyIntent(tool, args) === 'text_search';
      },
      intent: 'text_search',
      resolutions: {
        rtk: { action: 'advise', tool: 'rtk grep', reason: 'rtk provides filtered, token-optimized grep output (60-90% savings)' },
        jcodemunch: { action: 'advise', tool: 'jcodemunch search_text or search_symbols', reason: 'jcodemunch provides typed, indexed results with summaries (80-85% token savings)' },
        claudeTool: { action: 'advise', tool: 'Grep', reason: 'Claude Grep tool is preferred over raw bash grep — structured output' },
        fallback: { action: 'allow' },
      },
      enforcement: 'advise',
    },

    // ── File Discovery ──
    {
      match: (tool: string, args: Record<string, unknown>) => {
        return classifyIntent(tool, args) === 'file_discovery';
      },
      intent: 'file_discovery',
      resolutions: {
        rtk: { action: 'advise', tool: 'rtk find', reason: 'rtk provides filtered file discovery' },
        jcodemunch: { action: 'advise', tool: 'jcodemunch get_file_tree or get_repo_outline', reason: 'jcodemunch provides cached, semantic file tree with symbol counts (80% token savings)' },
        claudeTool: { action: 'advise', tool: 'Glob', reason: 'Claude Glob tool is preferred over raw bash find — targeted patterns' },
        fallback: { action: 'allow' },
      },
      enforcement: 'advise',
    },

    // ── File Read (Bash cat/head only — Claude Read tool is pass-through) ──
    {
      match: (tool: string, args: Record<string, unknown>) => {
        return tool === 'Bash' && classifyIntent(tool, args) === 'file_read';
      },
      intent: 'file_read',
      resolutions: {
        rtk: { action: 'advise', tool: 'rtk cat', reason: 'rtk provides filtered, token-optimized file reading (60-90% savings)' },
        jcodemunch: { action: 'advise', tool: 'jcodemunch get_file_content', reason: 'jcodemunch provides cached, token-efficient file content (80-85% savings)' },
        claudeTool: { action: 'advise', tool: 'Read', reason: 'Use Claude Read tool instead of cat/head — cleaner output, no artifacts' },
        fallback: { action: 'allow' },
      },
      enforcement: 'advise',
    },

    // ── File Modify (Bash sed -i / awk > only — Claude Edit/Write tools are pass-through) ──
    {
      match: (tool: string, args: Record<string, unknown>) => {
        return tool === 'Bash' && classifyIntent(tool, args) === 'file_modify';
      },
      intent: 'file_modify',
      resolutions: {
        _: { action: 'block', reason: 'Use Claude Edit tool for file modifications — validates exact matches before applying changes. Never use sed -i or awk redirects.' },
      },
      enforcement: 'block',
    },

    // ── CWD Path Expansion (fully-qualified CWD paths in commands) ──
    {
      match: (tool: string, args: Record<string, unknown>) => {
        if (tool !== 'Bash') return false;
        const command = args.command as string | undefined;
        if (!command || !cwd) return false;
        if (matchCwdReference(command, cwd) === null) return false;
        // .venv/bin paths are legitimate — the Python rewrite produces them
        if (command.includes('.venv/')) return false;
        return true;
      },
      intent: 'cwd_path_expand',
      resolutions: {
        _: {
          action: 'advise',
          tool: './ (relative path)',
          reason: 'Use ./ instead of fully-qualified CWD path — shorter, saves tokens, more portable',
        },
      },
      enforcement: 'advise',
    },
  ];
}

/**
 * Detects whether `command` begins with a reference to the cwd as a
 * fully-qualified path, accounting for shell-quoting forms that come up when
 * cwd contains spaces and for the `cd <cwd>...` anti-pattern that agents
 * frequently emit.
 *
 * Returns:
 *   - `prefixLen`: index into `command` where the cwd reference ends and
 *     the remainder begins (slice with this to get what follows).
 *   - `isCdForm`: true when the match was preceded by a leading `cd ` —
 *     lets callers produce a different advice message.
 *   - `isExactCwd`: true when the reference was to exactly cwd (no subdir).
 *     Distinguishes "redundant cd" from "cd to subdir".
 *
 * Forms recognized for the cwd reference (with or without leading `cd `):
 *   - bare:               /abs/some path/foo  (no spaces in cwd)
 *   - backslash-escaped:  /abs/some\ path/foo
 *   - double-quoted:      "/abs/some path/foo"
 *   - single-quoted:      '/abs/some path/foo'
 */
export function matchCwdReference(
  command: string,
  cwd: string,
): { prefixLen: number; isCdForm: boolean; isExactCwd: boolean } | null {
  const direct = tryMatchAt(command, 0, cwd);
  if (direct) return { ...direct, isCdForm: false };

  if (command.startsWith('cd ')) {
    const afterCd = tryMatchAt(command, 3, cwd);
    if (afterCd) return { ...afterCd, isCdForm: true };
  }

  return null;
}

function tryMatchAt(
  command: string,
  offset: number,
  cwd: string,
): { prefixLen: number; isExactCwd: boolean } | null {
  // Path-continuation forms first (cwd followed by `/` — i.e. cwd/subdir or
  // cwd/binary). Return `prefixLen` pointing PAST the `/` so the slice yields
  // the subdir/binary directly.
  const continuations: string[] = [cwd + '/'];
  if (cwd.includes(' ')) continuations.push(cwd.replace(/ /g, '\\ ') + '/');
  continuations.push('"' + cwd + '/');
  continuations.push("'" + cwd + '/');
  for (const text of continuations) {
    if (command.startsWith(text, offset)) {
      return { prefixLen: offset + text.length, isExactCwd: false };
    }
  }

  // Exact-cwd forms next (cwd followed by end-of-string or a shell boundary
  // — space, tab, &, ;, |, ). Quoted forms must include the closing quote.
  const exacts: string[] = [cwd];
  if (cwd.includes(' ')) exacts.push(cwd.replace(/ /g, '\\ '));
  exacts.push('"' + cwd + '"');
  exacts.push("'" + cwd + "'");
  for (const text of exacts) {
    if (!command.startsWith(text, offset)) continue;
    const next = command[offset + text.length];
    if (
      next === undefined ||
      next === ' ' ||
      next === '\t' ||
      next === '&' ||
      next === ';' ||
      next === '|'
    ) {
      return { prefixLen: offset + text.length, isExactCwd: true };
    }
  }

  return null;
}

/**
 * Find the first rule whose match function accepts the given tool call.
 * Returns undefined if no rule matches (pass-through).
 */
export function findMatchingRule(
  tool: string,
  args: Record<string, unknown>,
  rules: ToolRule[],
  skipIntents?: Set<string>,
): ToolRule | undefined {
  for (const rule of rules) {
    if (skipIntents?.has(rule.intent)) continue;
    const matchFn = rule.match;
    if (matchFn instanceof RegExp) {
      // For bash commands, test against the command string
      if (tool === 'Bash' && typeof args.command === 'string') {
        if (matchFn.test(args.command)) return rule;
      }
    } else if (typeof matchFn === 'function') {
      if (matchFn(tool, args)) return rule;
    }
  }
  return undefined;
}

import { extname } from 'node:path';

/**
 * File extensions whose contents jcodemunch can outline as code symbols.
 * Non-code files (logs, markdown, configs) are left to rtk — an outline of
 * them is not meaningfully better than the raw text.
 */
const CODE_EXTENSIONS = new Set<string>([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java',
  '.kt', '.scala', '.rb', '.php', '.cs', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.swift', '.vue', '.svelte', '.elixir', '.ex', '.exs', '.clj', '.cljs',
  '.hs', '.ml', '.fs', '.dart', '.lua', '.pl', '.r', '.jl',
]);

export interface DivertDecision {
  /** 'outline' = big-file structural read; 'symbol' = identifier search. */
  shape: 'outline' | 'symbol';
  /** The jcodemunch MCP tool to recommend, e.g. mcp__jcodemunch__get_file_outline. */
  jmTool: string;
  /** Human-readable rationale, embedded in the advisory message. */
  reason: string;
  /** The file path (outline) or search pattern (symbol) the decision targets. */
  target: string;
}

export interface DivertOptions {
  existsCheck: (p: string) => boolean;
  statCheck: (p: string) => { size: number; isFile: boolean };
  /** File-size threshold (bytes) above which a `cat` diverts to get_file_outline. */
  outlineBytes: number;
}

/**
 * Tokenize a command into the binary, non-flag positional args, and a flag set.
 * Quote-naive (v1): a quoted path with spaces splits into multiple positionals,
 * which safely suppresses a divert rather than mis-routing. See spec tradeoffs.
 */
function parse(command: string): { binary: string; positional: string[]; flags: Set<string> } {
  const tokens = command.trim().split(/\s+/);
  return {
    binary: tokens[0] ?? '',
    positional: tokens.slice(1).filter(t => !t.startsWith('-')),
    flags: new Set(tokens.slice(1).filter(t => t.startsWith('-')).map(t => t.replace(/=.*$/, ''))),
  };
}

/**
 * Decide whether a Bash command is a high-value jcodemunch opportunity.
 * Returns a DivertDecision for a recognized high-value shape, or null to let
 * the caller fall through to rtk (Step 3 of the router).
 *
 * Shape A (big-file `cat` outline) is implemented here; Shape B (identifier
 * grep/rg symbol search) is added alongside in a later task.
 */
export function scoreJcodemunchValue(command: string, opts: DivertOptions): DivertDecision | null {
  const { binary, positional } = parse(command);

  // Shape A — big-file structural read (`cat` only).
  // `head`/`tail` are excluded: they imply the agent wants a slice (top/bottom),
  // not the whole file, so the outline is not the better tool.
  if (binary === 'cat') {
    if (positional.length !== 1) return null; // multi-file cat → stay rtk
    const target = positional[0];
    if (!opts.existsCheck(target)) return null;
    const stat = opts.statCheck(target);
    if (!stat.isFile) return null;
    if (!CODE_EXTENSIONS.has(extname(target))) return null;
    if (stat.size <= opts.outlineBytes) return null;
    return {
      shape: 'outline',
      jmTool: 'mcp__jcodemunch__get_file_outline',
      target,
      reason: `${target} is large; the outline gives its structure for far fewer tokens than reading the whole file (rtk would still return every line).`,
    };
  }

  return null;
}

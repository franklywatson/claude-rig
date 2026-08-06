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
  '.hs', '.ml', '.fs', '.dart', '.lua', '.pl', '.r', '.jl', '.erl',
]);

/** A single identifier token (no spaces, no regex metacharacters). */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Regex metacharacters — their presence means a literal/regex scan, not a symbol lookup. */
const REGEX_METACHAR = /[.*+?^${}()|[\]\\/]/;

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
    // Long options keep their name (--foo, --foo=bar); short-option clusters
    // like `-rl` decompose into `-r` and `-l` so individual flags are detectable.
    flags: new Set(tokens.slice(1).flatMap(t => {
      if (!t.startsWith('-')) return [];
      if (t.startsWith('--')) return [t.replace(/=.*$/, '')];
      return t.slice(1).split('').map(ch => '-' + ch);
    })),
  };
}

/**
 * Decide whether a Bash command is a high-value jcodemunch opportunity.
 * Returns a DivertDecision for a recognized high-value shape, or null to let
 * the caller fall through to rtk (Step 3 of the router).
 *
 * Shape A: big-file `cat` → get_file_outline.
 * Shape B: single-identifier `grep`/`rg` → search_symbols.
 */
export function scoreJcodemunchValue(command: string, opts: DivertOptions): DivertDecision | null {
  const { binary, positional, flags } = parse(command);

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

  // Shape B — symbol-shaped search (grep / rg, single identifier token).
  // Diverts only when exactly one pattern is given and it looks like a real
  // symbol name: identifier-shaped, no regex metacharacters, and containing a
  // lowercase letter (filters all-caps literal-scan markers like TODO/FIXME and
  // constants in favor of CamelCase / snake_case names search_symbols handles).
  if (binary === 'grep' || binary === 'rg') {
    if (flags.has('-l') || flags.has('--files-with-matches')) return null;
    // One pass collects explicit pattern sources (-e / --regexp, including the
    // `--regexp=PATTERN` form) and the remaining positional args, SKIPPING the
    // values of value-taking flags (e.g. `rg --type ts PAT` — `ts` is the type,
    // not the search pattern) so a flag value is never mistaken for the pattern.
    const VALUE_FLAGS = new Set(['-A', '-B', '-C', '-m', '-M', '-g', '-t', '--type', '--glob', '--max-count', '--max-columns', '--ignore', '--ignore-file', '--before-context', '--after-context', '--context']);
    const tokens = command.trim().split(/\s+/);
    const patterns: string[] = [];
    const positionalArgs: string[] = [];
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === '-e' || t === '--regexp') {
        const v = tokens[i + 1];
        if (v !== undefined && !v.startsWith('-')) patterns.push(v);
        i++; // consume the value so it isn't also treated as positional
      } else if (t.startsWith('--regexp=')) {
        patterns.push(t.slice('--regexp='.length));
      } else if (t.startsWith('--') && t.includes('=')) {
        // other --flag=value (e.g. --include=*.ts): value is attached, not positional
      } else if (t.startsWith('-')) {
        if (VALUE_FLAGS.has(t)) i++; // skip this flag's value token
      } else {
        positionalArgs.push(t);
      }
    }
    // Multiple explicit patterns = an OR query search_symbols can't express → rtk.
    const pattern = patterns.length === 1
      ? patterns[0]
      : (patterns.length === 0 ? positionalArgs[0] : undefined);
    if (!pattern) return null;                        // multi-pattern OR, or none → rtk
    if (REGEX_METACHAR.test(pattern)) return null;    // regex/literal scan → rtk
    if (!IDENT.test(pattern)) return null;            // multi-token / phrase → rtk
    if (!/[a-z]/.test(pattern)) return null;          // all-caps (TODO/FIXME/CONST) → rtk
    return {
      shape: 'symbol',
      jmTool: 'mcp__jcodemunch__search_symbols',
      target: pattern,
      reason: `${pattern} looks like a symbol; mcp__jcodemunch__search_symbols ranks definitions/references better than a text grep.`,
    };
  }

  return null;
}

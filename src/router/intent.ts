export type IntentType =
  | 'file_read'
  | 'text_search'
  | 'file_discovery'
  | 'file_modify'
  | 'symbol_search'
  | 'scout_explore'
  | 'pass_through';

const INTENT_PRECEDENCE: Record<IntentType, number> = {
  file_modify: 5,
  symbol_search: 4,
  text_search: 3,
  file_discovery: 3,
  file_read: 2,
  scout_explore: 3,
  pass_through: 0,
};

const BASH_INTENT_PATTERNS: Array<{ pattern: { test(segment: string): boolean }; intent: IntentType }> = [
  // Destructive patterns first (highest precedence)
  { pattern: /^\s*sed\s+(-i|--in-place)\b/, intent: 'file_modify' },
  { pattern: { test: awkWritesFile }, intent: 'file_modify' },
  // Search patterns
  { pattern: /^\s*(grep[rx]?|rg)\b/, intent: 'text_search' },
  { pattern: /^\s*sed\b/, intent: 'text_search' },
  // Discovery patterns
  { pattern: /^\s*find\s+/, intent: 'file_discovery' },
  { pattern: /^\s*fd\b/, intent: 'file_discovery' },
  // Read patterns
  { pattern: /^\s*cat\s+\S+/, intent: 'file_read' },
  { pattern: /^\s*head\s+/, intent: 'file_read' },
  { pattern: /^\s*tail\s+/, intent: 'file_read' },
];

const TOOL_INTENT_MAP: Record<string, IntentType> = {
  Grep: 'text_search',
  Glob: 'file_discovery',
  Read: 'file_read',
  Edit: 'file_modify',
  Write: 'file_modify',
  Bash: 'pass_through', // resolved by bash command analysis
};

/**
 * True when an awk command writes a file: the shell redirects its output
 * (`awk '...' in > out`, including stderr redirects like `2> err.log`) or
 * the awk program redirects a print (`awk '{print > "out"}' in`). A `>` used
 * as a comparison inside the quoted program, a `>` in an awk comment or a
 * heredoc body, `>&N` dups and `/dev/null` targets do not count.
 */
function awkWritesFile(segment: string): boolean {
  if (!/^\s*awk\b/.test(segment)) return false;
  const { unquoted, quoted } = splitQuoted(segment);

  // Shell redirection outside any quotes, to a real target — any fd: `2>`
  // a file still creates/truncates it. Only the first logical line is
  // scanned: a heredoc body is data, not shell syntax, so a `>` there is
  // not a redirect. Backslash continuations join their follow-up line.
  const firstLogicalLine = unquoted.replace(/\\\n/g, ' ').split('\n')[0];
  for (const [, , dup, target] of firstLogicalLine.matchAll(/(\d*)>>?(&?)\s*([^\s<>]*)/g)) {
    if (dup === '&' || target === '/dev/null') continue; // 2>&1, >&2, >/dev/null
    return true;
  }

  // print/printf redirected from inside the awk program. Drop awk string
  // literals, comments, and parenthesised expressions first, so a `>` inside
  // a string, a comment, or a parenthesised comparison is not mistaken for
  // a redirect.
  return quoted.some((program) => {
    let code = program.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    code = code.replace(/#[^\n]*/g, ''); // awk comments run to end of line
    while (/\([^()]*\)/.test(code)) code = code.replace(/\([^()]*\)/g, '');
    return /\bprintf?\b[^;}|\n]*>/.test(code);
  });
}

/**
 * Split a shell segment into its unquoted text and the contents of its
 * quoted spans. An unterminated quote runs to the end of the segment.
 */
function splitQuoted(segment: string): { unquoted: string; quoted: string[] } {
  let unquoted = '';
  const quoted: string[] = [];
  let quote: string | null = null;
  let span = '';

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote === null) {
      if (ch === '"' || ch === '\'') {
        quote = ch;
        span = '';
        unquoted += ' ';
      } else {
        unquoted += ch;
      }
    } else if (ch === '\\' && quote === '"' && i + 1 < segment.length) {
      span += ch + segment[++i];
    } else if (ch === quote) {
      quoted.push(span);
      quote = null;
    } else {
      span += ch;
    }
  }
  if (quote !== null) quoted.push(span);

  return { unquoted, quoted };
}

function classifyBashCommand(command: string): IntentType {
  // Destructive operations are flagged wherever they appear in a chain — a
  // sed -i behind `&&`, `;`, or a pipe still modifies files. Scan every
  // quote-aware segment for file_modify before positional classification.
  for (const segment of splitCompoundSegments(command)) {
    const trimmed = segment.trim();
    for (const { pattern, intent } of BASH_INTENT_PATTERNS) {
      if (pattern.test(trimmed)) {
        if (intent === 'file_modify') return 'file_modify';
        break; // first matching pattern decides this segment
      }
    }
  }

  // Only classify the first segment (before any pipe).
  // grep/find/cat on the right side of | is output filtering, not code search.
  const pipeIndex = command.indexOf('|');
  const firstSegment = pipeIndex >= 0 ? command.slice(0, pipeIndex) : command;

  const segments = firstSegment.split(/&&|\|\||;/);

  // If the primary command (first segment) is pass_through, the entire chain
  // is pass_through — grep/cat after && is post-processing, not code search.
  const firstSeg = segments[0]?.trim() ?? '';
  let firstIntent: IntentType = 'pass_through';
  for (const { pattern, intent } of BASH_INTENT_PATTERNS) {
    if (pattern.test(firstSeg)) {
      firstIntent = intent;
      break;
    }
  }
  if (firstIntent === 'pass_through') return 'pass_through';

  let highest: IntentType = firstIntent;

  for (let i = 1; i < segments.length; i++) {
    const trimmed = segments[i].trim();
    for (const { pattern, intent } of BASH_INTENT_PATTERNS) {
      if (pattern.test(trimmed)) {
        if (INTENT_PRECEDENCE[intent] > INTENT_PRECEDENCE[highest]) {
          highest = intent;
        }
        break;
      }
    }
  }

  return highest;
}

/**
 * Split a command into segments on chaining/piping operators (`&&`, `||`,
 * `;`, `|`) that appear outside quoted strings. Mirrors isCompoundCommand's
 * quote handling so operators inside quotes never produce false segments.
 */
export function splitCompoundSegments(command: string): string[] {
  const segments: string[] = [];
  let inSingle = false;
  let inDouble = false;
  let start = 0;
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    if (ch === '\'' && !inDouble) {
      inSingle = !inSingle;
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      i++;
      continue;
    }
    if (inSingle || inDouble) {
      i++;
      continue;
    }

    if ((ch === '&' && command[i + 1] === '&') || (ch === '|' && command[i + 1] === '|')) {
      segments.push(command.slice(start, i));
      i += 2;
      start = i;
      continue;
    }
    if (ch === ';' || ch === '|') {
      segments.push(command.slice(start, i));
      i += 1;
      start = i;
      continue;
    }

    i++;
  }

  segments.push(command.slice(start));
  return segments;
}

/**
 * Detect shell chaining/piping operators outside of quoted strings.
 * Matches `;`, `&&`, `||`, and `|` but ignores operators inside
 * single or double quotes, and ignores redirect tokens like `2>&1`.
 */
export function isCompoundCommand(command: string): boolean {
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    if (ch === '\'' && !inDouble) {
      inSingle = !inSingle;
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      i++;
      continue;
    }

    if (inSingle || inDouble) {
      i++;
      continue;
    }

    // Check for multi-char operators first
    if (ch === '&' && command[i + 1] === '&') return true;
    if (ch === '|' && command[i + 1] === '|') return true;

    // Single-char operators (but | followed by & is 2>&1 redirect, not a pipe)
    if (ch === ';') return true;
    if (ch === '|') {
      // |& is a pipe-and-stderr redirect, still a pipe
      return true;
    }

    i++;
  }

  return false;
}

export function classifyIntent(tool: string, args: Record<string, unknown>): IntentType {
  // Direct tool mapping
  if (tool === 'Bash' && typeof args.command === 'string') {
    return classifyBashCommand(args.command);
  }

  if (tool === 'Agent' && typeof args.subagent_type === 'string') {
    if (args.subagent_type === 'Explore') return 'file_discovery';
    return 'pass_through';
  }

  return TOOL_INTENT_MAP[tool] ?? 'pass_through';
}

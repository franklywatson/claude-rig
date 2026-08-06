import { describe, it, expect } from 'vitest';
import { scoreJcodemunchValue } from '../../src/router/jcodemunch-value.js';

const opts = (overrides: Partial<{ size: number; exists: boolean }> = {}) => ({
  existsCheck: () => overrides.exists ?? true,
  statCheck: () => ({ size: overrides.size ?? 20000, isFile: true }),
  outlineBytes: 8192,
});

describe('scoreJcodemunchValue — Shape A (cat outline)', () => {
  it('diverts a big cat of a code file to get_file_outline', () => {
    const d = scoreJcodemunchValue('cat /x/src/big.ts', opts({ size: 20000 }));
    expect(d).toMatchObject({ shape: 'outline', jmTool: 'mcp__jcodemunch__get_file_outline', target: '/x/src/big.ts' });
  });

  it('does not divert a file below the outline byte threshold', () => {
    expect(scoreJcodemunchValue('cat /x/src/small.ts', opts({ size: 100 }))).toBeNull();
  });

  it('does not divert a non-code file extension', () => {
    expect(scoreJcodemunchValue('cat /x/notes.md', opts({ size: 20000 }))).toBeNull();
  });

  it('does not divert a missing file', () => {
    expect(scoreJcodemunchValue('cat /x/missing.ts', opts({ exists: false }))).toBeNull();
  });

  it('does not divert multi-file cat', () => {
    expect(scoreJcodemunchValue('cat /x/a.ts /x/b.ts', opts({ size: 20000 }))).toBeNull();
  });

  it('does not divert head or tail (slice reads)', () => {
    expect(scoreJcodemunchValue('head /x/big.ts', opts({ size: 20000 }))).toBeNull();
    expect(scoreJcodemunchValue('tail -n 50 /x/big.ts', opts({ size: 20000 }))).toBeNull();
  });

  it('does not divert a sed -n range print', () => {
    expect(scoreJcodemunchValue("sed -n '10,20p' /x/big.ts", opts({ size: 20000 }))).toBeNull();
  });

  it('returns null for unrelated commands', () => {
    expect(scoreJcodemunchValue('find . -name "*.ts"', opts())).toBeNull();
    expect(scoreJcodemunchValue('git status', opts())).toBeNull();
  });

  it('diverts cat -n (line-number flag does not change whole-file semantics)', () => {
    expect(scoreJcodemunchValue('cat -n /x/big.ts', opts({ size: 20000 }))).toMatchObject({ shape: 'outline' });
  });

  it('does not divert at exactly the byte threshold (strict >)', () => {
    expect(scoreJcodemunchValue('cat /x/big.ts', opts({ size: 8192 }))).toBeNull();
  });

  it('diverts one byte above the threshold', () => {
    expect(scoreJcodemunchValue('cat /x/big.ts', opts({ size: 8193 }))).toMatchObject({ shape: 'outline' });
  });

  it('does not divert a quoted path with spaces (quote-naive parse — known v1 limitation)', () => {
    expect(scoreJcodemunchValue('cat "src/my file.ts"', opts({ size: 20000 }))).toBeNull();
  });
});

describe('scoreJcodemunchValue — Shape B (identifier grep symbol search)', () => {
  it('diverts a single-identifier grep to search_symbols', () => {
    const d = scoreJcodemunchValue('grep -r calculateScore src/', opts());
    expect(d).toMatchObject({ shape: 'symbol', jmTool: 'mcp__jcodemunch__search_symbols', target: 'calculateScore' });
  });

  it('still diverts with --word-regexp (-w)', () => {
    expect(scoreJcodemunchValue('grep -rw FooBar .', opts())).toMatchObject({ shape: 'symbol' });
  });

  it('still diverts with rg and case-insensitive (-i)', () => {
    expect(scoreJcodemunchValue('rg -i MyType src/', opts())).toMatchObject({ shape: 'symbol', target: 'MyType' });
  });

  it('diverts snake_case identifiers', () => {
    expect(scoreJcodemunchValue('grep -r parse_header .', opts())).toMatchObject({ shape: 'symbol', target: 'parse_header' });
  });

  it('does not divert a regex pattern (contains metacharacters)', () => {
    expect(scoreJcodemunchValue('grep "foo.bar" src/', opts())).toBeNull();
    expect(scoreJcodemunchValue('grep -r "a|b" .', opts())).toBeNull();
  });

  it('does not divert a multi-token / quoted phrase pattern', () => {
    expect(scoreJcodemunchValue('grep "some phrase" .', opts())).toBeNull();
  });

  it('does not divert all-caps literal-scan markers (TODO/FIXME) — no lowercase letter', () => {
    expect(scoreJcodemunchValue('grep -r TODO .', opts())).toBeNull();
    expect(scoreJcodemunchValue('grep -rn FIXME src/', opts())).toBeNull();
  });

  it('does not divert --files-with-matches (-l)', () => {
    expect(scoreJcodemunchValue('grep -rl FooBar .', opts())).toBeNull();
  });

  it('diverts --regexp=PATTERN (the = form)', () => {
    expect(scoreJcodemunchValue('grep --regexp=FooBar src/', opts())).toMatchObject({ shape: 'symbol', target: 'FooBar' });
  });

  it('does not divert multiple -e patterns (an OR query search_symbols cannot express)', () => {
    expect(scoreJcodemunchValue('grep -e Foo -e Bar baz.ts', opts())).toBeNull();
  });

  it('does not mistake a value-taking flag value for the pattern (rg --type ts "export function")', () => {
    // `ts` is the --type value, not the search pattern; the real pattern is a phrase.
    expect(scoreJcodemunchValue('rg --type ts "export function"', opts())).toBeNull();
  });

  it('still diverts an identifier search that carries a --type/-t filter', () => {
    expect(scoreJcodemunchValue('rg -t ts calculateScore src/', opts())).toMatchObject({ shape: 'symbol', target: 'calculateScore' });
  });
});

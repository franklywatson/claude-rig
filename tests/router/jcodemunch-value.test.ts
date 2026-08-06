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

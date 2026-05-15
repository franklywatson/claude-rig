import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const TEMPLATES = resolve(import.meta.dirname, '..', '..', 'templates', 'skills');

const CANONICAL_DEBUG_PHRASES = [
  'debug this',
  'fix this bug',
  'there is a bug',
  'why is this failing',
  'what is wrong with',
  'test failure',
  'unexpected behavior',
  'something is broken',
  'trace the issue',
  'diagnose the problem',
  'figure out why',
  'investigate this',
];

describe('debug+ skill trigger eval', () => {
  let content: string;
  let frontmatter: string;
  let body: string;

  beforeAll(() => {
    const path = join(TEMPLATES, 'debug-plus', 'SKILL.md');
    content = readFileSync(path, 'utf-8');
    const parts = content.split('---');
    frontmatter = parts[1] ?? '';
    body = parts.slice(2).join('---');
  });

  it('description covers core debugging trigger concepts: bug, failure, unexpected', () => {
    expect(frontmatter).toMatch(/bug/i);
    expect(frontmatter).toMatch(/fail/i);
    expect(frontmatter).toMatch(/unexpected/i);
  });

  it('description covers fix/broken/diagnose triggers beyond "investigate"', () => {
    // Must not rely solely on "investigate" as the trigger word
    const descriptionMatch = frontmatter.match(/description:\s*"([^"]+)"/);
    const description = descriptionMatch?.[1] ?? frontmatter;
    const hasBeyondInvestigate = /fix|broken|diagnos|debug/i.test(description);
    expect(hasBeyondInvestigate).toBe(true);
  });

  it('argument-hint covers error/failure terminology, not just investigation phrasing', () => {
    expect(frontmatter).toContain('argument-hint');
    const hintMatch = frontmatter.match(/argument-hint:\s*"([^"]+)"/);
    const hint = hintMatch?.[1] ?? '';
    expect(hint).toMatch(/bug|error|broken|fail/i);
  });

  it('skill body references debug/fix/broken as triggers alongside investigate', () => {
    expect(body.toLowerCase()).toMatch(/debug|fix|broken/);
    expect(body.toLowerCase()).toContain('investigate');
  });

  it('trigger phrase coverage: at least 8 of 12 canonical debugging phrases match description vocabulary', () => {
    const fullText = content.toLowerCase();
    const covered = CANONICAL_DEBUG_PHRASES.filter(phrase => {
      const words = phrase.toLowerCase().split(' ').filter(w => w.length > 3);
      return words.some(word => fullText.includes(word));
    });
    expect(covered.length).toBeGreaterThanOrEqual(8);
  });
});

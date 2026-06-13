import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  extractAssistantText,
  matchLoopOptIn,
  matchSectionsPresent,
  judgeNegative,
} from '../../evals/grade.js';

const fx = (name: string) => readFileSync(join(process.cwd(), 'evals/fixtures', name), 'utf-8');

describe('grade: transcript extraction', () => {
  it('recovers assistant text from real stream-json (result + assistant lines)', () => {
    const text = extractAssistantText(fx('canned-loop-fit-positive.jsonl'));
    expect(text.length).toBeGreaterThan(200);
    expect(text.toLowerCase()).toContain('loop-fit');
  });
});

describe('grade: loop opt-in detection (model-robust tokens)', () => {
  it('fires on the positive canned transcript', () => {
    expect(matchLoopOptIn(extractAssistantText(fx('canned-loop-fit-positive.jsonl')))).toBe(true);
  });
  it('does NOT fire on the negative canned transcript', () => {
    expect(matchLoopOptIn(extractAssistantText(fx('canned-loop-fit-negative.jsonl')))).toBe(false);
  });
  it('does NOT fire on ambient "signal stack" mentions (the discriminator)', () => {
    expect(matchLoopOptIn('We considered which layers of the signal stack this CLI touches.')).toBe(false);
  });
});

describe('grade: sections present', () => {
  it('true when all three required sections are present', () => {
    const t = 'The signal stack L0-L4 ... primary system is operable with the loop disabled ... autonomy ceiling: orchestrator owns merges.';
    expect(matchSectionsPresent(t)).toBe(true);
  });
  it('false when a section is missing', () => {
    expect(matchSectionsPresent('Just a signal stack and an autonomy ceiling, nothing about the boundary.')).toBe(false);
  });
});

describe('grade: confined judge fallback (fail-closed)', () => {
  it('PASS verdict -> compliant (no loop offered)', async () => {
    expect(await judgeNegative('...', async () => 'Verdict: PASS')).toBe(true);
  });
  it('FAIL verdict -> not compliant', async () => {
    expect(await judgeNegative('...', async () => 'FAIL — it proposed a maintainer loop')).toBe(false);
  });
  it('garbage verdict -> fail-closed (not compliant)', async () => {
    expect(await judgeNegative('...', async () => 'I am not sure')).toBe(false);
  });
});

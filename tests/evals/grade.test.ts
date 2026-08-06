import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  extractAssistantText,
  matchLoopOptIn,
  matchSectionsPresent,
  judgeNegative,
  extractToolUseNames,
  matchJcodemunchUsed,
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
  it('fires on a dismissal-by-name — it is a presence detector, not an offer detector', () => {
    // Naming the trajectory to DISMISS it still trips the token match; the
    // offer-vs-mention call is the runner+judge job (see runner.test.ts).
    expect(matchLoopOptIn(extractAssistantText(fx('canned-loop-fit-dismissal.jsonl')))).toBe(true);
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
  it('accepts the natural "PASSED" wording', async () => {
    expect(await judgeNegative('...', async () => 'PASSED')).toBe(true);
  });
});

describe('grade: tool-use extraction (jcodemunch-followed detection)', () => {
  // Minimal stream-json: an assistant turn with a text block + a jcodemunch tool_use.
  const jmTranscript = [
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Looking up the symbol..."},{"type":"tool_use","name":"mcp__jcodemunch__search_symbols","input":{"query":"routeRequest"}}]}}',
    '{"type":"result","result":"found"}',
  ].join('\n');
  // Same shape but the agent fell back to raw Bash instead of following the divert.
  const bashTranscript =
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"grep -r routeRequest src/"}},{"type":"tool_use","name":"Read","input":{"file_path":"src/router.ts"}}]}}';

  it('extracts tool_use names from assistant content blocks', () => {
    expect(extractToolUseNames(jmTranscript)).toEqual(['mcp__jcodemunch__search_symbols']);
  });
  it('ignores text blocks and non-assistant lines', () => {
    const names = extractToolUseNames(bashTranscript);
    expect(names).toEqual(['Bash', 'Read']);
    expect(names).not.toContain('mcp__jcodemunch__search_symbols');
  });
  it('matchJcodemunchUsed is true when a jcodemunch tool was invoked', () => {
    expect(matchJcodemunchUsed(extractToolUseNames(jmTranscript))).toBe(true);
  });
  it('matchJcodemunchUsed is false when only non-jcodemunch tools ran', () => {
    expect(matchJcodemunchUsed(extractToolUseNames(bashTranscript))).toBe(false);
    expect(matchJcodemunchUsed([])).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { buildClaudeArgs, sessionFragmentOwnedBy } from '../../evals/session-driver.js';

describe('drive: claude args', () => {
  it('builds headless stream-json args with model and permission bypass', () => {
    const a = buildClaudeArgs('do X', 'claude-opus-4-8');
    expect(a).toContain('-p');
    expect(a).toContain('do X');
    expect(a.join(' ')).toContain('--model claude-opus-4-8');
    expect(a.join(' ')).toContain('--output-format stream-json');
    expect(a).toContain('--dangerously-skip-permissions');
  });
});

describe('drive: session-fragment ownership (data-loss guard)', () => {
  const TEMP = '/private/var/folders/x/rig-eval-AbCdEf';
  it('owns a fragment whose cwd equals the temp dir', () => {
    expect(sessionFragmentOwnedBy(JSON.stringify({ cwd: TEMP }), [TEMP])).toBe(true);
  });
  it('does NOT own a foreign fragment that merely MENTIONS the temp dir', () => {
    // The exact data-loss path the reviewer proved: a main-repo cache whose
    // editedFiles/state mentions the temp path must not be tracked for deletion.
    const foreign = JSON.stringify({
      cwd: '/Users/jerome/tools/skills/claude-rig',
      editedFiles: { source: [`${TEMP}/src/x.ts`] },
    });
    expect(sessionFragmentOwnedBy(foreign, [TEMP])).toBe(false);
  });
  it('matches either the raw or the canonicalized temp dir', () => {
    expect(sessionFragmentOwnedBy(JSON.stringify({ cwd: '/var/folders/x/rig-eval-AbCdEf' }),
      ['/var/folders/x/rig-eval-AbCdEf', TEMP])).toBe(true);
  });
  it('fail-safe on malformed JSON (does not track)', () => {
    expect(sessionFragmentOwnedBy('{not json', [TEMP])).toBe(false);
  });
});

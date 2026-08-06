import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildClaudeArgs, sessionFragmentOwnedBy, materializeProjectFiles } from '../../evals/session-driver.js';

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

describe('drive: materializeProjectFiles', () => {
  it('copies fixture files into the temp project, creating parent dirs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rig-eval-files-'));
    try {
      materializeProjectFiles(dir, [
        { dest: 'src/router.ts', src: 'evals/fixtures/divert-project/src/router.ts' },
        { dest: 'BRIEF.md', src: 'evals/fixtures/divert-positive.md' },
      ]);
      expect(existsSync(join(dir, 'src/router.ts'))).toBe(true);
      expect(existsSync(join(dir, 'BRIEF.md'))).toBe(true);
      // Content is copied verbatim (the divert target symbol is present).
      expect(readFileSync(join(dir, 'src/router.ts'), 'utf-8')).toContain('routeRequest');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op for a scenario with no project files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rig-eval-empty-'));
    try {
      materializeProjectFiles(dir, []);
      expect(existsSync(join(dir, 'src/router.ts'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

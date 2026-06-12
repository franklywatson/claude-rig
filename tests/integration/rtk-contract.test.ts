import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { makeDefaultExecRewrite } from '../../src/router/hook.js';

/**
 * Contract-drift detector for the installed rtk binary.
 *
 * rig depends on rtk's rewrite exit-code protocol (rtk src/hooks/rewrite_cmd.rs):
 *
 *   0 + stdout  rewrite, safe to auto-allow
 *   1           no RTK equivalent
 *   2           deny rule matched
 *   3 + stdout  "Ask" verdict — rewrite valid, must not be auto-allowed
 *
 * This drifted once already: rtk 0.39.0 introduced exit 3 for Ask/Default
 * verdicts (which covers all git commands), and rig silently dropped every
 * git rewrite in the field until the diag log surfaced it. These tests probe
 * the real binary so the next protocol change fails at dev/CI time instead.
 *
 * Skipped entirely when rtk is not on PATH (e.g. bare CI runners).
 */

function rtkPath(): string | null {
  const result = spawnSync('which', ['rtk'], { encoding: 'utf-8' });
  const path = result.status === 0 ? result.stdout.trim() : '';
  return path || null;
}

const RTK = rtkPath();
const KNOWN_EXIT_CODES = [0, 1, 2, 3];

function rewrite(command: string): { status: number | null; stdout: string } {
  const result = spawnSync(RTK!, ['rewrite', command], {
    encoding: 'utf-8',
    timeout: 10_000,
  });
  return { status: result.status, stdout: (result.stdout ?? '').trim() };
}

describe.skipIf(!RTK)('rtk rewrite exit-code contract (installed binary)', () => {
  it('exits within the known protocol codes for representative commands', () => {
    const probes = [
      'grep -r "TODO" src/',
      'cat src/main.ts',
      'git status',
      'git log --oneline -5',
      'find . -name "*.ts"',
      'npm test', // expected: no RTK equivalent
    ];
    for (const cmd of probes) {
      const { status } = rewrite(cmd);
      expect(
        KNOWN_EXIT_CODES,
        `rtk rewrite "${cmd}" exited ${status} — protocol drift; update makeDefaultExecRewrite and this test`,
      ).toContain(status);
    }
  });

  it('produces a rewrite on stdout whenever it exits 0 or 3', () => {
    for (const cmd of ['grep -r "TODO" src/', 'cat src/main.ts', 'git status']) {
      const { status, stdout } = rewrite(cmd);
      if (status === 0 || status === 3) {
        expect(stdout, `rtk rewrite "${cmd}" exited ${status} but printed no rewrite`).not.toBe('');
        expect(stdout.startsWith('rtk '), `rewrite of "${cmd}" was "${stdout}"`).toBe(true);
      }
    }
  });

  it('produces no rewrite on exit 1 (no RTK equivalent)', () => {
    const { status, stdout } = rewrite('npm test');
    if (status === 1) {
      expect(stdout).toBe('');
    }
  });

  it('makeDefaultExecRewrite recovers a git rewrite end-to-end', () => {
    // The field regression: git maps to rtk's Ask verdict (exit 3 + stdout).
    // rig must still use that rewrite.
    const diagLines: string[] = [];
    const execRewrite = makeDefaultExecRewrite(line => diagLines.push(line));
    const result = execRewrite(RTK!, ['rewrite', 'git status']);

    expect(result).toBe('rtk git status');
    expect(diagLines).toEqual([]);
  });

  it('makeDefaultExecRewrite recovers a grep rewrite end-to-end', () => {
    const diagLines: string[] = [];
    const execRewrite = makeDefaultExecRewrite(line => diagLines.push(line));
    const result = execRewrite(RTK!, ['rewrite', 'grep -r "TODO" src/']);

    expect(result).not.toBeNull();
    expect(result!.startsWith('rtk grep')).toBe(true);
    expect(diagLines).toEqual([]);
  });
});

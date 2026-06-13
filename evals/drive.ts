// Live claude -p driver: scaffold a temp project → rig init → run brain+
// headlessly → capture stream-json → track artifacts for teardown. Not imported
// by unit tests (only buildClaudeArgs is pure-tested); exercised via `npm run eval`.

import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import type { Scenario } from './types.js';
import type { DriveSessionFn, Judge } from './runner.js';
import { TeardownRegistry } from './runner.js';
import { judgeNegative } from './grade.js';

export function buildClaudeArgs(prompt: string, model: string): string[] {
  return [
    '-p',
    prompt,
    '--model',
    model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
  ];
}

/** Track /tmp/rig-session-*.json fragments whose cwd is inside `dir` (exact
 *  paths only — never glob-deletes a foreign session cache). */
function trackSessionFragments(dir: string, reg: TeardownRegistry): void {
  let entries: string[];
  try {
    entries = readdirSync('/tmp').filter((f) => f.startsWith('rig-session-') && f.endsWith('.json'));
  } catch {
    return;
  }
  for (const f of entries) {
    const p = join('/tmp', f);
    try {
      if (readFileSync(p, 'utf-8').includes(dir)) reg.track(p);
    } catch {
      // ignore unreadable/race-deleted fragments
    }
  }
}

export function makeLiveDriver(reg: TeardownRegistry, timeoutMs = 300000): DriveSessionFn {
  return async (scenario: Scenario, model: string): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), 'rig-eval-'));
    reg.track(dir);
    execFileSync('rig', ['init'], { cwd: dir, stdio: 'ignore' });
    writeFileSync(join(dir, 'BRIEF.md'), readFileSync(join(process.cwd(), scenario.briefFile), 'utf-8'));
    const out = execFileSync('claude', buildClaudeArgs(scenario.prompt, model), {
      cwd: dir,
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    trackSessionFragments(dir, reg);
    return out;
  };
}

/** Live judge: a plain headless claude call (no skill) returning a verdict. */
export function makeJudge(model: string, timeoutMs = 120000): Judge {
  const drive = async (prompt: string): Promise<string> => {
    return execFileSync('claude', ['-p', prompt, '--model', model, '--dangerously-skip-permissions'], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
  };
  return (transcript: string) => judgeNegative(transcript, drive);
}

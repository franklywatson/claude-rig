// Live claude -p driver: scaffold a temp project → rig init → run brain+
// headlessly → capture stream-json → track artifacts for teardown. Not imported
// by unit tests (only buildClaudeArgs is pure-tested); exercised via `npm run eval`.

import { mkdtempSync, writeFileSync, readFileSync, readdirSync, realpathSync } from 'fs';
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

/**
 * Ownership predicate for a session-cache fragment. Returns true only when the
 * fragment's `cwd` field EQUALS one of `ownedDirs` — never a substring match
 * over the whole file. A foreign cache (e.g. the orchestrator's own) can
 * *mention* the temp dir in its recorded state (edited-file lists, env paths);
 * matching raw content would track it for deletion — a data-loss path. Keying
 * on the `cwd` field is ownership, not mention.
 */
export function sessionFragmentOwnedBy(jsonContent: string, ownedDirs: string[]): boolean {
  let parsed: { cwd?: unknown };
  try {
    parsed = JSON.parse(jsonContent) as { cwd?: unknown };
  } catch {
    return false;
  }
  return typeof parsed.cwd === 'string' && ownedDirs.includes(parsed.cwd);
}

/** Track /tmp/rig-session-*.json fragments OWNED BY `dir` (cwd-equality, not a
 *  content substring) so teardown can never delete a foreign session cache. */
function trackSessionFragments(dir: string, reg: TeardownRegistry): void {
  const owned = [dir];
  // macOS: /var/folders/... canonicalizes to /private/var/folders/...; the
  // session cache stores the realpath'd cwd, so match both forms.
  try {
    const real = realpathSync(dir);
    if (real !== dir) owned.push(real);
  } catch {
    // dir may already be gone; the raw form still suffices
  }
  let entries: string[];
  try {
    entries = readdirSync('/tmp').filter((f) => f.startsWith('rig-session-') && f.endsWith('.json'));
  } catch {
    return;
  }
  for (const f of entries) {
    const p = join('/tmp', f);
    try {
      if (sessionFragmentOwnedBy(readFileSync(p, 'utf-8'), owned)) reg.track(p);
    } catch {
      // ignore unreadable/race-deleted fragments
    }
  }
}

export function makeLiveDriver(reg: TeardownRegistry, timeoutMs = 300000): DriveSessionFn {
  return async (scenario: Scenario, model: string): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), 'rig-eval-'));
    reg.track(dir);
    // Pin the nested session's CLAUDE_PROJECT_DIR to the temp dir so its rig
    // hooks key their session cache to the temp project — not to this
    // orchestrator's repo (inherited from the parent env). This keeps the
    // nested fragment self-contained and reclaimable by cwd-ownership teardown.
    const env = { ...process.env, CLAUDE_PROJECT_DIR: dir };
    execFileSync('rig', ['init'], { cwd: dir, stdio: 'ignore', env });
    writeFileSync(join(dir, 'BRIEF.md'), readFileSync(join(process.cwd(), scenario.briefFile), 'utf-8'));
    const out = execFileSync('claude', buildClaudeArgs(scenario.prompt, model), {
      cwd: dir,
      env,
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

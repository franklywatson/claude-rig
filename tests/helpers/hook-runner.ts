import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Absolute path to the locally-installed tsx CLI. Resolving it from this file's
// own location (not the subprocess cwd) keeps the spawn independent of where the
// hook runs — the scaffolded tempDir projects under test have no node_modules.
export const TSX_BIN = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));
import type { Environment, MetricsBaseline, SessionCacheFile } from '../../src/types.js';
import { sessionCachePath } from '../../src/session/cache.js';

export interface HookResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Terminating signal when the subprocess was killed (code === null), else null. */
  signal: NodeJS.Signals | null;
}

/**
 * Run a hook script as a subprocess, piping JSON input via stdin.
 * Returns captured stdout, stderr, and exit code.
 */
export function runHook(
  hookScriptPath: string,
  input: Record<string, unknown>,
  cwd: string,
): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    // Strip V8 coverage env vars to prevent coverage instrumentation
    // from interfering with subprocess exit codes. NODE_NO_WARNINGS silences
    // the loader's ExperimentalWarning so it can't leak into asserted stderr.
    const { NODE_V8_COVERAGE, ...cleanEnv } = process.env;
    // Run the hook through this same Node binary plus the locally-installed tsx
    // CLI (absolute path) — NOT `npx tsx`. `npx tsx` resolves tsx from the npx
    // cache and installs it on a cold cache (CI), so parallel test workers could
    // race that install and the spawn would exit 1 (or be signal-killed →
    // coerced to 1), surfacing as a flaky "expected 1 to be 2". tsx is a
    // devDependency, so this runs deterministically with no network or cache
    // race, and the absolute TSX_BIN makes resolution independent of `cwd`.
    const child = spawn(process.execPath, [TSX_BIN, hookScriptPath], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...cleanEnv, NODE_NO_WARNINGS: '1' },
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

    child.on('close', (code, signal) => {
      // The hook itself only ever exits 0 (clean/advise) or 2 (block). Any other
      // outcome is a subprocess infrastructure failure: a non-zero crash, or a
      // signal kill (code === null, coerced to 1). Surface the signal so such a
      // failure is debuggable instead of an opaque "expected 1 to be 2".
      resolve({ stdout, stderr, exitCode: code ?? 1, signal: signal ?? null });
    });

    child.on('error', (err) => {
      reject(err);
    });

    // Send input and close stdin
    child.stdin?.write(JSON.stringify(input));
    child.stdin?.end();
  });
}

/**
 * Read the session cache file for a given cwd (for test assertions).
 */
export function readSessionCache(cwd: string): SessionCacheFile | null {
  try {
    const { readFileSync } = require('node:fs');
    const raw = readFileSync(sessionCachePath(cwd), 'utf-8');
    return JSON.parse(raw) as SessionCacheFile;
  } catch {
    return null;
  }
}

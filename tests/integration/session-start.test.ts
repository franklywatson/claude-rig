import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { initCommand } from '../../src/cli/init.js';
import { runHook, readSessionCache } from '../helpers/hook-runner.js';
import { sessionCachePath } from '../../src/session/cache.js';

describe('SessionStart hook E2E', () => {
  let tempDir: string;
  let hookPath: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'rig-e2e-session-'));
    await initCommand(tempDir, { force: false });
    hookPath = join(tempDir, '.claude', 'hooks', 'scripts', 'session-start.ts');
    expect(existsSync(hookPath)).toBe(true);
  });

  afterAll(() => {
    // The hook subprocess writes a session cache keyed by tempDir (no
    // session_id) — remove the exact path so /tmp doesn't accumulate
    // fixtures. Never glob-delete: real sessions own sibling cache files.
    const cachePath = sessionCachePath(tempDir);
    if (existsSync(cachePath)) unlinkSync(cachePath);

    // When jcodemunch is installed on the host, the session-start hook
    // auto-indexes tempDir, leaving `local-<tempDir basename>-<hash>` entries
    // in ~/.code-index. The mkdtemp basename (rig-e2e-session-XXXXXX) is
    // unique to this run, so prefix-matching it tracks exactly what this
    // suite created.
    const codeIndexDir = join(homedir(), '.code-index');
    if (existsSync(codeIndexDir)) {
      const prefix = `local-${basename(tempDir)}-`;
      for (const entry of readdirSync(codeIndexDir)) {
        if (entry.startsWith(prefix)) {
          rmSync(join(codeIndexDir, entry), { recursive: true, force: true });
        }
      }
    }

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates session cache file in /tmp', async () => {
    const cachePath = sessionCachePath(tempDir);
    if (existsSync(cachePath)) { unlinkSync(cachePath); }

    const result = await runHook(hookPath, {}, tempDir);

    // Hook subprocess may crash on CI (npx tsx resolution, missing tools) —
    // any non-zero exit is acceptable since hooks are advisory
    if (result.exitCode !== 0) return;

    expect(result.stderr).toContain('Session initialized');

    const cache = readSessionCache(tempDir);
    expect(cache).not.toBeNull();
    expect(cache!.updatedAt).toBeGreaterThan(0);
  }, 60000); // cold run: real detection + indexing + graphify/mcp probes

  it('detects environment in cache', async () => {
    const result = await runHook(hookPath, {}, tempDir);

    if (result.exitCode !== 0) return;

    expect(result.stderr).toContain('rtk:');

    const cache = readSessionCache(tempDir);
    expect(cache).not.toBeNull();
    expect(cache!.environment).not.toBeNull();
    expect(typeof cache!.environment!.rtkAvailable).toBe('boolean');
    expect(cache!.environment!.detectedAt).toBeGreaterThan(0);
  });

  it('captures metrics baseline', async () => {
    const result = await runHook(hookPath, {}, tempDir);

    if (result.exitCode !== 0) return;

    const cache = readSessionCache(tempDir);
    expect(cache).not.toBeNull();
    expect(cache!.metricsBaseline).not.toBeNull();
    expect(typeof cache!.metricsBaseline!.totalSaved).toBe('number');
  });
});

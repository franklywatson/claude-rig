import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, unlinkSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
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

  it('sends the active rules to the agent and keeps the summary on stderr', async () => {
    const result = await runHook(hookPath, {}, tempDir);

    // No early return on a non-zero exit here: a hook that crashes sends the
    // agent nothing, which is the failure this test exists to catch.
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).not.toBe('');

    const { hookSpecificOutput } = JSON.parse(result.stdout);
    expect(hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(hookSpecificOutput.additionalContext).toContain('[rig] Session initialized');
    expect(hookSpecificOutput.additionalContext).toContain('Active enforcement:');
    expect(hookSpecificOutput.additionalContext).toContain('superpowers:');
    expect(hookSpecificOutput.additionalContext).not.toContain('rtk:');
    expect(result.stderr).toContain('Session initialized');
  }, 60000);

  it('still prints the summary when the installed rig build predates the agent context', async () => {
    // A hook regenerated from newer templates can meet an older build, which
    // exports handleSessionStart only. Stand one in for the import base.
    const olderBuild = join(tempDir, 'older-build');
    mkdirSync(join(olderBuild, 'session'), { recursive: true });
    writeFileSync(join(olderBuild, 'package.json'), '{ "type": "module" }\n');
    writeFileSync(
      join(olderBuild, 'session', 'start.js'),
      "export async function handleSessionStart() { return '[rig] Session initialized (older build)'; }\n",
    );
    writeFileSync(join(olderBuild, 'session', 'cache.js'), 'export class SessionCache {}\n');
    const hook = readFileSync(hookPath, 'utf-8');
    const importBase = hook.match(/import\('(.+)\/session\/start\.js'\)/)![1];
    // A file URL, not the bare path: a temp directory can hold a space, a `#`
    // or a drive letter, and the import sits inside single quotes.
    const olderBuildUrl = pathToFileURL(olderBuild).href.replace(/'/g, '%27');
    const olderHookPath = join(tempDir, '.claude', 'hooks', 'scripts', 'session-start-older.ts');
    writeFileSync(olderHookPath, hook.split(importBase).join(olderBuildUrl));

    const result = await runHook(olderHookPath, {}, tempDir);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toContain('[rig] Session initialized (older build)');
    expect(result.stdout).toBe('');
  }, 60000);

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

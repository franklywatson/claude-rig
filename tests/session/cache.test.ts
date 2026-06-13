import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionCache, sessionCachePath } from '../../src/session/cache.js';
import type { Environment, PythonEnv, SessionCacheFile } from '../../src/types.js';
import { readFileSync, unlinkSync, existsSync, mkdtempSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeEnv(overrides: Partial<Environment> = {}): Environment {
  return {
    rtkAvailable: false,
    rtkPath: null,
    jcodemunchAvailable: false,
    jcodemunchCwdIndexed: false,
    jcodemunchCwdRepo: null,
    jcodemunchKnownRepos: [],
    graphifyAvailable: false,
    graphifyGraphPath: null,
    detectedAt: Date.now(),
    ...overrides,
  };
}

describe('SessionCache', () => {
  let cache: SessionCache;

  beforeEach(() => {
    cache = new SessionCache();
  });

  it('returns undefined when environment not set', () => {
    expect(cache.getEnvironment()).toBeUndefined();
  });

  it('stores and retrieves environment', () => {
    const env = makeEnv({ rtkAvailable: true });
    cache.setEnvironment(env);
    expect(cache.getEnvironment()).toEqual(env);
  });

  it('reports environment as stale after TTL expires', () => {
    const env = makeEnv({ detectedAt: Date.now() - 5 * 60 * 60 * 1000 }); // 5 hours ago (> 4h TTL)
    cache.setEnvironment(env);
    expect(cache.isEnvironmentStale()).toBe(true);
  });

  it('reports environment as fresh within TTL', () => {
    const env = makeEnv({ detectedAt: Date.now() });
    cache.setEnvironment(env);
    expect(cache.isEnvironmentStale()).toBe(false);
  });

  it('tracks edited source files', () => {
    cache.addEditedFile('src/router/resolver.ts', 'source');
    cache.addEditedFile('src/enforcement/zero-defect.ts', 'source');
    expect(cache.getEditedFiles('source')).toEqual([
      'src/router/resolver.ts',
      'src/enforcement/zero-defect.ts',
    ]);
  });

  it('tracks edited test files separately', () => {
    cache.addEditedFile('tests/router/resolver.test.ts', 'test');
    cache.addEditedFile('src/router/resolver.ts', 'source');
    expect(cache.getEditedFiles('test')).toEqual(['tests/router/resolver.test.ts']);
    expect(cache.getEditedFiles('source')).toEqual(['src/router/resolver.ts']);
  });

  it('tracks current skill phase', () => {
    expect(cache.getCurrentPhase()).toBeNull();
    cache.setPhase('tdd+');
    expect(cache.getCurrentPhase()).toBe('tdd+');
  });

  it('clears edited files for both categories via clearEditedFiles', () => {
    cache.addEditedFile('src/router/resolver.ts', 'source');
    cache.addEditedFile('tests/router/resolver.test.ts', 'test');
    cache.clearEditedFiles();
    expect(cache.getEditedFiles('source')).toEqual([]);
    expect(cache.getEditedFiles('test')).toEqual([]);
  });

  it('clears all state on reset', () => {
    cache.setEnvironment(makeEnv());
    cache.addEditedFile('src/foo.ts', 'source');
    cache.setPhase('tdd+');
    cache.reset();
    expect(cache.getEnvironment()).toBeUndefined();
    expect(cache.getEditedFiles('source')).toEqual([]);
    expect(cache.getCurrentPhase()).toBeNull();
  });

  it('stores and retrieves Python env', () => {
    expect(cache.getPythonEnv()).toBeUndefined();
    const pyEnv: PythonEnv = { venvPath: '/project/.venv', uvAvailable: true, uvPath: '/usr/bin/uv', detectedAt: Date.now() };
    cache.setPythonEnv(pyEnv);
    expect(cache.getPythonEnv()).toEqual(pyEnv);
  });

  it('clears Python env on reset', () => {
    cache.setPythonEnv({ venvPath: '/project/.venv', uvAvailable: false, uvPath: null, detectedAt: Date.now() });
    cache.reset();
    expect(cache.getPythonEnv()).toBeUndefined();
  });

  it('stores and retrieves metrics baseline', () => {
    const cache = new SessionCache();
    expect(cache.getMetricsBaseline()).toBeUndefined();
    cache.setMetricsBaseline({ totalSaved: 1000000, capturedAt: Date.now() });
    const baseline = cache.getMetricsBaseline();
    expect(baseline).toBeDefined();
    expect(baseline!.totalSaved).toBe(1000000);
  });

  it('stores and increments metric counters', () => {
    const cache = new SessionCache();
    expect(cache.getMetricCounters()).toEqual({ rtkCalls: 0, jmCalls: 0, efficientCalls: 0, graphifyCalls: 0 });
    cache.incrementMetricCounter('rtkCalls');
    cache.incrementMetricCounter('rtkCalls');
    cache.incrementMetricCounter('jmCalls');
    expect(cache.getMetricCounters()).toEqual({ rtkCalls: 2, jmCalls: 1, efficientCalls: 0, graphifyCalls: 0 });
  });

  describe('edit-turn counter and turn-stamped history (cross-process stale-test model)', () => {
    it('starts the edit turn counter at 0', () => {
      expect(cache.getEditTurn()).toBe(0);
    });

    it('advances the edit turn counter and returns the new value', () => {
      expect(cache.advanceEditTurn()).toBe(1);
      expect(cache.advanceEditTurn()).toBe(2);
      expect(cache.getEditTurn()).toBe(2);
    });

    it('records turn-stamped edits in history', () => {
      cache.recordEditTurn('src/router/resolver.ts', 1);
      cache.recordEditTurn('tests/router/resolver.test.ts', 2);
      expect(cache.getEditHistory()).toEqual([
        { file: 'src/router/resolver.ts', turn: 1 },
        { file: 'tests/router/resolver.test.ts', turn: 2 },
      ]);
    });

    it('clearEditedFiles clears the turn-stamped history too', () => {
      cache.recordEditTurn('src/a.ts', 1);
      cache.clearEditedFiles();
      expect(cache.getEditHistory()).toEqual([]);
    });

    it('reset clears the counter and history', () => {
      cache.advanceEditTurn();
      cache.recordEditTurn('src/a.ts', 1);
      cache.reset();
      expect(cache.getEditTurn()).toBe(0);
      expect(cache.getEditHistory()).toEqual([]);
    });
  });

  describe('shouldAdvise (advisory re-suppression)', () => {
    it('returns true on the first call for an intent', () => {
      expect(cache.shouldAdvise('native_grep')).toBe(true);
    });

    it('returns false on the second call (suppressed)', () => {
      cache.shouldAdvise('native_grep');
      expect(cache.shouldAdvise('native_grep')).toBe(false);
    });

    it('stays suppressed through the 10th call, re-advises on the 11th', () => {
      expect(cache.shouldAdvise('native_grep')).toBe(true); // call 1
      for (let call = 2; call <= 10; call++) {
        expect(cache.shouldAdvise('native_grep')).toBe(false); // calls 2-10
      }
      expect(cache.shouldAdvise('native_grep')).toBe(true); // call 11 — re-advisory
      expect(cache.shouldAdvise('native_grep')).toBe(false); // call 12 — cycle restarts
    });

    it('tracks suppression counters independently per intent', () => {
      expect(cache.shouldAdvise('native_grep')).toBe(true);
      expect(cache.shouldAdvise('native_read')).toBe(true);
      expect(cache.shouldAdvise('native_grep')).toBe(false);
      expect(cache.shouldAdvise('native_read')).toBe(false);
    });

    it('marks the intent as advised (hasAdvised stays a pure query)', () => {
      expect(cache.hasAdvised('native_grep')).toBe(false);
      cache.shouldAdvise('native_grep');
      expect(cache.hasAdvised('native_grep')).toBe(true);
      // hasAdvised does not mutate the counter
      cache.hasAdvised('native_grep');
      expect(cache.shouldAdvise('native_grep')).toBe(false); // call 2, not call 3
    });

    it('clears suppression counters on reset', () => {
      cache.shouldAdvise('native_grep');
      cache.shouldAdvise('native_grep');
      cache.reset();
      expect(cache.shouldAdvise('native_grep')).toBe(true);
    });
  });

  describe('updateStaleKey (stale-test advisory dedup)', () => {
    it('returns true on the first set and when the set changes, false when unchanged', () => {
      expect(cache.updateStaleKey('a')).toBe(true);   // first non-empty set
      expect(cache.updateStaleKey('a')).toBe(false);  // unchanged → suppress repeat
      expect(cache.updateStaleKey('a|b')).toBe(true); // a new file joined the set
      expect(cache.updateStaleKey('a|b')).toBe(false);
    });

    it('treats the empty set as a reset so a re-introduced set re-fires', () => {
      expect(cache.updateStaleKey('a')).toBe(true);
      expect(cache.updateStaleKey('')).toBe(true);    // set cleared (all covered)
      expect(cache.updateStaleKey('')).toBe(false);   // still empty
      expect(cache.updateStaleKey('a')).toBe(true);   // same set, but after a clear → re-fire
    });

    it('clears the stale key on reset', () => {
      cache.updateStaleKey('a');
      cache.reset();
      expect(cache.updateStaleKey('a')).toBe(true);
    });
  });

  describe('transaction (batched writes)', () => {
    it('returns the callback result', () => {
      expect(cache.transaction(() => 42)).toBe(42);
    });
  });
});

describe('SessionCache (file-backed)', () => {
  const testCwd = '/tmp/rig-test-cache-' + process.pid;
  let cleanupPaths: string[] = [];

  afterEach(() => {
    for (const p of cleanupPaths) {
      try { unlinkSync(p); } catch { /* already gone */ }
    }
    cleanupPaths = [];
  });

  function trackPath(path: string): string {
    cleanupPaths.push(path);
    return path;
  }

  it('persists the edit-turn counter and history across instances (hook processes)', () => {
    trackPath(sessionCachePath(testCwd));
    const first = new SessionCache(testCwd);
    const turn = first.advanceEditTurn();
    first.recordEditTurn('src/feature/widget.ts', turn);

    // A later hook invocation (separate process) loads from disk.
    const second = new SessionCache(testCwd);
    expect(second.getEditTurn()).toBe(1);
    expect(second.getEditHistory()).toEqual([
      { file: 'src/feature/widget.ts', turn: 1 },
    ]);
    expect(second.advanceEditTurn()).toBe(2);
  });

  it('transaction batches writes — disk stays at the pre-transaction state until it ends', () => {
    const path = trackPath(sessionCachePath(testCwd));
    const cache = new SessionCache(testCwd);
    cache.setPhase('plan+'); // committed to disk before the transaction
    cache.transaction(() => {
      cache.setPhase('tdd+');
      cache.advanceEditTurn();
      // Mid-transaction: intermediate saves are suppressed, so disk is stale.
      const onDisk = JSON.parse(readFileSync(path, 'utf-8')) as SessionCacheFile;
      expect(onDisk.currentPhase).toBe('plan+');
      expect(onDisk.editTurnCounter).toBe(0);
    });
    // After the transaction: a fresh hook process sees the committed state.
    const reloaded = new SessionCache(testCwd);
    expect(reloaded.getCurrentPhase()).toBe('tdd+');
    expect(reloaded.getEditTurn()).toBe(1);
  });

  it('generates deterministic path from cwd', () => {
    const path = sessionCachePath(testCwd);
    expect(path).toMatch(/^\/tmp\/rig-session-[a-f0-9]{12}\.json$/);
    // Same cwd produces same path
    expect(sessionCachePath(testCwd)).toBe(path);
    // Different cwd produces different path
    expect(sessionCachePath('/other/path')).not.toBe(path);
  });

  it('canonicalizes cwd through symlinks (portable across mac and linux)', () => {
    // Create a real directory and a symlink pointing at it. On macOS, this
    // also mirrors the /var → /private/var quirk that breaks cache lookups
    // when subprocesses report process.cwd() as the resolved path while
    // callers pass the unresolved path. On Linux the symlink behavior is
    // identical: both inputs must hash to the same cache file.
    const realDir = mkdtempSync(join(tmpdir(), 'rig-cache-real-'));
    const linkParent = mkdtempSync(join(tmpdir(), 'rig-cache-link-'));
    const linkPath = join(linkParent, 'alias');
    symlinkSync(realDir, linkPath, 'dir');
    try {
      const resolved = realpathSync(linkPath);
      expect(resolved).toBe(realpathSync(realDir));
      // Both the symlink path and the real path must resolve to the same
      // cache file so the SessionStart subprocess and any in-process reader
      // agree, regardless of which form was passed in.
      expect(sessionCachePath(linkPath)).toBe(sessionCachePath(realDir));
      expect(sessionCachePath(linkPath, 'sess')).toBe(sessionCachePath(realDir, 'sess'));
    } finally {
      try { unlinkSync(linkPath); } catch { /* ignore */ }
      rmSync(realDir, { recursive: true, force: true });
      rmSync(linkParent, { recursive: true, force: true });
    }
  });

  it('falls back to the raw path when realpath fails (synthetic paths)', () => {
    // Non-existent paths must still produce a deterministic hash for callers
    // that pass purely synthetic identifiers — realpathSync will throw and we
    // should silently fall back. Regression coverage for the catch branch.
    const synthetic = '/does/not/exist/' + process.pid;
    const p1 = sessionCachePath(synthetic);
    const p2 = sessionCachePath(synthetic);
    expect(p1).toBe(p2);
    expect(p1).toMatch(/^\/tmp\/rig-session-[a-f0-9]{12}\.json$/);
  });

  it('isolates cache paths by session_id', () => {
    const pathA = sessionCachePath(testCwd, 'session-aaa');
    const pathB = sessionCachePath(testCwd, 'session-bbb');
    const pathNoSession = sessionCachePath(testCwd);
    // All three should be different
    expect(pathA).not.toBe(pathB);
    expect(pathA).not.toBe(pathNoSession);
    expect(pathB).not.toBe(pathNoSession);
    // Same session_id produces same path
    expect(sessionCachePath(testCwd, 'session-aaa')).toBe(pathA);
  });

  it('isolates concurrent sessions in same project', () => {
    const sessionIdA = 'aaaaaaaa-1111-1111-1111-111111111111';
    const sessionIdB = 'bbbbbbbb-2222-2222-2222-222222222222';

    const cacheA = new SessionCache(testCwd, sessionIdA);
    const cacheB = new SessionCache(testCwd, sessionIdB);

    cacheA.setPhase('tdd+');
    cacheA.incrementMetricCounter('rtkCalls');

    // cacheB should not see cacheA's state
    expect(cacheB.getCurrentPhase()).toBeNull();
    expect(cacheB.getMetricCounters()).toEqual({ rtkCalls: 0, jmCalls: 0, efficientCalls: 0, graphifyCalls: 0 });

    // cacheA should retain its state
    expect(cacheA.getCurrentPhase()).toBe('tdd+');
    expect(cacheA.getMetricCounters()).toEqual({ rtkCalls: 1, jmCalls: 0, efficientCalls: 0, graphifyCalls: 0 });

    trackPath(sessionCachePath(testCwd, sessionIdA));
    trackPath(sessionCachePath(testCwd, sessionIdB));
  });

  it('loads fresh cache when no file exists', () => {
    const path = sessionCachePath(testCwd);
    if (existsSync(path)) { unlinkSync(path); }
    const cache = new SessionCache(testCwd);
    expect(cache.getEnvironment()).toBeUndefined();
    expect(cache.getEditedFiles('source')).toEqual([]);
    expect(cache.getCurrentPhase()).toBeNull();
    expect(cache.getMetricCounters()).toEqual({ rtkCalls: 0, jmCalls: 0, efficientCalls: 0, graphifyCalls: 0 });
  });

  it('saves and round-trips all fields', () => {
    const cache = new SessionCache(testCwd);
    cache.setEnvironment(makeEnv({ rtkAvailable: true, rtkPath: '/usr/bin/rtk' }));
    cache.addEditedFile('src/foo.ts', 'source');
    cache.addEditedFile('tests/foo.test.ts', 'test');
    cache.setPhase('plan+');
    cache.setMetricsBaseline({ totalSaved: 50000, capturedAt: Date.now() });
    cache.incrementMetricCounter('rtkCalls');
    cache.setPythonEnv({ venvPath: '/project/.venv', uvAvailable: true, uvPath: '/usr/bin/uv', detectedAt: Date.now() });

    // Verify file was written
    const path = sessionCachePath(testCwd);
    expect(existsSync(path)).toBe(true);
    trackPath(path);

    // Load into a new cache instance
    const cache2 = new SessionCache(testCwd);
    expect(cache2.getEnvironment()).toBeDefined();
    expect(cache2.getEnvironment()!.rtkAvailable).toBe(true);
    expect(cache2.getEnvironment()!.rtkPath).toBe('/usr/bin/rtk');
    expect(cache2.getEditedFiles('source')).toEqual(['src/foo.ts']);
    expect(cache2.getEditedFiles('test')).toEqual(['tests/foo.test.ts']);
    expect(cache2.getCurrentPhase()).toBe('plan+');
    expect(cache2.getMetricsBaseline()!.totalSaved).toBe(50000);
    expect(cache2.getMetricCounters()).toEqual({ rtkCalls: 1, jmCalls: 0, efficientCalls: 0, graphifyCalls: 0 });
    expect(cache2.getPythonEnv()).toBeDefined();
    expect(cache2.getPythonEnv()!.venvPath).toBe('/project/.venv');
    expect(cache2.getPythonEnv()!.uvAvailable).toBe(true);
  });

  it('persists advisory suppression counters across cache instances', () => {
    const path = sessionCachePath(testCwd);
    if (existsSync(path)) { unlinkSync(path); }
    trackPath(path);

    const cache = new SessionCache(testCwd);
    expect(cache.shouldAdvise('native_grep')).toBe(true); // call 1
    expect(cache.shouldAdvise('native_grep')).toBe(false); // call 2
    expect(cache.shouldAdvise('native_grep')).toBe(false); // call 3

    // A fresh instance (separate hook process) continues the same sequence
    const cache2 = new SessionCache(testCwd);
    expect(cache2.hasAdvised('native_grep')).toBe(true);
    for (let call = 4; call <= 10; call++) {
      expect(cache2.shouldAdvise('native_grep')).toBe(false); // calls 4-10
    }
    expect(cache2.shouldAdvise('native_grep')).toBe(true); // call 11 — re-advisory
  });

  it('persists clearEditedFiles across instances', () => {
    const cache = new SessionCache(testCwd);
    cache.addEditedFile('src/foo.ts', 'source');
    cache.addEditedFile('tests/foo.test.ts', 'test');
    trackPath(sessionCachePath(testCwd));

    cache.clearEditedFiles();

    const cache2 = new SessionCache(testCwd);
    expect(cache2.getEditedFiles('source')).toEqual([]);
    expect(cache2.getEditedFiles('test')).toEqual([]);
  });

  it('retains stale environment on load as last-known-good', () => {
    // Regression: long-running sessions (>4h) used to lose their environment
    // on load, silently disabling all rtk/jcodemunch routing until the next
    // SessionStart. The stale env must be retained — tool availability rarely
    // changes mid-session, and a wrong rtkPath degrades gracefully (spawn
    // fails, command falls through). Staleness is reported via
    // isEnvironmentStale() so SessionStart still re-detects.
    const cache = new SessionCache(testCwd);
    cache.setEnvironment(makeEnv({
      rtkAvailable: true,
      rtkPath: '/usr/bin/rtk',
      detectedAt: Date.now() - 5 * 60 * 60 * 1000,
    }));
    const path = sessionCachePath(testCwd);
    trackPath(path);

    const cache2 = new SessionCache(testCwd);
    expect(cache2.getEnvironment()).toBeDefined();
    expect(cache2.getEnvironment()!.rtkAvailable).toBe(true);
    expect(cache2.getEnvironment()!.rtkPath).toBe('/usr/bin/rtk');
    expect(cache2.isEnvironmentStale()).toBe(true);
  });

  it('retains a days-old environment on load', () => {
    const cache = new SessionCache(testCwd);
    cache.setEnvironment(makeEnv({
      rtkAvailable: true,
      rtkPath: '/usr/bin/rtk',
      detectedAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
    }));
    trackPath(sessionCachePath(testCwd));

    const cache2 = new SessionCache(testCwd);
    expect(cache2.getEnvironment()?.rtkAvailable).toBe(true);
    expect(cache2.isEnvironmentStale()).toBe(true);
  });

  it('preserves fresh environment on load', () => {
    const cache = new SessionCache(testCwd);
    cache.setEnvironment(makeEnv({ detectedAt: Date.now() }));
    const path = sessionCachePath(testCwd);
    trackPath(path);

    const cache2 = new SessionCache(testCwd);
    expect(cache2.getEnvironment()).toBeDefined();
    expect(cache2.getEnvironment()!.rtkAvailable).toBe(false);
  });

  it('works in-memory when no cwd provided', () => {
    const cache = new SessionCache();
    cache.setEnvironment(makeEnv());
    cache.addEditedFile('src/foo.ts', 'source');
    // No file should be written
    expect(cache.getEnvironment()).toBeDefined();
    expect(cache.getEditedFiles('source')).toEqual(['src/foo.ts']);
  });

  it('stores and retrieves per-directory graphify stats', () => {
    const cache = new SessionCache();
    const stats = {
      '/home/user/project-a': {
        nodes: 100, edges: 200, communities: 5,
        extractedPct: 90, inferredPct: 10, ambiguousPct: 0,
      },
    };
    cache.setGraphifyStats('/home/user/project-a', stats['/home/user/project-a']);
    expect(cache.getGraphifyStats('/home/user/project-a')).toEqual(stats['/home/user/project-a']);
    expect(cache.getGraphifyStats('/home/user/project-b')).toBeUndefined();
  });

  it('accumulates stats across multiple directories', () => {
    const cache = new SessionCache();
    const statsA = { nodes: 100, edges: 200, communities: 5, extractedPct: 90, inferredPct: 10, ambiguousPct: 0 };
    const statsB = { nodes: 50, edges: 80, communities: 3, extractedPct: 80, inferredPct: 20, ambiguousPct: 0 };
    cache.setGraphifyStats('/home/user/project-a', statsA);
    cache.setGraphifyStats('/home/user/project-b', statsB);
    expect(cache.getGraphifyStats('/home/user/project-a')).toEqual(statsA);
    expect(cache.getGraphifyStats('/home/user/project-b')).toEqual(statsB);
    expect(cache.getAllGraphifyStats()).toEqual({
      '/home/user/project-a': statsA,
      '/home/user/project-b': statsB,
    });
  });

  it('preserves graphify stats across cache round-trip', () => {
    const cache = new SessionCache(testCwd);
    const stats = { nodes: 287, edges: 385, communities: 52, extractedPct: 84, inferredPct: 16, ambiguousPct: 0 };
    cache.setGraphifyStats('/home/user/claude-rig', stats);

    const path = sessionCachePath(testCwd);
    trackPath(path);

    const cache2 = new SessionCache(testCwd);
    expect(cache2.getGraphifyStats('/home/user/claude-rig')).toEqual(stats);
  });

  it('serializes to valid JSON with expected structure', () => {
    const cache = new SessionCache(testCwd);
    cache.setEnvironment(makeEnv());
    cache.setPhase('tdd+');

    const path = sessionCachePath(testCwd);
    trackPath(path);
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as SessionCacheFile;

    expect(parsed.updatedAt).toBeGreaterThan(0);
    expect(parsed.environment).toBeDefined();
    expect(parsed.editedFiles).toEqual({});
    expect(parsed.currentPhase).toBe('tdd+');
    expect(parsed.metricsBaseline).toBeNull();
    expect(parsed.metricCounters).toEqual({ rtkCalls: 0, jmCalls: 0, efficientCalls: 0, graphifyCalls: 0 });
  });

  it('includes cwd in serialized cache file', () => {
    const cache = new SessionCache(testCwd);
    cache.setEnvironment(makeEnv());

    const path = sessionCachePath(testCwd);
    trackPath(path);
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as SessionCacheFile;

    expect(parsed.cwd).toBe(testCwd);
  });

  it('persists cwd across save and load', () => {
    const cache = new SessionCache(testCwd);
    cache.setEnvironment(makeEnv());
    const path = sessionCachePath(testCwd);
    trackPath(path);

    const cache2 = new SessionCache(testCwd);
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as SessionCacheFile;
    expect(parsed.cwd).toBe(testCwd);
  });

  it('sets cwd to null when no cwd provided', () => {
    const cache = new SessionCache();
    cache.setEnvironment(makeEnv());
    // In-memory only, no file — verify via getCacheCwd
    expect(cache.getCwd()).toBeUndefined();
  });
});

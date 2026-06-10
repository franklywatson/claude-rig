import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  determineGraphState,
  triggerBuild,
  waitForBuild,
  ensureGraphReady,
} from '../../src/scout/graph-state.js';
import type { Environment, GraphBuildInfo } from '../../src/types.js';

// ── determineGraphState ──

describe('determineGraphState', () => {
  it('returns absent when graph.json does not exist', () => {
    const result = determineGraphState('/project', () => false, () => undefined);
    expect(result.state).toBe('absent');
    expect(result.graphPath).toBeUndefined();
  });

  it('returns absent when graph.json is smaller than 1KB (placeholder)', () => {
    const result = determineGraphState('/project', () => true, () => ({ size: 50 }));
    expect(result.state).toBe('absent');
    expect(result.graphPath).toBeUndefined();
  });

  it('returns ready when graph.json exists and is >= 1KB', () => {
    const result = determineGraphState('/project', () => true, () => ({ size: 5000 }));
    expect(result.state).toBe('ready');
    expect(result.graphPath).toBe('graphify-out/graph.json');
  });

  it('returns ready when graph.json is exactly 1024 bytes', () => {
    const result = determineGraphState('/project', () => true, () => ({ size: 1024 }));
    expect(result.state).toBe('ready');
    expect(result.graphPath).toBe('graphify-out/graph.json');
  });

  it('returns absent when graph.json is 1023 bytes', () => {
    const result = determineGraphState('/project', () => true, () => ({ size: 1023 }));
    expect(result.state).toBe('absent');
  });
});

// ── triggerBuild ──

describe('triggerBuild', () => {
  it('runs graphify update and returns building state with pid', () => {
    const mockExec = vi.fn(() => '');
    const result = triggerBuild('/project', mockExec as any);

    expect(result.state).toBe('building');
    expect(result.startedAt).toBeGreaterThan(0);
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('graphify update'),
      expect.objectContaining({ timeout: 120_000 }),
    );
  });

  it('returns failed state when exec throws', () => {
    const mockExec = vi.fn(() => { throw new Error('recursion depth'); });
    const result = triggerBuild('/project', mockExec as any);

    expect(result.state).toBe('failed');
    expect(result.graphPath).toBeUndefined();
  });

  it('preserves the error message on build failure', () => {
    const mockExec = vi.fn(() => {
      throw new Error('maximum recursion depth exceeded during tree-sitter traversal');
    });
    const result = triggerBuild('/project', mockExec as any);

    expect(result.state).toBe('failed');
    expect(result.errorReason).toBe('maximum recursion depth exceeded during tree-sitter traversal');
  });

  it('truncates very long error messages to 200 chars', () => {
    const mockExec = vi.fn(() => { throw new Error('x'.repeat(500)); });
    const result = triggerBuild('/project', mockExec as any);

    expect(result.errorReason).toHaveLength(200);
  });
});

// ── waitForBuild ──

describe('waitForBuild', () => {
  it('returns ready when graph.json now exists with real size', () => {
    const buildInfo: GraphBuildInfo = { state: 'building', startedAt: Date.now() };
    const result = waitForBuild(buildInfo, '/project', () => true, () => ({ size: 5000 }));

    expect(result.state).toBe('ready');
    expect(result.graphPath).toBe('graphify-out/graph.json');
  });

  it('returns failed when graph.json still absent after build', () => {
    const buildInfo: GraphBuildInfo = { state: 'building', startedAt: Date.now() };
    const result = waitForBuild(buildInfo, '/project', () => false, () => undefined);

    expect(result.state).toBe('failed');
  });

  it('returns failed when graph.json is still placeholder size', () => {
    const buildInfo: GraphBuildInfo = { state: 'building', startedAt: Date.now() };
    const result = waitForBuild(buildInfo, '/project', () => true, () => ({ size: 50 }));

    expect(result.state).toBe('failed');
  });

  it('explains the failure when the graph never materialized', () => {
    const buildInfo: GraphBuildInfo = { state: 'building', startedAt: Date.now() };
    const result = waitForBuild(buildInfo, '/project', () => false, () => undefined);

    expect(result.errorReason).toBe('graph.json missing or placeholder after build');
  });
});

// ── ensureGraphReady ──

describe('ensureGraphReady', () => {
  const mockExec = vi.fn(() => '');

  beforeEach(() => {
    vi.resetAllMocks();
    mockExec.mockImplementation(() => '');
  });

  function makeEnv(buildInfo?: GraphBuildInfo): Environment {
    return {
      rtkAvailable: false,
      rtkPath: null,
      jcodemunchAvailable: false,
      jcodemunchCwdIndexed: false,
      jcodemunchCwdRepo: null,
      jcodemunchKnownRepos: [],
      graphifyAvailable: !!buildInfo,
      graphifyGraphPath: buildInfo?.graphPath ?? null,
      graphBuildInfo: buildInfo,
      detectedAt: Date.now(),
    };
  }

  it('returns null when no graphify CLI detected (no graphBuildInfo)', () => {
    const env = makeEnv(undefined);
    const result = ensureGraphReady('/project', env, mockExec as any, () => true, () => ({ size: 5000 }));
    expect(result).toBeNull();
  });

  it('returns ready immediately when state is ready', () => {
    const env = makeEnv({ state: 'ready', graphPath: 'graphify-out/graph.json' });
    const result = ensureGraphReady('/project', env, mockExec as any, () => true, () => ({ size: 5000 }));
    expect(result).not.toBeNull();
    expect(result!.state).toBe('ready');
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('triggers build and returns result when state is absent', () => {
    const env = makeEnv({ state: 'absent' });
    // Simulate: graph absent initially, present after build runs
    let buildRan = false;
    const existsCheck = () => buildRan;
    const statCheck = () => buildRan ? { size: 5000 } : undefined;
    const buildExec = vi.fn((cmd: string) => {
      if (cmd.includes('graphify update')) { buildRan = true; return ''; }
      return '';
    });

    const result = ensureGraphReady('/project', env, buildExec as any, existsCheck, statCheck);
    expect(result).not.toBeNull();
    expect(result!.state).toBe('ready');
    expect(buildExec).toHaveBeenCalledWith(
      expect.stringContaining('graphify update'),
      expect.anything(),
    );
  });

  it('waits and returns result when state is building', () => {
    const env = makeEnv({ state: 'building', startedAt: Date.now() });
    const result = ensureGraphReady('/project', env, mockExec as any, () => true, () => ({ size: 5000 }));
    expect(result).not.toBeNull();
    expect(result!.state).toBe('ready');
    // Should NOT trigger a new build — already building
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('returns failed when state is failed', () => {
    const env = makeEnv({ state: 'failed' });
    const result = ensureGraphReady('/project', env, mockExec as any, () => true, () => ({ size: 5000 }));
    expect(result).not.toBeNull();
    expect(result!.state).toBe('failed');
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('returns build_failed when build exec throws', () => {
    const env = makeEnv({ state: 'absent' });
    const failExec = vi.fn(() => { throw new Error('recursion depth'); });

    const result = ensureGraphReady('/project', env, failExec as any, () => false, () => undefined);
    expect(result).not.toBeNull();
    expect(result!.state).toBe('failed');
  });
});

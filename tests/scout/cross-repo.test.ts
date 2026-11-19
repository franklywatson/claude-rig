import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureIndexed, ensureGraphBuilt } from '../../src/scout/cross-repo.js';
import type { Environment } from '../../src/types.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';

describe('ensureIndexed', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns existing repo when already indexed', () => {
    const env: Environment = {
      rtkAvailable: false,
      rtkPath: null,
      jcodemunchAvailable: true,
      jcodemunchCwdIndexed: true,
      jcodemunchCwdRepo: 'local/my-project',
      jcodemunchKnownRepos: ['local/my-project', 'local/superpowers'],
    graphifyAvailable: false,
    graphifyGraphPath: null,
      detectedAt: Date.now(),
    };

    const result = ensureIndexed('/home/user/my-project', env);
    expect(result.alreadyIndexed).toBe(true);
    expect(result.repo).toBe('local/my-project');
    expect(execSync).not.toHaveBeenCalledWith(expect.stringContaining('index_folder'), expect.anything());
  });

  it('indexes new directory when jcodemunch available but not indexed', () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes('index_folder')) {
        return JSON.stringify({ success: true, repo: 'local/other-project' });
      }
      return '';
    });

    const env: Environment = {
      rtkAvailable: false,
      rtkPath: null,
      jcodemunchAvailable: true,
      jcodemunchCwdIndexed: false,
      jcodemunchCwdRepo: null,
      jcodemunchKnownRepos: [],
    graphifyAvailable: false,
    graphifyGraphPath: null,
      detectedAt: Date.now(),
    };

    const result = ensureIndexed('/home/user/other-project', env);
    expect(result.alreadyIndexed).toBe(false);
    expect(result.repo).toBe('local/other-project');
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('index_folder'),
      expect.anything(),
    );
  });

  it('returns null when jcodemunch not available', () => {
    const env: Environment = {
      rtkAvailable: false,
      rtkPath: null,
      jcodemunchAvailable: false,
      jcodemunchCwdIndexed: false,
      jcodemunchCwdRepo: null,
      jcodemunchKnownRepos: [],
    graphifyAvailable: false,
    graphifyGraphPath: null,
      detectedAt: Date.now(),
    };

    const result = ensureIndexed('/home/user/some-project', env);
    expect(result).toBeNull();
  });

  it('returns null when indexing fails', () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes('index_folder')) {
        throw new Error('indexing failed');
      }
      return '';
    });

    const env: Environment = {
      rtkAvailable: false,
      rtkPath: null,
      jcodemunchAvailable: true,
      jcodemunchCwdIndexed: false,
      jcodemunchCwdRepo: null,
      jcodemunchKnownRepos: [],
    graphifyAvailable: false,
    graphifyGraphPath: null,
      detectedAt: Date.now(),
    };

    const result = ensureIndexed('/home/user/broken-project', env);
    expect(result).toBeNull();
  });

  it('detects already-indexed repo by directory basename', () => {
    const env: Environment = {
      rtkAvailable: false,
      rtkPath: null,
      jcodemunchAvailable: true,
      jcodemunchCwdIndexed: false,
      jcodemunchCwdRepo: null,
      jcodemunchKnownRepos: ['local/superpowers', 'local/gstack'],
    graphifyAvailable: false,
    graphifyGraphPath: null,
      detectedAt: Date.now(),
    };

    // Directory is ~/tools/superpowers, which matches repo 'local/superpowers'
    const result = ensureIndexed('/home/user/tools/superpowers', env);
    expect(result.alreadyIndexed).toBe(true);
    expect(result.repo).toBe('local/superpowers');
  });

  it('returns fileCapHit when files were skipped due to limit', () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes('index_folder')) {
        return JSON.stringify({
          success: true,
          repo: 'local/big-project',
          file_count: 2000,
          discovery_skip_counts: { file_limit: 4032 },
        });
      }
      return '';
    });

    const env: Environment = {
      rtkAvailable: false,
      rtkPath: null,
      jcodemunchAvailable: true,
      jcodemunchCwdIndexed: false,
      jcodemunchCwdRepo: null,
      jcodemunchKnownRepos: [],
    graphifyAvailable: false,
    graphifyGraphPath: null,
      detectedAt: Date.now(),
    };

    const result = ensureIndexed('/home/user/big-project', env);
    expect(result.fileCapHit).toBeDefined();
    expect(result.fileCapHit!.indexed).toBe(2000);
    expect(result.fileCapHit!.total).toBe(6032);
  });

  it('omits fileCapHit when no files were skipped', () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes('index_folder')) {
        return JSON.stringify({
          success: true,
          repo: 'local/small-project',
          file_count: 50,
          discovery_skip_counts: { file_limit: 0 },
        });
      }
      return '';
    });

    const env: Environment = {
      rtkAvailable: false,
      rtkPath: null,
      jcodemunchAvailable: true,
      jcodemunchCwdIndexed: false,
      jcodemunchCwdRepo: null,
      jcodemunchKnownRepos: [],
    graphifyAvailable: false,
    graphifyGraphPath: null,
      detectedAt: Date.now(),
    };

    const result = ensureIndexed('/home/user/small-project', env);
    expect(result.fileCapHit).toBeUndefined();
  });
});

describe('ensureIndexed with an unsafe directory', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each([
    ['a command substitution', '/external/$(touch pwned)'],
    ['a backtick', '/external/`touch pwned`'],
  ])('runs no command for a directory containing %s', (_label, dir) => {
    const env: Environment = {
      rtkAvailable: false,
      rtkPath: null,
      jcodemunchAvailable: true,
      jcodemunchCwdIndexed: false,
      jcodemunchCwdRepo: null,
      jcodemunchKnownRepos: [],
      graphifyAvailable: false,
      graphifyGraphPath: null,
      detectedAt: Date.now(),
    };

    expect(ensureIndexed(dir, env)).toBeNull();
    expect(execSync).not.toHaveBeenCalled();
  });
});

describe('ensureGraphBuilt', () => {
  const graphifyEnv: Environment = {
    rtkAvailable: false,
    rtkPath: null,
    jcodemunchAvailable: false,
    jcodemunchCwdIndexed: false,
    jcodemunchCwdRepo: null,
    jcodemunchKnownRepos: [],
    graphifyAvailable: true,
    graphifyGraphPath: 'graphify-out/graph.json',
    graphBuildInfo: { state: 'ready', graphPath: 'graphify-out/graph.json' },
    detectedAt: Date.now(),
  };

  const noGraphifyEnv: Environment = {
    rtkAvailable: false,
    rtkPath: null,
    jcodemunchAvailable: false,
    jcodemunchCwdIndexed: false,
    jcodemunchCwdRepo: null,
    jcodemunchKnownRepos: [],
    graphifyAvailable: false,
    graphifyGraphPath: null,
    detectedAt: Date.now(),
  };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each([
    ['a command substitution', '/external/$(touch pwned)'],
    ['a backtick', '/external/`touch pwned`'],
  ])('runs no build for a directory containing %s', (_label, dir) => {
    const absentEnv: Environment = {
      ...graphifyEnv,
      graphBuildInfo: { state: 'absent' },
    };
    const exec = vi.fn(() => '');

    const result = ensureGraphBuilt(dir, absentEnv, exec as any, () => false, () => undefined);

    expect(exec).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'build_failed' });
  });

  it('returns status ready when graph.json exists at target', () => {
    const existsCheck = (p: string) => p.includes('graphify-out/graph.json');
    const result = ensureGraphBuilt('/home/user/my-project', graphifyEnv, execSync as any, existsCheck);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('ready');
    expect(result!.graphPath).toBe('graphify-out/graph.json');
  });

  it('builds graph and returns status ready when graph.json does not exist', () => {
    const absentEnv: Environment = {
      ...graphifyEnv,
      graphBuildInfo: { state: 'absent' },
    };
    let buildRan = false;
    const existsCheck = () => buildRan;
    const statCheck = () => buildRan ? { size: 5000 } : undefined;
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes('graphify update')) { buildRan = true; return ''; }
      return '';
    });

    const result = ensureGraphBuilt('/home/user/new-project', absentEnv, execSync as any, existsCheck, statCheck);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('ready');
    expect(result!.graphPath).toBe('graphify-out/graph.json');
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('graphify update'),
      expect.anything(),
    );
  });

  it('returns null when graphify not available', () => {
    const result = ensureGraphBuilt('/home/user/some-project', noGraphifyEnv, execSync as any, () => true);
    expect(result).toBeNull();
  });

  it('returns status build_failed when exec throws', () => {
    const absentEnv: Environment = {
      ...graphifyEnv,
      graphBuildInfo: { state: 'absent' },
    };
    const existsCheck = () => false;
    const statCheck = () => undefined;
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes('graphify update')) throw new Error('recursion depth exceeded');
      return '';
    });

    const result = ensureGraphBuilt('/home/user/broken-project', absentEnv, execSync as any, existsCheck, statCheck);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('build_failed');
    expect(result!.graphPath).toBeUndefined();
  });

  it('returns status build_failed when build succeeds but graph.json still missing', () => {
    const absentEnv: Environment = {
      ...graphifyEnv,
      graphBuildInfo: { state: 'absent' },
    };
    const existsCheck = () => false;
    const statCheck = () => undefined;
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes('graphify update')) return '';
      return '';
    });

    const result = ensureGraphBuilt('/home/user/empty-project', absentEnv, execSync as any, existsCheck, statCheck);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('build_failed');
    expect(result!.graphPath).toBeUndefined();
  });
});

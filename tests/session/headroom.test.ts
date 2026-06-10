import { describe, it, expect } from 'vitest';
import { detectHeadroom } from '../../src/session/headroom.js';
import type { ExecFn } from '../../src/session/environment.js';

const CWD = '/work/proj';
const HOME = '/home/user';
const PROJECT_SETTINGS = `${CWD}/.claude/settings.json`;
const LOCAL_SETTINGS = `${CWD}/.claude/settings.local.json`;
const USER_SETTINGS = `${HOME}/.claude/settings.json`;

const headroomOnPath: ExecFn = (cmd) => {
  if (cmd === 'which headroom') return '/Users/u/.local/bin/headroom';
  throw new Error(`not found: ${cmd}`);
};
const nothingOnPath: ExecFn = () => {
  throw new Error('not found');
};

function makeFiles(files: Record<string, string>): {
  readFile: (p: string) => string;
  existsCheck: (p: string) => boolean;
} {
  return {
    readFile: (p) => {
      if (p in files) return files[p];
      throw new Error(`ENOENT: ${p}`);
    },
    existsCheck: (p) => p in files,
  };
}

const MARKER_SETTINGS = JSON.stringify({
  hooks: {
    SessionStart: [
      {
        matcher: 'startup|resume',
        hooks: [{ type: 'command', command: 'headroom hook --marker headroom-init-claude' }],
      },
    ],
  },
});

const PROXY_ENV_SETTINGS = JSON.stringify({
  env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' },
});

describe('detectHeadroom', () => {
  it('reports unavailable and uninitialized when nothing is present', () => {
    const { readFile, existsCheck } = makeFiles({});
    const result = detectHeadroom(CWD, nothingOnPath, readFile, existsCheck, HOME);
    expect(result).toEqual({ available: false, initialized: false });
  });

  it('detects availability from PATH without initialization', () => {
    const { readFile, existsCheck } = makeFiles({});
    const result = detectHeadroom(CWD, headroomOnPath, readFile, existsCheck, HOME);
    expect(result).toEqual({ available: true, initialized: false });
  });

  it('detects initialization from the headroom hook marker in project settings', () => {
    const { readFile, existsCheck } = makeFiles({ [PROJECT_SETTINGS]: MARKER_SETTINGS });
    const result = detectHeadroom(CWD, headroomOnPath, readFile, existsCheck, HOME);
    expect(result.initialized).toBe(true);
  });

  it('detects initialization from a localhost ANTHROPIC_BASE_URL proxy env', () => {
    const { readFile, existsCheck } = makeFiles({ [LOCAL_SETTINGS]: PROXY_ENV_SETTINGS });
    const result = detectHeadroom(CWD, headroomOnPath, readFile, existsCheck, HOME);
    expect(result.initialized).toBe(true);
  });

  it('detects initialization at user scope (headroom init -g)', () => {
    const { readFile, existsCheck } = makeFiles({ [USER_SETTINGS]: MARKER_SETTINGS });
    const result = detectHeadroom(CWD, headroomOnPath, readFile, existsCheck, HOME);
    expect(result.initialized).toBe(true);
  });

  it('does not treat a remote ANTHROPIC_BASE_URL as headroom', () => {
    const settings = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.example.com' } });
    const { readFile, existsCheck } = makeFiles({ [PROJECT_SETTINGS]: settings });
    const result = detectHeadroom(CWD, headroomOnPath, readFile, existsCheck, HOME);
    expect(result.initialized).toBe(false);
  });

  it('ignores malformed settings files', () => {
    const { readFile, existsCheck } = makeFiles({
      [PROJECT_SETTINGS]: '{ not valid json',
      [USER_SETTINGS]: MARKER_SETTINGS,
    });
    const result = detectHeadroom(CWD, headroomOnPath, readFile, existsCheck, HOME);
    expect(result.initialized).toBe(true);
  });

  it('initialized requires the proxy config even when the binary is absent', () => {
    // Settings can carry stale headroom config after uninstall — still report
    // initialized so the savings skill can explain why perf data is missing.
    const { readFile, existsCheck } = makeFiles({ [PROJECT_SETTINGS]: MARKER_SETTINGS });
    const result = detectHeadroom(CWD, nothingOnPath, readFile, existsCheck, HOME);
    expect(result).toEqual({ available: false, initialized: true });
  });
});

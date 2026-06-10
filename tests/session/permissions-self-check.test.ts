import { describe, it, expect } from 'vitest';
import { checkPermissionsReadiness } from '../../src/session/permissions-self-check.js';
import { REQUIRED_PERMISSIONS } from '../../src/cli/permissions.js';

const PROJECT = '/tmp/fake-project';
const HOME = '/tmp/fake-home';
const SETTINGS_PATH = `${PROJECT}/.claude/settings.json`;
const LOCAL_SETTINGS_PATH = `${PROJECT}/.claude/settings.local.json`;
const USER_SETTINGS_PATH = `${HOME}/.claude/settings.json`;

function makeReader(contents: string): (path: string, enc: string) => string {
  return (path) => {
    if (path === SETTINGS_PATH) return contents;
    throw new Error(`unexpected read: ${path}`);
  };
}

// Multi-scope reader: maps exact paths to file contents.
function makeFiles(files: Record<string, string>): {
  readFile: (path: string, enc: string) => string;
  existsCheck: (path: string) => boolean;
} {
  return {
    readFile: (path) => {
      if (path in files) return files[path];
      throw new Error(`unexpected read: ${path}`);
    },
    existsCheck: (path) => path in files,
  };
}

function makeExists(paths: string[]): (path: string) => boolean {
  return (path) => paths.includes(path);
}

describe('checkPermissionsReadiness', () => {
  it('returns ok when all required permissions are present', () => {
    const settings = {
      permissions: {
        allow: [...REQUIRED_PERMISSIONS, 'Bash(rtk:*)', 'Bash(git status:*)'],
      },
    };
    const result = checkPermissionsReadiness(
      PROJECT,
      makeReader(JSON.stringify(settings)),
      makeExists([SETTINGS_PATH]),
      HOME,
    );
    expect(result).toEqual({ status: 'ok' });
  });

  it('returns no_settings when settings.json does not exist', () => {
    const result = checkPermissionsReadiness(
      PROJECT,
      makeReader(''),
      makeExists([]),
      HOME,
    );
    expect(result).toEqual({ status: 'no_settings', fixCommand: 'rig init --force' });
  });

  it('returns no_settings when settings.json is malformed JSON', () => {
    const result = checkPermissionsReadiness(
      PROJECT,
      makeReader('{ not valid json'),
      makeExists([SETTINGS_PATH]),
      HOME,
    );
    expect(result.status).toBe('no_settings');
  });

  it('lists missing entries when some permissions are absent', () => {
    const settings = {
      permissions: {
        allow: ['mcp__jcodemunch__*', 'Bash(npx:*)'],
      },
    };
    const result = checkPermissionsReadiness(
      PROJECT,
      makeReader(JSON.stringify(settings)),
      makeExists([SETTINGS_PATH]),
      HOME,
    );
    expect(result.status).toBe('missing');
    if (result.status === 'missing') {
      expect(result.missing).toContain('Read(/tmp/rig-session-*.json)');
      expect(result.missing).toContain('Bash(ls /tmp/rig-session-*)');
      expect(result.missing).not.toContain('mcp__jcodemunch__*');
      expect(result.fixCommand).toBe('rig init --broad-permissions');
    }
  });

  it('lists ALL required entries as missing when allow list is empty', () => {
    const settings = { permissions: { allow: [] } };
    const result = checkPermissionsReadiness(
      PROJECT,
      makeReader(JSON.stringify(settings)),
      makeExists([SETTINGS_PATH]),
      HOME,
    );
    expect(result.status).toBe('missing');
    if (result.status === 'missing') {
      for (const entry of REQUIRED_PERMISSIONS) {
        expect(result.missing).toContain(entry);
      }
    }
  });

  it('treats missing permissions object as all-missing', () => {
    const settings = {};
    const result = checkPermissionsReadiness(
      PROJECT,
      makeReader(JSON.stringify(settings)),
      makeExists([SETTINGS_PATH]),
      HOME,
    );
    expect(result.status).toBe('missing');
  });

  it('treats non-array allow list as all-missing', () => {
    const settings = { permissions: { allow: 'not-an-array' } };
    const result = checkPermissionsReadiness(
      PROJECT,
      makeReader(JSON.stringify(settings)),
      makeExists([SETTINGS_PATH]),
      HOME,
    );
    expect(result.status).toBe('missing');
  });

  it('filters non-string entries from allow list', () => {
    const settings = {
      permissions: {
        allow: [...REQUIRED_PERMISSIONS, 42, null, { obj: true }],
      },
    };
    const result = checkPermissionsReadiness(
      PROJECT,
      makeReader(JSON.stringify(settings)),
      makeExists([SETTINGS_PATH]),
      HOME,
    );
    expect(result).toEqual({ status: 'ok' });
  });

  // Claude Code merges permissions across scopes — entries satisfied at user
  // or local scope must not be reported missing (marketplace false positive).
  it('returns ok when project has deny-only and user settings carry the allow entries', () => {
    const { readFile, existsCheck } = makeFiles({
      [SETTINGS_PATH]: JSON.stringify({ permissions: { allow: [], deny: ['Read(**/secrets/**)'] } }),
      [USER_SETTINGS_PATH]: JSON.stringify({ permissions: { allow: [...REQUIRED_PERMISSIONS] } }),
    });

    const result = checkPermissionsReadiness(PROJECT, readFile, existsCheck, HOME);
    expect(result).toEqual({ status: 'ok' });
  });

  it('returns ok when entries are split across project, local, and user scopes', () => {
    const [first, second, ...rest] = [...REQUIRED_PERMISSIONS];
    const { readFile, existsCheck } = makeFiles({
      [SETTINGS_PATH]: JSON.stringify({ permissions: { allow: [first] } }),
      [LOCAL_SETTINGS_PATH]: JSON.stringify({ permissions: { allow: [second] } }),
      [USER_SETTINGS_PATH]: JSON.stringify({ permissions: { allow: rest } }),
    });

    const result = checkPermissionsReadiness(PROJECT, readFile, existsCheck, HOME);
    expect(result).toEqual({ status: 'ok' });
  });

  it('still reports entries missing from every scope', () => {
    const { readFile, existsCheck } = makeFiles({
      [SETTINGS_PATH]: JSON.stringify({ permissions: { allow: ['mcp__jcodemunch__*'] } }),
      [USER_SETTINGS_PATH]: JSON.stringify({ permissions: { allow: ['Bash(npx:*)'] } }),
    });

    const result = checkPermissionsReadiness(PROJECT, readFile, existsCheck, HOME);
    expect(result.status).toBe('missing');
    if (result.status === 'missing') {
      expect(result.missing).not.toContain('mcp__jcodemunch__*');
      expect(result.missing).not.toContain('Bash(npx:*)');
      expect(result.missing).toContain('mcp__graphify__*');
      expect(result.fixCommand).toBe('rig init --broad-permissions');
    }
  });

  it('ignores malformed user settings and evaluates remaining scopes', () => {
    const { readFile, existsCheck } = makeFiles({
      [SETTINGS_PATH]: JSON.stringify({ permissions: { allow: [...REQUIRED_PERMISSIONS] } }),
      [USER_SETTINGS_PATH]: '{ not valid json',
    });

    const result = checkPermissionsReadiness(PROJECT, readFile, existsCheck, HOME);
    expect(result).toEqual({ status: 'ok' });
  });
});

describe('REQUIRED_PERMISSIONS contract', () => {
  it('includes the session cache cat permission', () => {
    expect(REQUIRED_PERMISSIONS).toContain('Bash(cat /tmp/rig-session-*)');
  });

  it('includes the session cache ls permission', () => {
    expect(REQUIRED_PERMISSIONS).toContain('Bash(ls /tmp/rig-session-*)');
  });

  it('includes the session cache Read tool permission', () => {
    expect(REQUIRED_PERMISSIONS).toContain('Read(/tmp/rig-session-*.json)');
  });

  it('includes the macOS-resolved /private/tmp Read permission', () => {
    // /tmp -> /private/tmp on macOS; the Read tool resolves symlinks before
    // matching, so we need both forms to avoid permission prompts cross-platform.
    expect(REQUIRED_PERMISSIONS).toContain('Read(/private/tmp/rig-session-*.json)');
  });

  it('includes both MCP wildcards', () => {
    expect(REQUIRED_PERMISSIONS).toContain('mcp__jcodemunch__*');
    expect(REQUIRED_PERMISSIONS).toContain('mcp__graphify__*');
  });

  it('includes npx', () => {
    expect(REQUIRED_PERMISSIONS).toContain('Bash(npx:*)');
  });

  it('does NOT include the conditional rtk permission', () => {
    expect(REQUIRED_PERMISSIONS).not.toContain('Bash(rtk:*)');
  });
});

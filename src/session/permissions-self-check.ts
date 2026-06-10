import { join } from 'node:path';
import { homedir } from 'node:os';
import type { PermissionsReadiness } from '../types.js';
import { REQUIRED_PERMISSIONS } from '../cli/permissions.js';

const INIT_FIX_COMMAND = 'rig init --force';
// Plain `rig init` writes only the deny list; allow entries are opt-in.
const ALLOW_FIX_COMMAND = 'rig init --broad-permissions';

type ReadFileFn = (path: string, encoding: string) => string;
type ExistsCheck = (path: string) => boolean;

/**
 * Checks the merged permission allow-list against the set of permissions
 * `rig init --broad-permissions` is expected to have auto-allowed.
 *
 * Claude Code merges permissions across scopes, so an entry satisfied at any
 * of these locations counts (checking only the project file produced false
 * positives for users who keep broad allows at user scope):
 *
 * 1. `<project>/.claude/settings.json`
 * 2. `<project>/.claude/settings.local.json`
 * 3. `~/.claude/settings.json`
 *
 * A missing or malformed *project* settings.json still reports "no_settings"
 * — that means rig was never initialized here, regardless of user scope.
 *
 * Read or parse errors in the other scopes are ignored (treated as empty), so
 * a broken settings file never breaks session-start.
 */
export function checkPermissionsReadiness(
  projectDir: string,
  readFile: ReadFileFn,
  existsCheck: ExistsCheck,
  homeDir: string = homedir(),
): PermissionsReadiness {
  const projectSettingsPath = join(projectDir, '.claude', 'settings.json');

  if (!existsCheck(projectSettingsPath)) {
    return { status: 'no_settings', fixCommand: INIT_FIX_COMMAND };
  }

  let projectSettings: unknown;
  try {
    projectSettings = JSON.parse(readFile(projectSettingsPath, 'utf-8'));
  } catch {
    return { status: 'no_settings', fixCommand: INIT_FIX_COMMAND };
  }

  const allow = new Set(extractAllowList(projectSettings));
  for (const path of [
    join(projectDir, '.claude', 'settings.local.json'),
    join(homeDir, '.claude', 'settings.json'),
  ]) {
    for (const entry of readAllowList(path, readFile, existsCheck)) {
      allow.add(entry);
    }
  }

  const missing = REQUIRED_PERMISSIONS.filter((entry) => !allow.has(entry));

  if (missing.length === 0) {
    return { status: 'ok' };
  }

  return {
    status: 'missing',
    missing,
    fixCommand: ALLOW_FIX_COMMAND,
  };
}

function readAllowList(path: string, readFile: ReadFileFn, existsCheck: ExistsCheck): string[] {
  try {
    if (!existsCheck(path)) return [];
    return extractAllowList(JSON.parse(readFile(path, 'utf-8')));
  } catch {
    return [];
  }
}

function extractAllowList(settings: unknown): string[] {
  if (!settings || typeof settings !== 'object') return [];
  const perms = (settings as { permissions?: unknown }).permissions;
  if (!perms || typeof perms !== 'object') return [];
  const allow = (perms as { allow?: unknown }).allow;
  if (!Array.isArray(allow)) return [];
  return allow.filter((x): x is string => typeof x === 'string');
}

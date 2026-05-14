import { join } from 'node:path';
import type { PermissionsReadiness } from '../types.js';
import { REQUIRED_PERMISSIONS } from '../cli/permissions.js';

const FIX_COMMAND = 'rig init --force';

type ReadFileFn = (path: string, encoding: string) => string;
type ExistsCheck = (path: string) => boolean;

/**
 * Checks `.claude/settings.json` against the set of permissions `rig init`
 * is expected to have auto-allowed. Detects two failure modes:
 *
 * 1. The settings file doesn't exist (rig was never initialized in this
 *    project, or settings.json was deleted).
 * 2. The settings file exists but is missing one or more required entries
 *    (e.g., user upgraded rig and the required set grew, or hand-edited
 *    settings.json removed entries).
 *
 * Both fix paths are `rig init --force`, which is idempotent — it only adds
 * missing entries and preserves user customizations.
 *
 * Errors reading or parsing settings.json are treated as "no_settings" rather
 * than thrown, so a broken settings file doesn't break session-start.
 */
export function checkPermissionsReadiness(
  projectDir: string,
  readFile: ReadFileFn,
  existsCheck: ExistsCheck,
): PermissionsReadiness {
  const settingsPath = join(projectDir, '.claude', 'settings.json');

  if (!existsCheck(settingsPath)) {
    return { status: 'no_settings', fixCommand: FIX_COMMAND };
  }

  let settings: unknown;
  try {
    settings = JSON.parse(readFile(settingsPath, 'utf-8'));
  } catch {
    return { status: 'no_settings', fixCommand: FIX_COMMAND };
  }

  const allow = extractAllowList(settings);
  const missing = REQUIRED_PERMISSIONS.filter((entry) => !allow.includes(entry));

  if (missing.length === 0) {
    return { status: 'ok' };
  }

  return {
    status: 'missing',
    missing,
    fixCommand: FIX_COMMAND,
  };
}

function extractAllowList(settings: unknown): string[] {
  if (!settings || typeof settings !== 'object') return [];
  const perms = (settings as { permissions?: unknown }).permissions;
  if (!perms || typeof perms !== 'object') return [];
  const allow = (perms as { allow?: unknown }).allow;
  if (!Array.isArray(allow)) return [];
  return allow.filter((x): x is string => typeof x === 'string');
}

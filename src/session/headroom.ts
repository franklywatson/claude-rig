import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ExecFn } from './environment.js';

/**
 * Headroom (context-compression proxy) detection.
 *
 * `available` — the headroom CLI is on PATH.
 * `initialized` — Claude Code is configured to route through the headroom
 * proxy for this project: either the `headroom-init-claude` hook marker or a
 * localhost `ANTHROPIC_BASE_URL` appears in any settings scope (project
 * settings.json, project settings.local.json, user ~/.claude/settings.json).
 *
 * Initialized-without-available is reported as such (stale config after an
 * uninstall) so callers can explain missing perf data instead of hiding it.
 */
export interface HeadroomDetection {
  available: boolean;
  initialized: boolean;
}

const HEADROOM_HOOK_MARKER = 'headroom-init-claude';
const LOCAL_PROXY_PATTERN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/;

export function detectHeadroom(
  cwd: string,
  exec: ExecFn,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf-8'),
  existsCheck: (path: string) => boolean = existsSync,
  homeDir: string = homedir(),
): HeadroomDetection {
  let available = false;
  try {
    exec('which headroom');
    available = true;
  } catch {
    // Not on PATH
  }

  const settingsPaths = [
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
    join(homeDir, '.claude', 'settings.json'),
  ];
  const initialized = settingsPaths.some((path) => settingsShowHeadroom(path, readFile, existsCheck));

  return { available, initialized };
}

function settingsShowHeadroom(
  path: string,
  readFile: (path: string) => string,
  existsCheck: (path: string) => boolean,
): boolean {
  try {
    if (!existsCheck(path)) return false;
    const raw = readFile(path);
    if (raw.includes(HEADROOM_HOOK_MARKER)) return true;
    const parsed = JSON.parse(raw) as { env?: { ANTHROPIC_BASE_URL?: unknown } };
    const baseUrl = parsed?.env?.ANTHROPIC_BASE_URL;
    return typeof baseUrl === 'string' && LOCAL_PROXY_PATTERN.test(baseUrl);
  } catch {
    return false;
  }
}

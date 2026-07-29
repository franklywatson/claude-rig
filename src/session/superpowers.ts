import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface SuperpowersDetection {
  installed: boolean;
  version?: string;
}

// installed_plugins.json keys are `<plugin>@<marketplace>`; match superpowers
// from any marketplace (claude-plugins-official, obra/superpowers-marketplace, …).
const SUPERPOWERS_KEY = /^superpowers@/;

/**
 * Detect superpowers via Claude Code's plugin registry
 * (`~/.claude/plugins/installed_plugins.json`). superpowers is the base skills
 * framework rig's chain wraps (`superpowers:brainstorming`, etc.) — required.
 *
 * The registry is authoritative for plugin-marketplace installs (the supported
 * path). Manual installs that bypass the registry aren't detected here.
 */
export function detectSuperpowers(
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf-8'),
  existsCheck: (path: string) => boolean = existsSync,
  homeDir: string = homedir(),
): SuperpowersDetection {
  const reg = join(homeDir, '.claude', 'plugins', 'installed_plugins.json');
  try {
    if (!existsCheck(reg)) return { installed: false };
    const parsed = JSON.parse(readFile(reg)) as {
      plugins?: Record<string, Array<{ version?: string }>>;
    };
    for (const key of Object.keys(parsed.plugins ?? {})) {
      if (SUPERPOWERS_KEY.test(key)) {
        const entry = parsed.plugins?.[key]?.[0];
        return { installed: true, version: entry?.version };
      }
    }
    return { installed: false };
  } catch {
    return { installed: false };
  }
}

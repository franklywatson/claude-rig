import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// rtk's global PreToolUse hook command (from `rtk init -g` or `headroom wrap claude --rtk`).
const RTK_GLOBAL_HOOK_PATTERN = /\brtk hook\b/;

/**
 * Detect rtk's OWN global PreToolUse hook in `~/.claude/settings.json`.
 *
 * `rtk init --global` (and `headroom wrap claude --rtk`) installs `rtk hook claude`
 * as a global PreToolUse rewriter. When rig's project-level hook is ALSO active,
 * the two stack: every Bash command is rewritten twice (rig rewrites via
 * `rtk rewrite`, then rtk's global hook rewrites again). This returns true when
 * rtk's global hook is present so session-start can advise removal.
 */
export function detectRtkGlobalHook(
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf-8'),
  existsCheck: (path: string) => boolean = existsSync,
  homeDir: string = homedir(),
): boolean {
  const path = join(homeDir, '.claude', 'settings.json');
  try {
    if (!existsCheck(path)) return false;
    const parsed = JSON.parse(readFile(path)) as {
      hooks?: { PreToolUse?: Array<{ hooks?: Array<{ command?: unknown }> }> };
    };
    for (const entry of parsed.hooks?.PreToolUse ?? []) {
      for (const h of entry.hooks ?? []) {
        if (typeof h.command === 'string' && RTK_GLOBAL_HOOK_PATTERN.test(h.command)) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

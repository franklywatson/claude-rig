/**
 * Permissions that `rig init` auto-allows in `.claude/settings.json`.
 *
 * These are the always-required entries — `Bash(rtk:*)` is intentionally
 * omitted because it's conditional on rtk being detected at init time.
 * The session-start permissions self-check reads this same list to detect
 * drift between `rig init`'s expected state and the on-disk settings.
 */
export const REQUIRED_PERMISSIONS = [
  'mcp__jcodemunch__*',
  'mcp__graphify__*',
  'Bash(cat /tmp/rig-session-*)',
  'Bash(ls /tmp/rig-session-*)',
  'Read(/tmp/rig-session-*.json)',
  'Bash(npx:*)',
] as const;

export type RequiredPermission = (typeof REQUIRED_PERMISSIONS)[number];

/**
 * Permissions added by `rig init --broad-permissions`.
 *
 * Not added by default — opt-in flag required. Includes everything needed
 * for rig to function without prompts (MCP tools, session cache, npx, rtk)
 * plus pre-authorizations for common read-only shell operations that
 * Claude Code's absolute-path requirement otherwise triggers per-path-pattern.
 *
 * `Bash(rtk:*)` is intentionally omitted — it's conditional on rtk being
 * detected at init time and is added separately in initCommand.
 *
 * The session-start permissions self-check reads REQUIRED_PERMISSIONS to
 * detect drift; it still uses the same list for backwards compatibility.
 */
export const REQUIRED_PERMISSIONS = [
  'mcp__jcodemunch__*',
  'mcp__graphify__*',
  'Bash(cat /tmp/rig-session-*)',
  'Bash(ls /tmp/rig-session-*)',
  // The Read tool resolves symlinks before matching. On macOS, /tmp is a
  // symlink to /private/tmp, so the resolved path doesn't match a /tmp/...
  // pattern. We include both forms so the same permission set works on
  // macOS (resolved /private/tmp) and Linux (literal /tmp).
  'Read(/tmp/rig-session-*.json)',
  'Read(/private/tmp/rig-session-*.json)',
  'Bash(npx:*)',
] as const;

/**
 * Additional broad bash permissions added by --broad-permissions.
 * Pre-authorizes common read-only shell operations to reduce approval prompts
 * when agents use absolute paths (as required by Claude Code system prompt).
 */
export const BROAD_BASH_PERMISSIONS = [
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Bash(grep:*)',
  'Bash(find:*)',
  'Bash(which:*)',
  'Bash(node:*)',
  'Bash(npm:*)',
] as const;

export type RequiredPermission = (typeof REQUIRED_PERMISSIONS)[number];
export type BroadBashPermission = (typeof BROAD_BASH_PERMISSIONS)[number];

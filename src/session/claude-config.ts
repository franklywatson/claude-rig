import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * An MCP server registration as Claude Code launches it. Reading this from
 * Claude's own config is ground truth for how to reach the server — guessing
 * the invocation (e.g. bare `uvx jcodemunch-mcp`) fails for installs that use
 * `uvx --from <wheel-url>`, since the package is not on PyPI.
 */
export interface McpRegistration {
  command: string;
  args: string[];
  source: 'local' | 'project' | 'user';
}

export type ReadFileFn = (path: string) => string;

interface RawServerEntry {
  type?: string;
  command?: unknown;
  args?: unknown;
}

/**
 * Find the jcodemunch MCP server registration in Claude Code's config files.
 * Scope precedence mirrors Claude Code: local (~/.claude.json projects[cwd])
 * > project (<cwd>/.mcp.json) > user (~/.claude.json top-level mcpServers).
 * Returns null if no stdio registration is found; never throws.
 */
export function resolveJcodemunchRegistration(
  cwd: string,
  readFile: ReadFileFn = (p) => readFileSync(p, 'utf-8'),
  existsCheck: (path: string) => boolean = existsSync,
  homeDir: string = homedir(),
): McpRegistration | null {
  const claudeJson = readJson(join(homeDir, '.claude.json'), readFile, existsCheck);

  const local = findJcodemunchEntry(claudeJson?.projects?.[resolve(cwd)]?.mcpServers);
  if (local) return { ...local, source: 'local' };

  const projectJson = readJson(join(cwd, '.mcp.json'), readFile, existsCheck);
  const project = findJcodemunchEntry(projectJson?.mcpServers);
  if (project) return { ...project, source: 'project' };

  const user = findJcodemunchEntry(claudeJson?.mcpServers);
  if (user) return { ...user, source: 'user' };

  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readJson(
  path: string,
  readFile: ReadFileFn,
  existsCheck: (path: string) => boolean,
): any {
  try {
    if (!existsCheck(path)) return null;
    return JSON.parse(readFile(path));
  } catch {
    return null;
  }
}

function findJcodemunchEntry(
  servers: Record<string, RawServerEntry> | undefined | null,
): { command: string; args: string[] } | null {
  if (!servers || typeof servers !== 'object') return null;

  const exact = toStdioEntry(servers['jcodemunch']);
  if (exact) return exact;

  for (const [key, entry] of Object.entries(servers)) {
    const candidate = toStdioEntry(entry);
    if (!candidate) continue;
    const haystack = `${key} ${candidate.command} ${candidate.args.join(' ')}`.toLowerCase();
    if (haystack.includes('jcodemunch')) return candidate;
  }

  return null;
}

function toStdioEntry(entry: RawServerEntry | undefined): { command: string; args: string[] } | null {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.type !== undefined && entry.type !== 'stdio') return null;
  if (typeof entry.command !== 'string' || entry.command.length === 0) return null;
  const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : [];
  return { command: entry.command, args };
}

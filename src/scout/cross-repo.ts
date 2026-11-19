import { execSync } from 'node:child_process';
import { basename } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import type { Environment } from '../types.js';
import { ensureGraphReady } from './graph-state.js';
import { isShellQuotablePath } from '../shell-path.js';

interface IndexResult {
  alreadyIndexed: boolean;
  repo: string;
  fileCapHit?: { indexed: number; total: number };
}

/**
 * Ensure a directory is indexed by jcodemunch.
 * Returns the repo identifier if indexed, or null if indexing is not possible.
 */
export function ensureIndexed(directory: string, env: Environment): IndexResult | null {
  if (!env.jcodemunchAvailable) return null;

  // Check if already indexed by directory basename
  const dirName = basename(directory);
  const existing = env.jcodemunchKnownRepos.find(r => r.endsWith(dirName));
  if (existing) {
    return { alreadyIndexed: true, repo: existing };
  }

  // The directory may come from a tool call or model: never place an
  // unquotable path inside the double-quoted command below.
  if (!isShellQuotablePath(directory)) return null;

  // Index it
  try {
    const raw = execSync(
      `jcodemunch index_folder --path "${directory}"`,
      { encoding: 'utf-8', timeout: 120_000 },
    ).trim();
    const parsed = JSON.parse(raw);
    if (parsed.success) {
      const result: IndexResult = { alreadyIndexed: false, repo: parsed.repo };
      const skipped = parsed.discovery_skip_counts?.file_limit ?? 0;
      if (skipped > 0 && parsed.file_count) {
        result.fileCapHit = { indexed: parsed.file_count, total: parsed.file_count + skipped };
      }
      return result;
    }
    return null;
  } catch {
    return null;
  }
}

interface GraphBuildResult {
  status: 'ready' | 'build_failed';
  graphPath?: string;
}

const defaultStatCheck = (path: string): { size: number } | undefined => {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
};

/**
 * Ensure a directory has a graphify knowledge graph built.
 * Delegates to the graph-state module's ensureGraphReady().
 * Returns result with status, or null if graphify is not installed.
 */
export function ensureGraphBuilt(
  directory: string,
  env: Environment,
  exec: (cmd: string, opts?: { encoding?: string; timeout?: number }) => string,
  existsCheck: (path: string) => boolean = existsSync,
  statCheck: (path: string) => { size: number } | undefined = defaultStatCheck,
): GraphBuildResult | null {
  const result = ensureGraphReady(directory, env, exec, existsCheck, statCheck);
  if (!result) return null;
  if (result.state === 'ready') {
    return { status: 'ready', graphPath: result.graphPath };
  }
  return { status: 'build_failed' };
}

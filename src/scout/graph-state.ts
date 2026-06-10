import { join } from 'node:path';
import type { Environment, GraphBuildInfo } from '../types.js';

const PLACEHOLDER_THRESHOLD = 1024; // bytes
const BUILD_TIMEOUT = 120_000; // ms

type ExecFn = (cmd: string, opts?: { encoding?: string; timeout?: number }) => string;
type ExistsCheck = (path: string) => boolean;
type StatCheck = (path: string) => { size: number } | undefined;

/**
 * Determine the graph state from the filesystem.
 * Returns absent for missing or placeholder graphs, ready for real ones.
 */
export function determineGraphState(
  cwd: string,
  existsCheck: ExistsCheck,
  statCheck: StatCheck,
): GraphBuildInfo {
  const graphJsonPath = join(cwd, 'graphify-out', 'graph.json');

  if (!existsCheck(graphJsonPath)) {
    return { state: 'absent' };
  }

  const stat = statCheck(graphJsonPath);
  if (!stat || stat.size < PLACEHOLDER_THRESHOLD) {
    return { state: 'absent' };
  }

  return { state: 'ready', graphPath: 'graphify-out/graph.json' };
}

/**
 * Trigger a graphify build for the given directory.
 * Returns building state on success, failed on error.
 */
export function triggerBuild(
  directory: string,
  exec: ExecFn,
): GraphBuildInfo {
  try {
    exec(`graphify update "${directory}"`, { encoding: 'utf-8', timeout: BUILD_TIMEOUT });
    return { state: 'building', startedAt: Date.now() };
  } catch (err) {
    // Preserve why: timeout vs AST recursion vs missing CLI are very different fixes
    const message = err instanceof Error ? err.message : String(err);
    return { state: 'failed', errorReason: message.slice(0, 200) };
  }
}

/**
 * Check the result of a previously-triggered build.
 * Returns ready if graph.json now exists with real content, failed otherwise.
 */
export function waitForBuild(
  _buildInfo: GraphBuildInfo,
  cwd: string,
  existsCheck: ExistsCheck,
  statCheck: StatCheck,
): GraphBuildInfo {
  const graphJsonPath = join(cwd, 'graphify-out', 'graph.json');

  if (existsCheck(graphJsonPath)) {
    const stat = statCheck(graphJsonPath);
    if (stat && stat.size >= PLACEHOLDER_THRESHOLD) {
      return { state: 'ready', graphPath: 'graphify-out/graph.json' };
    }
  }

  return { state: 'failed', errorReason: 'graph.json missing or placeholder after build' };
}

/**
 * Unified entry point: ensure a graphify graph is ready for use.
 * Handles all four states: absent (triggers build), building (waits),
 * ready (returns immediately), failed (returns failure).
 * Returns null if graphify is not detected at all.
 */
export function ensureGraphReady(
  directory: string,
  env: Environment,
  exec: ExecFn,
  existsCheck: ExistsCheck,
  statCheck: StatCheck,
): GraphBuildInfo | null {
  const info = env.graphBuildInfo;
  if (!info) return null;

  switch (info.state) {
    case 'ready':
      return info;

    case 'absent':
      triggerBuild(directory, exec);
      return waitForBuild(info, directory, existsCheck, statCheck);

    case 'building':
      return waitForBuild(info, directory, existsCheck, statCheck);

    case 'failed':
      return info;
  }
}

import type { Environment, GraphBuildInfo } from '../types.js';
import { graphJsonPath, GRAPH_JSON_REL, GRAPHIFY_PLACEHOLDER_THRESHOLD } from '../constants.js';

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
  const graphFile = graphJsonPath(cwd);

  if (!existsCheck(graphFile)) {
    return { state: 'absent' };
  }

  const stat = statCheck(graphFile);
  if (!stat || stat.size < GRAPHIFY_PLACEHOLDER_THRESHOLD) {
    return { state: 'absent' };
  }

  return { state: 'ready', graphPath: GRAPH_JSON_REL };
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

export interface WaitForBuildOpts {
  /** How long to keep polling for the graph. 0 (default) = single immediate check. */
  deadlineMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => void;
}

// Synchronous sleep that doesn't spin the CPU — hooks are synchronous processes.
const defaultSleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Check the result of a previously-triggered build.
 * Returns ready if graph.json now exists with real content, failed otherwise.
 *
 * `graphify update` can return before graph.json is fully on disk — a single
 * immediate check races the build output (observed in the field: update
 * returned at T, graph landed at T+1s, "failed" got cached all session).
 * Callers in a position to wait pass a deadline to poll across that window.
 */
export function waitForBuild(
  _buildInfo: GraphBuildInfo,
  cwd: string,
  existsCheck: ExistsCheck,
  statCheck: StatCheck,
  opts: WaitForBuildOpts = {},
): GraphBuildInfo {
  const deadlineMs = opts.deadlineMs ?? 0;
  const intervalMs = opts.intervalMs ?? 250;
  const sleep = opts.sleep ?? defaultSleep;
  const graphFile = graphJsonPath(cwd);
  const start = Date.now();

  for (;;) {
    if (existsCheck(graphFile)) {
      const stat = statCheck(graphFile);
      if (stat && stat.size >= GRAPHIFY_PLACEHOLDER_THRESHOLD) {
        return { state: 'ready', graphPath: GRAPH_JSON_REL };
      }
    }
    if (Date.now() - start >= deadlineMs) break;
    sleep(intervalMs);
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

    case 'absent': {
      const build = triggerBuild(directory, exec);
      // A failed trigger carries the error reason — don't discard it for a
      // pointless disk check that would report a generic failure.
      if (build.state === 'failed') return build;
      return waitForBuild(info, directory, existsCheck, statCheck);
    }

    case 'building':
      return waitForBuild(info, directory, existsCheck, statCheck);

    case 'failed': {
      // A cached failure may be stale: the build can land moments after the
      // verdict was recorded (build-output race). The disk is truth.
      const current = determineGraphState(directory, existsCheck, statCheck);
      return current.state === 'ready' ? current : info;
    }
  }
}

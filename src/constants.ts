import { join } from 'node:path';

// ── Graphify on-disk layout ──
// Single source of truth for paths graphify writes; a layout change upstream
// should be a one-file edit here, not a shotgun edit across detection,
// stats capture, build state, and init.

export const GRAPHIFY_OUT_DIR = 'graphify-out';
export const GRAPH_JSON_REL = `${GRAPHIFY_OUT_DIR}/graph.json`;
export const GRAPH_REPORT_REL = `${GRAPHIFY_OUT_DIR}/GRAPH_REPORT.md`;
export const REBUILD_LOCK_REL = `${GRAPHIFY_OUT_DIR}/.rebuild.lock`;

/** graph.json files smaller than this are placeholders, not real graphs. */
export const GRAPHIFY_PLACEHOLDER_THRESHOLD = 1024; // bytes

export const graphJsonPath = (dir: string): string => join(dir, GRAPHIFY_OUT_DIR, 'graph.json');
export const graphReportPath = (dir: string): string => join(dir, GRAPHIFY_OUT_DIR, 'GRAPH_REPORT.md');
export const rebuildLockPath = (dir: string): string => join(dir, GRAPHIFY_OUT_DIR, '.rebuild.lock');

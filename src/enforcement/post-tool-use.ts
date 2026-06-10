import { resolve } from 'node:path';
import { FileTracker } from './file-tracker.js';
import { SessionCache } from '../session/cache.js';
import type { HarnessConfig } from '../types.js';
import { checkStaleTests } from './stale-test.js';
import { checkConstitutional } from './constitutional.js';
import { checkZeroDefect } from './zero-defect.js';
import {
  incrementMetric,
  captureExternalGraphifyStats,
  captureGraphifyStatsViaReport,
} from '../session/metrics.js';
import type { ExecFn } from '../session/metrics.js';

/**
 * PostToolUse hook handler. Composes all enforcement checks.
 * Returns null if all clean, or a combined violation message.
 */
export function handlePostToolUse(
  tool: string,
  args: Record<string, unknown>,
  tracker: FileTracker,
  cache: SessionCache,
  config: HarnessConfig,
  execFn?: ExecFn,
): string | null {
  const metric = incrementMetric(tool, args);
  if (metric) {
    cache.incrementMetricCounter(metric);
  }

  const violations: string[] = [];

  // Track file edits
  if (tool === 'Edit' || tool === 'Write') {
    const filePath = args.file_path as string;
    if (filePath) {
      tracker.recordEdit(filePath);

      // Constitutional check on edited test files
      const content = (args.new_string as string) ?? '';
      const constitutional = checkConstitutional(filePath, content, config);
      if (constitutional) violations.push(constitutional);
    }

    // Stale test check
    const stale = checkStaleTests(tracker, config);
    if (stale) violations.push(stale);
  }

  // Zero-defect check on test command output
  if (tool === 'Bash') {
    const command = args.command as string;
    const output = args.output as string;

    if (command && output) {
      // Check if this was a test run
      const isTestCommand = /vitest|jest|pytest|mocha/.test(command);
      if (isTestCommand) {
        const changedFiles = cache.getChangedFiles();
        const zeroDefect = checkZeroDefect(output, config, changedFiles.length > 0 ? changedFiles : undefined);
        if (zeroDefect) violations.push(zeroDefect);
      }
    }
  }

  // Capture graphify stats for external directories accessed via jcodemunch
  // or built directly with `graphify update` in Bash
  const external = extractExternalDirectory(tool, args);
  if (external && execFn) {
    try {
      // The Bash trigger fires right after `graphify update` completed — read
      // the report directly instead of re-checking/re-building the graph.
      const stats = external.source === 'bash'
        ? captureGraphifyStatsViaReport(external.dir, execFn)
        : captureExternalGraphifyStats(external.dir, execFn);
      if (stats) {
        cache.setGraphifyStats(resolve(external.dir), stats);
      }
    } catch {
      // graphify not available — skip silently
    }
  }

  if (violations.length === 0) return null;

  // Return combined violations separated by separator
  return violations.join('\n\n---\n\n');
}

const BASH_GRAPHIFY_UPDATE = /\bgraphify(?:y)?\s+update\s+(?:"([^"]+)"|'([^']+)'|(\S+))/;

/**
 * Extract an external (non-CWD) directory path from jcodemunch tool calls or
 * a Bash `graphify update <dir>` command. Returns null for CWD paths or
 * unrecognized tools. The source distinguishes the just-built Bash case
 * (read report directly) from MCP indexing (may need a build first).
 */
function extractExternalDirectory(
  tool: string,
  args: Record<string, unknown>,
): { dir: string; source: 'mcp' | 'bash' } | null {
  let directory: string | undefined;
  let source: 'mcp' | 'bash' = 'mcp';

  if (tool === 'mcp__jcodemunch__index_folder') {
    directory = (args.path as string) ?? (args.folder_path as string);
  } else if (tool === 'mcp__jcodemunch__resolve_repo') {
    directory = args.path as string;
  } else if (tool === 'Bash' && typeof args.command === 'string') {
    const match = args.command.match(BASH_GRAPHIFY_UPDATE);
    if (match) {
      directory = match[1] ?? match[2] ?? match[3];
      source = 'bash';
    }
  }

  if (!directory) return null;
  const cwd = process.cwd();
  if (directory.startsWith(cwd)) return null;
  return { dir: directory, source };
}

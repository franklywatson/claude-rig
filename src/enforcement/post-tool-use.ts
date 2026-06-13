import { resolve } from 'node:path';
import { FileTracker } from './file-tracker.js';
import { SessionCache } from '../session/cache.js';
import type { EnforcementViolation, HarnessConfig } from '../types.js';
import { checkStaleTests, staleSetKey } from './stale-test.js';
import { checkConstitutional } from './constitutional.js';
import { checkZeroDefect } from './zero-defect.js';
import {
  incrementMetric,
  captureExternalGraphifyStats,
  captureGraphifyStatsViaReport,
} from '../session/metrics.js';
import type { ExecFn } from '../session/metrics.js';

/**
 * Extract a Bash command's output from the PostToolUse payload.
 *
 * Claude Code delivers command output in `tool_response` — either a plain
 * string or an object carrying `stdout`/`stderr` (joined here because test
 * runners routinely report failures on stderr). `tool_input.output` is kept
 * as a fallback for older harnesses and hand-built fixtures; it is never
 * populated by current Claude Code payloads.
 */
export function extractBashOutput(
  toolResponse: unknown,
  args: Record<string, unknown>,
): string | undefined {
  if (typeof toolResponse === 'string' && toolResponse.length > 0) {
    return toolResponse;
  }
  if (toolResponse && typeof toolResponse === 'object') {
    const response = toolResponse as Record<string, unknown>;
    const parts = [response.stdout, response.stderr].filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );
    if (parts.length > 0) return parts.join('\n');
  }
  const legacy = args.output;
  return typeof legacy === 'string' && legacy.length > 0 ? legacy : undefined;
}

/**
 * PostToolUse hook handler. Composes all enforcement checks.
 * Returns null if all clean, or a combined violation whose level is derived
 * from the checks themselves (any block-level violation → 'block') — never
 * from message text, which can embed arbitrary tool output.
 *
 * `toolResponse` is the hook payload's `tool_response` field — the real
 * channel for command output (see extractBashOutput).
 */
export function handlePostToolUse(
  tool: string,
  args: Record<string, unknown>,
  tracker: FileTracker,
  cache: SessionCache,
  config: HarnessConfig,
  execFn?: ExecFn,
  toolResponse?: unknown,
): EnforcementViolation | null {
  // Batch every cache mutation this invocation makes (turn counter,
  // edited-file sets, turn-stamped history, stale key, metric counters) into a
  // single session-cache file write instead of one write per setter.
  return cache.transaction(() =>
    runPostToolChecks(tool, args, tracker, cache, config, execFn, toolResponse),
  );
}

function runPostToolChecks(
  tool: string,
  args: Record<string, unknown>,
  tracker: FileTracker,
  cache: SessionCache,
  config: HarnessConfig,
  execFn?: ExecFn,
  toolResponse?: unknown,
): EnforcementViolation | null {
  const metric = incrementMetric(tool, args);
  if (metric) {
    cache.incrementMetricCounter(metric);
  }

  const violations: EnforcementViolation[] = [];

  // Track skill-chain phase transitions so other hooks (e.g. the PreToolUse
  // test-scope check) can read the current phase from the session cache.
  if (tool === 'Skill') {
    const phase = skillToPhase(args.skill);
    if (phase) {
      // Entering a scoped-execution phase from a different phase (or none)
      // starts a new feature: clear the edit history so test-scope
      // suggestions don't accumulate every file edited all session.
      // Re-entering the same phase keeps the in-progress feature's edits.
      if (SCOPED_PHASES.includes(phase) && cache.getCurrentPhase() !== phase) {
        cache.clearEditedFiles();
      }
      cache.setPhase(phase);
    }
  }

  // Track file edits
  if (tool === 'Edit' || tool === 'Write') {
    const filePath = args.file_path as string;

    // Cross-process turn model: hooks run as separate processes, so the
    // FileTracker arrives empty and its in-memory turn counter never
    // advances — which made the creation-turn exemption apply forever and
    // left the stale-test check dormant. A "turn" is one PostToolUse
    // Edit/Write invocation: the counter and the turn-stamped edit history
    // persist in the session cache. An empty tracker (the real hook case)
    // is hydrated from history; a tracker that already carries edits
    // (same-process reuse in unit tests) is left intact to avoid duplicates.
    const turn = cache.advanceEditTurn();
    if (tracker.getSourceEdits().length === 0 && tracker.getTestEdits().length === 0) {
      for (const edit of cache.getEditHistory()) {
        tracker.setTurn(edit.turn);
        tracker.recordEdit(edit.file);
      }
    }
    // Never rewind: a same-process tracker may have advanced its own turn
    // (nextTurn) past the cache counter; the effective turn is the max.
    tracker.setTurn(Math.max(turn, tracker.getTurn()));

    if (filePath) {
      tracker.recordEdit(filePath);

      // Persist to the session cache: hooks run as separate processes, so the
      // in-memory FileTracker resets between invocations. The cache is what
      // lets the PreToolUse test-scope check and the stale-test turn model
      // see prior edits.
      const category = tracker.classifyFile(filePath);
      if (category === 'source' || category === 'test') {
        cache.addEditedFile(filePath, category);
        cache.recordEditTurn(filePath, turn);
      }

      // Constitutional check on edited test files
      const content = (args.new_string as string) ?? '';
      const constitutional = checkConstitutional(filePath, content, config);
      if (constitutional) violations.push(constitutional);
    }

    // Stale test check — gated on a change to the stale source-file set so an
    // unchanged (often growing) list is not re-emitted on every Edit/Write.
    // updateStaleKey runs on every Edit/Write to track transitions, including
    // the set clearing to empty (which resets the dedup so a later relapse
    // re-fires); checkStaleTests still returns null when nothing is stale.
    if (cache.updateStaleKey(staleSetKey(tracker, config))) {
      const stale = checkStaleTests(tracker, config);
      if (stale) violations.push(stale);
    }
  }

  // Zero-defect check on test command output
  if (tool === 'Bash') {
    const command = args.command as string;
    const output = extractBashOutput(toolResponse, args);

    if (command && output) {
      // Check if this was a test run
      const isTestCommand = /vitest|jest|pytest|mocha/.test(command);
      if (isTestCommand) {
        const changedFiles = cache.getChangedFiles();
        const zeroDefect = checkZeroDefect(
          output,
          config,
          changedFiles.length > 0 ? changedFiles : undefined,
          cache.getCurrentPhase(),
        );
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

  // Combine violations: level is the max severity across the checks.
  return {
    level: violations.some(v => v.level === 'block') ? 'block' : 'advise',
    message: violations.map(v => v.message).join('\n\n---\n\n'),
  };
}

/** Phases whose entry resets the edited-file history (scoped test execution).
 * Mirrors SCOPED_PHASES in test-scope.ts — both must list the phases where
 * test runs are scoped to the current feature's edits. */
const SCOPED_PHASES = ['tdd+', 'sdd+'];

/** Skill-name → skill-chain phase. Keys cover the installed skill directory
 * names plus the bare phase aliases. `investigate` is an alias for debug+.
 * Must stay in sync with PHASE_ORDER in src/skills/phase-tracker.ts — every
 * chain phase needs a reachable skill name here (enforced by a sync test). */
export const SKILL_PHASE_MAP: Record<string, string> = {
  'brain-plus': 'brain+',
  'plan-plus': 'plan+',
  'tdd-plus': 'tdd+',
  'sdd-plus': 'sdd+',
  'verify-plus': 'verify+',
  'review-plus': 'review+',
  'debug-plus': 'debug+',
  'investigate': 'debug+',
  'brain+': 'brain+',
  'plan+': 'plan+',
  'tdd+': 'tdd+',
  'sdd+': 'sdd+',
  'verify+': 'verify+',
  'review+': 'review+',
  'debug+': 'debug+',
};

/** Map a Skill tool invocation's skill name to a chain phase, stripping any
 * plugin namespace prefix (`my-plugin:tdd-plus` → `tdd-plus`). */
function skillToPhase(skill: unknown): string | null {
  if (typeof skill !== 'string') return null;
  const bare = skill.split(':').pop() ?? '';
  return SKILL_PHASE_MAP[bare] ?? null;
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

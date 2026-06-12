import { FileTracker } from './file-tracker.js';
import type { HarnessConfig } from '../types.js';

const UNSCOPED_TEST_PATTERNS = [
  { pattern: /^(npx\s+)?vitest\s+run\s*$/, runner: 'npx vitest run' },
  { pattern: /^(npx\s+)?jest\s*$/, runner: 'npx jest' },
  { pattern: /^pytest\s*$/, runner: 'pytest' },
  { pattern: /^(npx\s+)?mocha\s*$/, runner: 'npx mocha' },
];

function isUnscopedTestRun(command: string): string | null {
  const trimmed = command.trim();
  for (const { pattern, runner } of UNSCOPED_TEST_PATTERNS) {
    if (pattern.test(trimmed)) return runner;
  }
  return null;
}

function isAllowedUnscoped(command: string, allowed: string[]): boolean {
  return allowed.some(a => command.includes(a));
}

/**
 * Derive the expected test file path for a given source file path.
 * src/router/resolver.ts → tests/router/resolver.test.ts
 */
function deriveTestPath(sourcePath: string): string {
  const dir = sourcePath.replace(/^src\//, 'tests/');
  const base = dir.replace(/\.[tj]sx?$/, '.test.ts');
  return base;
}

/**
 * Check if a test command should be scoped based on the current phase and
 * recent source edits. Returns null if no redirect needed.
 */
export function checkTestScope(
  command: string,
  currentPhase: string | null,
  tracker: FileTracker,
  config: HarnessConfig,
): string | null {
  // Only enforce during tdd+ phase
  // TODO: include 'sdd+' when checkTestScope is wired into the pipeline (sdd+ tasks also run scoped)
  if (currentPhase !== 'tdd+') return null;

  const runner = isUnscopedTestRun(command);
  if (!runner) return null;

  const allowed = config.rules.test_scope?.allowed_unscoped ?? [];
  if (isAllowedUnscoped(command, allowed)) return null;

  const sourceEdits = tracker.getSourceEdits();
  if (sourceEdits.length === 0) return null;

  const enforcement = config.rules.test_scope?.enforcement ?? 'advise';
  const prefix = enforcement === 'block' ? '[BLOCK]' : '[ADVISE]';

  const testPaths = sourceEdits.map(e => deriveTestPath(e.file));
  const scopedCommand = `${runner} ${testPaths.join(' ')}`;

  const lines = [
    `${prefix} TEST SCOPE REDIRECT`,
    '',
    `Running the full test suite, but recent changes affect:`,
    ...sourceEdits.map(e => `  - ${e.file}`),
    '',
    `During iterative fix cycles, run scoped tests only:`,
    `  ${scopedCommand}`,
    '',
    `Full suite runs are reserved for the verify+ phase (final verification).`,
  ];

  return lines.join('\n');
}

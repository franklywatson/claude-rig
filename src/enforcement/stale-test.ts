import { FileTracker } from './file-tracker.js';
import type { EnforcementViolation, HarnessConfig } from '../types.js';

/**
 * Check if source files were edited without corresponding test file updates.
 * Returns null if no stale tests detected, or a violation carrying its level.
 */
export function checkStaleTests(tracker: FileTracker, config: HarnessConfig): EnforcementViolation | null {
  const gracePeriod = config.rules.stale_tests?.grace_period ?? 0;
  const enforcement = config.rules.stale_tests?.enforcement ?? 'advise';
  if (enforcement === 'silent') return null;
  const stale = tracker.getStaleSources(gracePeriod);

  if (stale.length === 0) return null;

  const level = enforcement === 'block' ? 'block' : 'advise';
  const prefix = level === 'block' ? '[BLOCK]' : '[ADVISE]';
  const currentTurn = stale.reduce((max, s) => Math.max(max, s.turn), 0);

  const lines = [
    `${prefix} STALE TEST WARNING`,
    '',
    'The following source files were modified without updating their tests:',
  ];

  for (const edit of stale) {
    const turnsAgo = currentTurn - edit.turn + 1;
    const turnsLabel = turnsAgo === 1 ? '1 turn ago' : `${turnsAgo} turns ago`;
    lines.push(`  - ${edit.file} (edited ${turnsLabel})`);
  }

  lines.push('');
  lines.push('These test passes may be false positives — the tests still validate old behavior.');
  lines.push('Either update the tests to reflect the changes, or explicitly confirm the changes');
  lines.push("don't affect test assertions.");

  return { level, message: lines.join('\n') };
}

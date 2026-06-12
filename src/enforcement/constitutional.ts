import type { EnforcementViolation, HarnessConfig } from '../types.js';

const MOCK_PATTERNS = [
  /jest\.mock\(/,
  /vi\.mock\(/,
  /from\s+['"]unittest\.mock['"]/,
  /@patch\(/,
  /Mock\(/,
  /createMock\(/,
  /\.mock\(\{/,
];

const TEST_FILE_PATTERNS = [
  /\.test\.[tj]sx?$/,
  /\.spec\.[tj]sx?$/,
  /(^|\/)tests?\//,
  /\/__tests__\//,
  /\/test_\w+\.py$/,
];

const STACK_TEST_PATTERNS = [
  /\.stack\.test\./,
  /\.e2e\.test\./,
  /\.e2e\.spec\./,
  /(^|\/)stack-tests?\//,
  /(^|\/)e2e\//,
];

const EVIDENCELESS_PASS_PATTERNS = [
  /\btests? (all )?pass(ed)?\b/i,
  /\ball tests pass\b/i,
  /\btest suite passes\b/i,
];

function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some(p => p.test(filePath));
}

export function isStackOrE2ETest(filePath: string): boolean {
  return STACK_TEST_PATTERNS.some(p => p.test(filePath));
}

/**
 * Check a file's content against constitutional rules.
 * Returns null if all rules satisfied, or a violation carrying its level.
 */
export function checkConstitutional(
  filePath: string,
  content: string,
  config: HarnessConfig,
): EnforcementViolation | null {
  // Rule: no_mocks — only applies to stack/E2E test files
  const mockLevel = config.rules.constitutional?.no_mocks ?? 'advise';
  if (mockLevel !== 'silent' && isStackOrE2ETest(filePath)) {
    const mockMatch = MOCK_PATTERNS.find(p => p.test(content));
    if (mockMatch) {
      const level = mockLevel === 'block' ? 'block' : 'advise';
      const prefix = level === 'block' ? '[BLOCK]' : '[ADVISE]';
      return {
        level,
        message: [
          `${prefix} Constitutional Rule: no_mocks`,
          '',
          `Stack/E2E test file contains a mock: ${mockMatch.source}`,
          '',
          'Use real dependencies in stack/E2E tests.',
          'Mocks are appropriate in unit tests for isolation.',
          'In stack and E2E tests, use real databases, services, and caches.',
        ].join('\n'),
      };
    }
  }

  // Rule: evidence_only — check for unsupported claims of success
  const evidenceLevel = config.rules.constitutional?.evidence_only ?? 'block';
  if (evidenceLevel !== 'silent') {
    const hasEvidencelessClaim = EVIDENCELESS_PASS_PATTERNS.some(p => p.test(content));
    const hasEvidence = content.includes('```') || content.includes('✓') || content.includes('PASS');
    if (hasEvidencelessClaim && !hasEvidence) {
      const level = evidenceLevel === 'block' ? 'block' : 'advise';
      const prefix = level === 'block' ? '[BLOCK]' : '[ADVISE]';
      return {
        level,
        message: [
          `${prefix} Constitutional Rule: evidence_only`,
          '',
          'Claim of test success without evidence. "Tests pass" is not evidence.',
          'Show the test output — command run, actual output, then claim done.',
        ].join('\n'),
      };
    }
  }

  return null;
}

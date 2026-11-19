import { describe, expect, it } from 'vitest';
import { isSingleTestCommand } from '../../src/enforcement/test-command.js';

describe('single test commands on the failure event', () => {
  it.each([
    'vitest run', 'npx vitest run', 'npx jest --ci', 'pytest -q', 'mocha',
    'npm test', 'npm t', 'npm run test:unit', 'npm -w pkg test', 'npm --prefix web test',
    'pnpm test', 'yarn run test:ci', 'bun test', 'go test ./...', 'cargo test',
    'python -m pytest', 'python -m unittest discover', 'cd "web app" && npm test',
    'CI=1 pytest -q', 'cd web && CI=true npx vitest run 2>&1 | tail -20',
    'npm test|head', 'pytest -q | grep "a|b"', 'go test ./... 2>&1 | tee run.log',
  ])('recognizes %s', command => expect(isSingleTestCommand(command)).toBe(true));

  it.each([
    'git commit -m "test: fix vitest flake"', 'ls /nope', 'echo "npm test"', 'vitest.config.ts',
    'npm testing', 'go testing', 'npm run build && npm test', 'npm test && npm run lint',
    'npm test || true', 'npm test; exit 1', 'npm test\nls', 'npm test\n', 'npm\u00a0test', 'npm test &',
    'npm test | npm run lint', 'npm test | tail | head', 'npm test | tee log; ls',
    'npm test > out', 'npm test "$(other)"', 'cd web || npm test', 'CI=1 make test',
  ])('skips %s', command => expect(isSingleTestCommand(command)).toBe(false));
});

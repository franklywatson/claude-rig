import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initCommand } from '../../src/cli/init.js';
import { runHook, readSessionCache } from '../helpers/hook-runner.js';

describe('PostToolUse hook E2E', () => {
  // npx tsx may need to install on first run in CI
  const HOOK_TIMEOUT = 30_000;
  let tempDir: string;
  let hookPath: string;

  // Clean operations and advise-level violations exit 0. Only block-level
  // violations exit 2 (stderr is fed back to the agent — the tool already
  // ran, so nothing is rejected).
  function expectNonBlock(result: { exitCode: number }) {
    expect(result.exitCode).not.toBe(2);
  }

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'rig-e2e-post-'));
    await initCommand(tempDir, { force: false });
    hookPath = join(tempDir, '.claude', 'hooks', 'scripts', 'post-tool-use.ts');
    expect(existsSync(hookPath)).toBe(true);
  }, HOOK_TIMEOUT);

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('exits 0 for non-test source file edit', async () => {
    const result = await runHook(hookPath, {
      tool_name: 'Edit',
      tool_input: {
        file_path: 'src/router/resolver.ts',
        old_string: 'foo',
        new_string: 'bar',
      },
    }, tempDir);

    expectNonBlock(result);
  });

  it('exits 0 for mock in unit test file (no_mocks only applies to stack/E2E tests)', async () => {
    const result = await runHook(hookPath, {
      tool_name: 'Edit',
      tool_input: {
        file_path: 'tests/router/resolver.test.ts',
        old_string: 'old',
        new_string: 'vi.mock("some-module")',
      },
    }, tempDir);

    expectNonBlock(result);
  });

  it('exits 0 for test file edit without mocks', async () => {
    const result = await runHook(hookPath, {
      tool_name: 'Edit',
      tool_input: {
        file_path: 'tests/router/resolver.test.ts',
        old_string: 'old',
        new_string: 'expect(true).toBe(true)',
      },
    }, tempDir);

    expectNonBlock(result);
  });

  it('exits 2 and surfaces zero-defect violation on stderr for failing test output', async () => {
    // zero_defect.tolerance defaults to strict → [BLOCK]-level violation.
    // PostToolUse exit 2 cannot undo the tool call, but Claude Code feeds
    // stderr back to the agent as an error — the agent-visible channel.
    const result = await runHook(hookPath, {
      tool_name: 'Bash',
      tool_input: {
        command: 'npx vitest run tests/foo.test.ts',
        output: ' FAIL  tests/foo.test.ts\n' +
          ' ✗ should work\n' +
          '   AssertionError: expected true to be false\n\n' +
          ' Test Files  1 failed (1)',
      },
    }, tempDir);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('ZERO-DEFECT');
  }, HOOK_TIMEOUT);

  it('exits 0 for test command with passing output', async () => {
    const result = await runHook(hookPath, {
      tool_name: 'Bash',
      tool_input: {
        command: 'npx vitest run tests/foo.test.ts',
        output: ' Test Files  1 passed (1)\n' +
          '      Tests  5 passed (5)',
      },
    }, tempDir);

    expectNonBlock(result);
  });

  it('exits 0 for non-test bash commands', async () => {
    const result = await runHook(hookPath, {
      tool_name: 'Bash',
      tool_input: {
        command: 'ls -la',
        output: 'total 0\ndrwxr-xr-x',
      },
    }, tempDir);

    expectNonBlock(result);
  });

  it('emits advise-level violations as agent-visible additionalContext JSON', async () => {
    // no_mocks defaults to advise; a mock in a stack test file fires it.
    const result = await runHook(hookPath, {
      tool_name: 'Edit',
      tool_input: {
        file_path: 'tests/router/resolver.stack.test.ts',
        old_string: 'old',
        new_string: 'vi.mock("some-module")',
      },
    }, tempDir);

    expect(result.exitCode).toBe(0);
    const jsonLine = result.stdout.split('\n').find(l => l.trim().startsWith('{'));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine as string);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('no_mocks');
  }, HOOK_TIMEOUT);

  it('exits 2 with stderr for block-level violations (evidence_only)', async () => {
    // evidence_only defaults to block; an evidence-less pass claim fires it.
    const result = await runHook(hookPath, {
      tool_name: 'Edit',
      tool_input: {
        file_path: 'src/notes.ts',
        old_string: 'old',
        new_string: '// all tests pass',
      },
    }, tempDir);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('evidence_only');
    expect(result.stdout).not.toContain('hookSpecificOutput');
  }, HOOK_TIMEOUT);

  it('emits no JSON on stdout for clean operations', async () => {
    const result = await runHook(hookPath, {
      tool_name: 'Bash',
      tool_input: { command: 'echo hello', output: 'hello' },
    }, tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('hookSpecificOutput');
  }, HOOK_TIMEOUT);

  it('runs successfully for various tool types', async () => {
    // Verify multiple tool types all exit cleanly
    const tools = [
      { tool_name: 'Read', tool_input: { file_path: '/some/file.ts' } },
      { tool_name: 'Bash', tool_input: { command: 'ls', output: '' } },
      { tool_name: 'Glob', tool_input: { pattern: '**/*.ts' } },
    ];

    for (const input of tools) {
      const result = await runHook(hookPath, input, tempDir);
      expectNonBlock(result);
    }
  });
});

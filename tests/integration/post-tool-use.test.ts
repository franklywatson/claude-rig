import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { initCommand } from '../../src/cli/init.js';
import { runHook } from '../helpers/hook-runner.js';
import { SessionCache, sessionCachePath } from '../../src/session/cache.js';

// FIXTURE REALISM PRINCIPLE: e2e fixtures must mimic the harness, not the
// implementation's assumptions. Claude Code's PostToolUse payload carries
// session_id, hook_event_name, tool_name, tool_input, and tool_response —
// command output lives in tool_response (a string, or an object with
// stdout/stderr), never in tool_input.output. Fixtures that speak the hook's
// internal dialect can pass while the check is dormant in every live session
// (exactly what happened to zero-defect before this audit). The single
// tool_input.output fixture below is an explicit back-compat test for the
// legacy fallback and is labeled as such.

describe('PostToolUse hook E2E', () => {
  // npx tsx may need to install on first run in CI
  const HOOK_TIMEOUT = 30_000;
  const SESSION_ID = 'e2e-post-real';
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
    // The hook subprocess persists edit tracking to a session cache keyed by
    // (tempDir, SESSION_ID) — remove the exact paths so /tmp doesn't
    // accumulate fixtures. Never glob-delete: real sessions own sibling
    // cache files.
    for (const path of [SESSION_ID, undefined, 'failed-tdd', 'failed-compound'].map(id => sessionCachePath(tempDir, id))) {
      if (existsSync(path)) unlinkSync(path);
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('PostToolUseFailure', () => {
    const failedTest = {
      session_id: 'failed-test', hook_event_name: 'PostToolUseFailure', is_interrupt: false,
      tool_name: 'Bash', tool_input: { command: 'npx vitest run' },
      error: 'Exit code 1\nFAIL tests/foo.test.ts\nTests: 1 failed',
    };

    const build = '> app@1.0.0 build\n> tsc\n';
    const test = '> app@1.0.0 test\n> vitest run\n';
    const lint = '> app@1.0.0 lint\n> tsc --noEmit\n';
    const compiler = 'src/a.ts(3,5): error TS2322';
    const red = '\n RUN  v5.1.1 /repo\n\n ❯ tests/add.test.ts (1 test | 1 failed) 4ms\n' +
      '   × adds 3ms\n\n FAIL  tests/add.test.ts > adds\nAssertionError: expected 1 to be 2\n\n' +
      ' Test Files  1 failed (1)\n      Tests  1 failed (1)\n';
    const green = '\n RUN  v5.1.1 /repo\n ✓ reports error TS2322\n Test Files  1 passed (1)\n Tests  1 passed (1)\n';
    const bt = 'npm run build && npm test';
    const tl = 'npm test && npm run lint';
    const direct = 'npx vitest run && npm run lint';
    const advice = JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PostToolUseFailure',
      additionalContext: 'The combined command failed and its output contains a Vitest summary reporting a failure. ' +
        'Run the test step separately to confirm its own exit status.',
    } }) + '\n';

    it.each([
      ['F1 build failure', bt, build + compiler, ''],
      ['F2 build then red', bt, build + test + red, advice],
      ['F4 red before lint', tl, test + red, advice],
      ['F5 lint after green', tl, test + green + lint + compiler, ''],
      ['F7 direct Vitest failure', direct, red, advice],
      ['green title quoting a compiler error', tl, test + green, ''],
      ['1 MiB line', direct, red + 'x'.repeat(1024 * 1024), ''],
    ])('handles %s without creating a cache', async (_name, command, body, stdout) => {
      const payload = { ...failedTest, tool_input: { command }, error: 'Exit code 1\n' + body };
      expect(await runHook(hookPath, payload, tempDir)).toMatchObject({ exitCode: 0, stdout, stderr: '' });
      expect(existsSync(sessionCachePath(tempDir, failedTest.session_id))).toBe(false);
    }, HOOK_TIMEOUT);

    // A physical seed needs the directory used by SessionCache on this platform.
    const hasCacheDir = existsSync(dirname(sessionCachePath('.')));
    it.runIf(hasCacheDir)('preserves seeded cache bytes when advising', async () => {
      const session_id = 'failed-compound';
      new SessionCache(tempDir, session_id).setPhase('tdd+');
      const path = sessionCachePath(tempDir, session_id);
      const before = readFileSync(path);
      const payload = { ...failedTest, session_id, tool_input: { command: tl }, error: 'Exit code 1\n' + test + red };
      expect(await runHook(hookPath, payload, tempDir)).toMatchObject({ exitCode: 0, stdout: advice, stderr: '' });
      expect(readFileSync(path)).toEqual(before);
    }, HOOK_TIMEOUT);

    it.each(['npx vitest run', 'npm test'])('blocks a failed %s', async command => {
      const result = await runHook(hookPath, { ...failedTest, tool_input: { command } }, tempDir);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('FAIL tests/foo.test.ts');
      expect(result.stdout).toBe('');
      expect(existsSync(sessionCachePath(tempDir, failedTest.session_id))).toBe(false);
    }, HOOK_TIMEOUT);

    it.each([
      ['Bash', { command: 'npm run build && npm test' }, 'ERROR src/build.ts'],
      ['Bash', { command: 'npm test && npm run lint' }, 'ERROR src/lint.ts'],
      ['Bash', { command: 'ls /nope' }, 'No such file or directory'],
      ['Edit', { file_path: 'src/foo.ts', new_string: 'b' }, 'Edit failed'],
      ['Write', { file_path: 'src/foo.ts', content: 'b' }, 'Write failed'],
      ['Read', { file_path: 'src/foo.ts' }, 'Read failed'],
    ])('stays quiet for %s %j', async (tool_name, tool_input, error) => {
      const result = await runHook(hookPath, { ...failedTest, tool_name, tool_input, error }, tempDir);
      expect(result).toMatchObject({ exitCode: 0, stdout: '', stderr: '' });
      expect(existsSync(sessionCachePath(tempDir, failedTest.session_id))).toBe(false);
    }, HOOK_TIMEOUT);

    it('returns a tdd+ advisory on the failure event and preserves the session cache', async () => {
      const session_id = 'failed-tdd';
      const skill = await runHook(hookPath, {
        session_id, hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'tdd-plus' },
      }, tempDir);
      expect(skill.exitCode).toBe(0);
      const path = sessionCachePath(tempDir, session_id);
      const before = readFileSync(path, 'utf8');
      const result = await runHook(hookPath, { ...failedTest, session_id }, tempDir);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).hookSpecificOutput).toEqual({
        hookEventName: 'PostToolUseFailure', additionalContext: expect.stringContaining('[ADVISE] ZERO-DEFECT'),
      });
      expect(readFileSync(path, 'utf8')).toBe(before);
    }, HOOK_TIMEOUT);
  });

  it('stays quiet when a passing npm test prints a FAIL line', async () => {
    const result = await runHook(hookPath, {
      session_id: SESSION_ID, hook_event_name: 'PostToolUse', tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { stdout: 'FAIL src/x.ts (fixture output)\nTests: 1 passed', stderr: '' },
    }, tempDir);
    expect(result).toMatchObject({ exitCode: 0, stdout: '', stderr: '' });
  }, HOOK_TIMEOUT);

  it.each(['npm test', 'npx vitest run'])('reports only the genuine failure from %s', async command => {
    const result = await runHook(hookPath, {
      session_id: SESSION_ID, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash',
      tool_input: { command }, is_interrupt: false,
      error: 'Exit code 1\n✓ reports error TS2322\n\x1b[31mFAIL\x1b[0m tests/red.test.ts\nTests: 1 failed',
    }, tempDir);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('1 failure(s) found:\n  FAIL tests/red.test.ts');
    expect(result.stderr).not.toContain('TS2322');
  }, HOOK_TIMEOUT);

  it('exits 0 for non-test source file edit', async () => {
    const result = await runHook(hookPath, {
      session_id: SESSION_ID,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: {
        file_path: 'src/router/resolver.ts',
        old_string: 'foo',
        new_string: 'bar',
      },
      tool_response: { filePath: 'src/router/resolver.ts' },
    }, tempDir);

    expectNonBlock(result);
  });

  it('exits 0 for mock in unit test file (no_mocks only applies to stack/E2E tests)', async () => {
    const result = await runHook(hookPath, {
      session_id: SESSION_ID,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: {
        file_path: 'tests/router/resolver.test.ts',
        old_string: 'old',
        new_string: 'vi.mock("some-module")',
      },
      tool_response: { filePath: 'tests/router/resolver.test.ts' },
    }, tempDir);

    expectNonBlock(result);
  });

  it('exits 0 for test file edit without mocks', async () => {
    const result = await runHook(hookPath, {
      session_id: SESSION_ID,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: {
        file_path: 'tests/router/resolver.test.ts',
        old_string: 'old',
        new_string: 'expect(true).toBe(true)',
      },
      tool_response: { filePath: 'tests/router/resolver.test.ts' },
    }, tempDir);

    expectNonBlock(result);
  });

  it('exits 2 and surfaces zero-defect violation on stderr for failing test output in tool_response', async () => {
    // zero_defect.tolerance defaults to strict → block-level violation.
    // PostToolUse exit 2 cannot undo the tool call, but Claude Code feeds
    // stderr back to the agent as an error — the agent-visible channel.
    // Output arrives in tool_response.{stdout,stderr}, the real channel.
    const result = await runHook(hookPath, {
      session_id: SESSION_ID,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: {
        command: 'npx vitest run tests/foo.test.ts',
        description: 'Run foo tests',
      },
      tool_response: {
        stdout: ' FAIL  tests/foo.test.ts\n' +
          ' ✗ should work\n' +
          '   AssertionError: expected true to be false\n\n' +
          ' Test Files  1 failed (1)',
        stderr: '',
        interrupted: false,
        isImage: false,
      },
    }, tempDir);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('ZERO-DEFECT');
  }, HOOK_TIMEOUT);

  it('fires zero-defect when the failure output lands on tool_response stderr', async () => {
    const result = await runHook(hookPath, {
      session_id: SESSION_ID,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npx vitest run tests/foo.test.ts' },
      tool_response: {
        stdout: 'RUN v3.0.0',
        stderr: ' FAIL  tests/foo.test.ts\n Test Files  1 failed (1)',
        interrupted: false,
        isImage: false,
      },
    }, tempDir);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('ZERO-DEFECT');
  }, HOOK_TIMEOUT);

  it('still fires zero-defect via the legacy tool_input.output fallback (BACK-COMPAT, not the real payload shape)', async () => {
    // Explicit back-compat coverage: older harnesses and hand-built probes
    // put output on tool_input.output. The fallback must keep working, but
    // no other fixture in this file may use this dialect.
    const result = await runHook(hookPath, {
      tool_name: 'Bash',
      tool_input: {
        command: 'npx vitest run tests/foo.test.ts',
        output: ' FAIL  tests/foo.test.ts\n Test Files  1 failed (1)',
      },
    }, tempDir);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('ZERO-DEFECT');
  }, HOOK_TIMEOUT);

  it('exits 0 for test command with passing output', async () => {
    const result = await runHook(hookPath, {
      session_id: SESSION_ID,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npx vitest run tests/foo.test.ts' },
      tool_response: {
        stdout: ' Test Files  1 passed (1)\n' +
          '      Tests  5 passed (5)',
        stderr: '',
        interrupted: false,
        isImage: false,
      },
    }, tempDir);

    expectNonBlock(result);
  });

  it('exits 0 for non-test bash commands', async () => {
    const result = await runHook(hookPath, {
      session_id: SESSION_ID,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
      tool_response: { stdout: 'total 0\ndrwxr-xr-x', stderr: '', interrupted: false, isImage: false },
    }, tempDir);

    expectNonBlock(result);
  });

  it('emits advise-level violations as agent-visible additionalContext JSON', async () => {
    // no_mocks defaults to advise; a mock in a stack test file fires it.
    const result = await runHook(hookPath, {
      session_id: SESSION_ID,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: {
        file_path: 'tests/router/resolver.stack.test.ts',
        old_string: 'old',
        new_string: 'vi.mock("some-module")',
      },
      tool_response: { filePath: 'tests/router/resolver.stack.test.ts' },
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
      session_id: SESSION_ID,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: {
        file_path: 'src/notes.ts',
        old_string: 'old',
        new_string: '// all tests pass',
      },
      tool_response: { filePath: 'src/notes.ts' },
    }, tempDir);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('evidence_only');
    expect(result.stdout).not.toContain('hookSpecificOutput');
  }, HOOK_TIMEOUT);

  it('emits no JSON on stdout for clean operations', async () => {
    const result = await runHook(hookPath, {
      session_id: SESSION_ID,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
      tool_response: { stdout: 'hello', stderr: '', interrupted: false, isImage: false },
    }, tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('hookSpecificOutput');
  }, HOOK_TIMEOUT);

  it('does not escalate advise-level output that embeds the literal [BLOCK] string', async () => {
    // Severity must come from the checks' structured level, not from
    // sniffing the message text: an advise-level zero-defect violation whose
    // embedded test output contains the literal string '[BLOCK]' (e.g. a
    // failing test that asserts on the prefix) must stay advise-level.
    const adviseDir = mkdtempSync(join(tmpdir(), 'rig-e2e-post-advise-'));
    try {
      await initCommand(adviseDir, { force: false });
      // Lower zero_defect to advise-level so the violation is advisory.
      writeFileSync(join(adviseDir, '.harness.yaml'), [
        'rules:',
        '  zero_defect:',
        '    tolerance: permissive',
        '    unrelated_errors: advise',
        '',
      ].join('\n'));

      const result = await runHook(
        join(adviseDir, '.claude', 'hooks', 'scripts', 'post-tool-use.ts'),
        {
          session_id: SESSION_ID,
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'npx vitest run' },
          tool_response: {
            stdout: "FAIL tests/hooks.test.ts > emits the '[BLOCK]' prefix\n" +
              'Tests: 1 failed',
            stderr: '',
            interrupted: false,
            isImage: false,
          },
        },
        adviseDir,
      );

      expect(result.exitCode).toBe(0);
      const jsonLine = result.stdout.split('\n').find(l => l.trim().startsWith('{'));
      expect(jsonLine).toBeDefined();
      const parsed = JSON.parse(jsonLine as string);
      expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('ZERO-DEFECT');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('[BLOCK]');
    } finally {
      for (const path of [sessionCachePath(adviseDir, SESSION_ID), sessionCachePath(adviseDir)]) {
        if (existsSync(path)) unlinkSync(path);
      }
      rmSync(adviseDir, { recursive: true, force: true });
    }
  }, HOOK_TIMEOUT);

  describe('stale-test detection across hook processes', () => {
    // Each hook invocation is a separate process with a fresh FileTracker —
    // the turn counter and edit history must come from the session cache or
    // the creation-turn exemption applies forever and the check is dormant.
    const STALE_SESSION = 'e2e-post-stale';

    function editPayload(file: string) {
      return {
        session_id: STALE_SESSION,
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: 'a', new_string: 'b' },
        tool_response: { filePath: file },
      };
    }

    afterAll(() => {
      const path = sessionCachePath(tempDir, STALE_SESSION);
      if (existsSync(path)) unlinkSync(path);
    });

    it('fires the stale-test advisory on the second consecutive source edit', async () => {
      const first = await runHook(hookPath, editPayload('src/feature/widget.ts'), tempDir);
      expect(first.exitCode).toBe(0);
      expect(first.stdout).not.toContain('STALE TEST');

      const second = await runHook(hookPath, editPayload('src/feature/widget.ts'), tempDir);
      expect(second.exitCode).toBe(0);
      const jsonLine = second.stdout.split('\n').find(l => l.trim().startsWith('{'));
      expect(jsonLine).toBeDefined();
      const parsed = JSON.parse(jsonLine as string);
      expect(parsed.hookSpecificOutput.additionalContext).toContain('STALE TEST');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('src/feature/widget.ts');
    }, HOOK_TIMEOUT);

    it('stops firing once a covering test edit lands in a later invocation', async () => {
      const testEdit = await runHook(hookPath, editPayload('tests/feature/widget.test.ts'), tempDir);
      expect(testEdit.exitCode).toBe(0);

      const third = await runHook(hookPath, editPayload('src/feature/widget.ts'), tempDir);
      expect(third.exitCode).toBe(0);
      expect(third.stdout).not.toContain('STALE TEST');
    }, HOOK_TIMEOUT);
  });

  it('runs successfully for various tool types', async () => {
    // Verify multiple tool types all exit cleanly
    const tools = [
      {
        session_id: SESSION_ID,
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/some/file.ts' },
        tool_response: { type: 'text', file: { filePath: '/some/file.ts' } },
      },
      {
        session_id: SESSION_ID,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false },
      },
      {
        session_id: SESSION_ID,
        hook_event_name: 'PostToolUse',
        tool_name: 'Glob',
        tool_input: { pattern: '**/*.ts' },
        tool_response: { filenames: [], numFiles: 0 },
      },
    ];

    for (const input of tools) {
      const result = await runHook(hookPath, input, tempDir);
      expectNonBlock(result);
    }
  });
});

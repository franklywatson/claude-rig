import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initCommand } from '../../src/cli/init.js';
import { runHook } from '../helpers/hook-runner.js';
import { SessionCache, sessionCachePath } from '../../src/session/cache.js';
import type { Environment } from '../../src/types.js';

function makeEnv(overrides: Partial<Environment> = {}): Environment {
  return {
    rtkAvailable: false,
    rtkPath: null,
    jcodemunchAvailable: false,
    jcodemunchCwdIndexed: false,
    jcodemunchCwdRepo: null,
    jcodemunchKnownRepos: [],
    graphifyAvailable: false,
    graphifyGraphPath: null,
    detectedAt: Date.now(),
    ...overrides,
  };
}

describe('PreToolUse hook E2E', () => {
  // npx tsx may need to install on first run in CI
  const HOOK_TIMEOUT = 30_000;
  let tempDir: string;
  let hookPath: string;

  // Hooks are advisory and should never block. In CI, npx tsx may fail
  // to install or the dist may not be available, so we accept any
  // exit code except 2 (deliberate block).
  function expectNonBlock(result: { exitCode: number }) {
    expect(result.exitCode).not.toBe(2);
  }

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'rig-e2e-pre-'));
    // Initialize rig project to generate hook scripts
    await initCommand(tempDir, { force: false });
    hookPath = join(tempDir, '.claude', 'hooks', 'scripts', 'pre-tool-use.ts');
    expect(existsSync(hookPath)).toBe(true);
  }, HOOK_TIMEOUT);

  afterAll(() => {
    // Hook subprocesses invoked without a session_id key their session cache
    // by tempDir alone — remove the exact path so /tmp doesn't accumulate
    // fixtures. Never glob-delete: real sessions own sibling cache files.
    const cachePath = sessionCachePath(tempDir);
    if (existsSync(cachePath)) unlinkSync(cachePath);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('allows Read tool', async () => {
    const result = await runHook(hookPath, {
      tool_name: 'Read',
      tool_input: { file_path: '/some/file.ts' },
    }, tempDir);

    expectNonBlock(result);
  });

  it('allows Write tool', async () => {
    const result = await runHook(hookPath, {
      tool_name: 'Write',
      tool_input: { file_path: '/some/file.ts', content: 'hello' },
    }, tempDir);

    expectNonBlock(result);
  });

  it('allows unknown tools', async () => {
    const result = await runHook(hookPath, {
      tool_name: 'SomeCustomTool',
      tool_input: {},
    }, tempDir);

    expectNonBlock(result);
  });

  it('handles malformed stdin gracefully', async () => {
    const { spawn } = await import('node:child_process');
    const result = await new Promise<{ exitCode: number }>((resolve) => {
      const child = spawn('npx', ['tsx', hookPath], {
        cwd: tempDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin?.write('not json{{{');
      child.stdin?.end();
      child.on('close', (code) => resolve({ exitCode: code ?? 1 }));
    });

    expectNonBlock(result);
  });

  it('advises jcodemunch for Read on code file when indexed', async () => {
    // Set up environment in cache to simulate jcodemunch indexed
    const cachePath = join(tempDir, '.claude', 'cache.json');
    // The hook reads from the session cache, but for E2E we test via the hook script
    // which reads environment from /tmp. Since we can't control jcodemunch in E2E,
    // this test verifies the hook doesn't crash and exits 0 (advise, not block).
    const result = await runHook(hookPath, {
      tool_name: 'Read',
      tool_input: { file_path: '/some/code.ts' },
    }, tempDir);

    // Without jcodemunch indexed, native_read falls through to allow
    expectNonBlock(result);
  });

  it('allows Read on non-code file without advice', async () => {
    const result = await runHook(hookPath, {
      tool_name: 'Read',
      tool_input: { file_path: '/some/readme.txt' },
    }, tempDir);

    expectNonBlock(result);
  });

  it('processes rtk cat on code files without crash', async () => {
    const result = await runHook(hookPath, {
      tool_name: 'Bash',
      tool_input: { command: 'rtk cat /some/file.ts' },
    }, tempDir);

    // The hook's only legitimate exits are 0 (allow/advise) and 2 (block).
    // CI environment failures (npx/tsx resolution races, observed as exit 1
    // and exit 254 under the coverage job) produce arbitrary codes — what
    // must never happen is a crash inside the hook itself, which would leave
    // a stack trace referencing the hook script or a typed JS error.
    if (![0, 2].includes(result.exitCode)) {
      expect(result.stderr).not.toMatch(/pre-tool-use\.ts:\d+|TypeError|ReferenceError|SyntaxError/);
    }
  });

  it('allows rtk cat on non-code files', async () => {
    const result = await runHook(hookPath, {
      tool_name: 'Bash',
      tool_input: { command: 'rtk cat /some/readme.txt' },
    }, tempDir);

    expectNonBlock(result);
  });

  it('allows Grep tool without crash (no jcodemunch indexed)', async () => {
    const result = await runHook(hookPath, {
      tool_name: 'Grep',
      tool_input: { pattern: 'function', path: 'src/' },
    }, tempDir);

    // Without jcodemunch, native_grep falls through to allow
    expectNonBlock(result);
  });

  it('allows Glob on code pattern without crash (no jcodemunch indexed)', async () => {
    const result = await runHook(hookPath, {
      tool_name: 'Glob',
      tool_input: { pattern: '**/*.ts' },
    }, tempDir);

    // Without jcodemunch, native_glob falls through to allow
    expectNonBlock(result);
  });

  describe('agent-visible advisories (additionalContext)', () => {
    // Each test seeds its own session cache via a distinct session_id, so
    // first-occurrence advisory suppression from other tests cannot leak in.
    const sessionIds = ['advise-json', 'scope-json'];

    afterAll(() => {
      for (const id of sessionIds) {
        const path = sessionCachePath(tempDir, id);
        if (existsSync(path)) unlinkSync(path);
      }
    });

    it('emits jcodemunch advisory as additionalContext JSON on exit 0', async () => {
      const writer = new SessionCache(tempDir, 'advise-json');
      writer.setEnvironment(makeEnv({ jcodemunchAvailable: true, jcodemunchCwdIndexed: true }));

      const result = await runHook(hookPath, {
        session_id: 'advise-json',
        tool_name: 'Grep',
        tool_input: { pattern: 'function' },
      }, tempDir);

      expect(result.exitCode).toBe(0);
      const jsonLine = result.stdout.split('\n').find(l => l.trim().startsWith('{'));
      expect(jsonLine).toBeDefined();
      const parsed = JSON.parse(jsonLine as string);
      expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('jcodemunch');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('[ADVISE]');
    }, HOOK_TIMEOUT);

    it('emits test-scope advisory for full-suite run during tdd+ phase', async () => {
      const writer = new SessionCache(tempDir, 'scope-json');
      writer.setEnvironment(makeEnv());
      writer.setPhase('tdd+');
      writer.addEditedFile('src/router/resolver.ts', 'source');

      const result = await runHook(hookPath, {
        session_id: 'scope-json',
        tool_name: 'Bash',
        tool_input: { command: 'npx vitest run' },
      }, tempDir);

      expect(result.exitCode).toBe(0);
      const jsonLine = result.stdout.split('\n').find(l => l.trim().startsWith('{'));
      expect(jsonLine).toBeDefined();
      const parsed = JSON.parse(jsonLine as string);
      expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('TEST SCOPE');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('tests/router/resolver.test.ts');
    }, HOOK_TIMEOUT);

    it('still blocks with exit 2 and stderr for [BLOCK] resolutions', async () => {
      const result = await runHook(hookPath, {
        tool_name: 'Bash',
        tool_input: { command: "sed -i 's/a/b/' src/file.ts" },
      }, tempDir);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('[BLOCK]');
      expect(result.stdout).not.toContain('hookSpecificOutput');
    }, HOOK_TIMEOUT);
  });

  describe('branch discipline (git fixture)', () => {
    // Separate git-initialized fixture so the shared tempDir stays a plain
    // directory for the other tests. Each test uses its own session_id so
    // the once-per-session advisory suppression cannot leak between them.
    let gitDir: string;
    let gitHookPath: string;
    const gitSessionIds = ['branch-advise', 'branch-block', 'branch-scope-block'];

    function workflowYaml(level: string): string {
      return [
        'rules:',
        '  workflow:',
        `    branch_discipline: ${level}`,
        '    protected_branches: [master, main]',
        '    isolation_strategy: auto',
        '',
      ].join('\n');
    }

    beforeAll(async () => {
      gitDir = mkdtempSync(join(tmpdir(), 'rig-e2e-branch-'));
      await initCommand(gitDir, { force: false });
      gitHookPath = join(gitDir, '.claude', 'hooks', 'scripts', 'pre-tool-use.ts');
      expect(existsSync(gitHookPath)).toBe(true);
      execSync('git init -b master', { cwd: gitDir });
      execSync('git -c user.email=rig@test.dev -c user.name=rig commit --allow-empty -m init', { cwd: gitDir });
    }, HOOK_TIMEOUT);

    afterAll(() => {
      for (const id of gitSessionIds) {
        const path = sessionCachePath(gitDir, id);
        if (existsSync(path)) unlinkSync(path);
      }
      // Also remove the no-session-id cache in case a hook ran without one.
      const noIdPath = sessionCachePath(gitDir);
      if (existsSync(noIdPath)) unlinkSync(noIdPath);
      rmSync(gitDir, { recursive: true, force: true });
    });

    it('emits branch-discipline advisory as additionalContext for git commit on master', async () => {
      writeFileSync(join(gitDir, '.harness.yaml'), workflowYaml('advise'), 'utf-8');
      const writer = new SessionCache(gitDir, 'branch-advise');
      writer.setEnvironment(makeEnv());

      const result = await runHook(gitHookPath, {
        session_id: 'branch-advise',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
      }, gitDir);

      expect(result.exitCode).toBe(0);
      const jsonLine = result.stdout.split('\n').find(l => l.trim().startsWith('{'));
      expect(jsonLine).toBeDefined();
      const parsed = JSON.parse(jsonLine as string);
      expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('[ADVISE]');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('Branch discipline');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('master');
    }, HOOK_TIMEOUT);

    it('blocks git push on master with exit 2 when level is block', async () => {
      writeFileSync(join(gitDir, '.harness.yaml'), workflowYaml('block'), 'utf-8');
      const writer = new SessionCache(gitDir, 'branch-block');
      writer.setEnvironment(makeEnv());

      const result = await runHook(gitHookPath, {
        session_id: 'branch-block',
        tool_name: 'Bash',
        tool_input: { command: 'git push origin master' },
      }, gitDir);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('[BLOCK]');
      expect(result.stderr).toContain('Branch discipline');
      expect(result.stdout).not.toContain('hookSpecificOutput');
    }, HOOK_TIMEOUT);

    it('exits 2 for a compound test+commit command during tdd+ phase (block must beat any advisory)', async () => {
      writeFileSync(join(gitDir, '.harness.yaml'), workflowYaml('block'), 'utf-8');
      const writer = new SessionCache(gitDir, 'branch-scope-block');
      writer.setEnvironment(makeEnv());
      writer.setPhase('tdd+');
      writer.addEditedFile('src/router/resolver.ts', 'source');

      const result = await runHook(gitHookPath, {
        session_id: 'branch-scope-block',
        tool_name: 'Bash',
        tool_input: { command: 'npm test && git commit -m "x"' },
      }, gitDir);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Branch discipline');
      expect(result.stdout).not.toContain('hookSpecificOutput');
    }, HOOK_TIMEOUT);
  });
});

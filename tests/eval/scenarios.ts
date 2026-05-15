import type { Environment, PythonEnv } from '../../src/types.js';

// ── Environment presets ──

export interface EnvPreset {
  name: string;
  env: Environment;
}

export const ENV_PRESETS: EnvPreset[] = [
  {
    name: 'full',
    env: {
      rtkAvailable: true,
      rtkPath: '/usr/bin/rtk',
      jcodemunchAvailable: true,
      jcodemunchCwdIndexed: true,
      jcodemunchCwdRepo: 'local/test',
      jcodemunchKnownRepos: ['local/test'],
      graphifyAvailable: true,
      graphifyGraphPath: 'graphify-out/graph.json',
      graphBuildInfo: { state: 'ready', graphPath: 'graphify-out/graph.json' },
      detectedAt: Date.now(),
    },
  },
  {
    name: 'rtk_only',
    env: {
      rtkAvailable: true,
      rtkPath: '/usr/bin/rtk',
      jcodemunchAvailable: false,
      jcodemunchCwdIndexed: false,
      jcodemunchCwdRepo: null,
      jcodemunchKnownRepos: [],
      graphifyAvailable: false,
      graphifyGraphPath: null,
      detectedAt: Date.now(),
    },
  },
  {
    name: 'jm_only',
    env: {
      rtkAvailable: false,
      rtkPath: null,
      jcodemunchAvailable: true,
      jcodemunchCwdIndexed: true,
      jcodemunchCwdRepo: 'local/test',
      jcodemunchKnownRepos: ['local/test'],
      graphifyAvailable: true,
      graphifyGraphPath: 'graphify-out/graph.json',
      graphBuildInfo: { state: 'ready', graphPath: 'graphify-out/graph.json' },
      detectedAt: Date.now(),
    },
  },
  {
    name: 'jm_not_indexed',
    env: {
      rtkAvailable: false,
      rtkPath: null,
      jcodemunchAvailable: true,
      jcodemunchCwdIndexed: false,
      jcodemunchCwdRepo: null,
      jcodemunchKnownRepos: [],
      graphifyAvailable: false,
      graphifyGraphPath: null,
      detectedAt: Date.now(),
    },
  },
  {
    name: 'neither',
    env: {
      rtkAvailable: false,
      rtkPath: null,
      jcodemunchAvailable: false,
      jcodemunchCwdIndexed: false,
      jcodemunchCwdRepo: null,
      jcodemunchKnownRepos: [],
      graphifyAvailable: false,
      graphifyGraphPath: null,
      detectedAt: Date.now(),
    },
  },
];

// ── Scenario types ──

export interface ExpectedOutcome {
  action: 'rewrite' | 'advise' | 'block' | 'allow';
  tool?: string; // substring expected in the rewritten command or hook output
}

export interface EvalScenario {
  id: string;
  category: 'bash' | 'native' | 'agent' | 'pipe' | 'edge' | 'python';
  description: string;
  toolCall: { tool: string; args: Record<string, unknown> };
  expected: Record<string, ExpectedOutcome>; // keyed by env preset name
  cwd?: string; // for Python environment rewrite scenarios
}

// ── Mock rtk rewrite function ──
// Simulates `rtk rewrite <command>` for eval tests.
// Only rewrites commands that rtk's rules cover.

export function mockRtkRewrite(rtkPath: string, args: string[]): string | null {
  const command = args[1]; // args = ['rewrite', command]
  if (!command) return null;

  // cat/head/tail → rtk read
  if (/^\s*(cat|head|tail)\s+/.test(command)) {
    return command.replace(/^\s*(cat|head|tail)\s+/, 'rtk read ');
  }

  // grep/rg → rtk grep
  if (/^\s*(grep|rg)\s+/.test(command)) {
    return command.replace(/^\s*(grep|rg)\s+/, 'rtk grep ');
  }

  // find → rtk find
  if (/^\s*find\s+/.test(command)) {
    return command.replace(/^\s*find\s+/, 'rtk find ');
  }

  // fd → rtk find (rtk treats fd as a find synonym)
  if (/^\s*fd\s+/.test(command)) {
    return command.replace(/^\s*fd\s+/, 'rtk find ');
  }

  // ls → rtk ls
  if (/^\s*ls(\s|$)/.test(command)) {
    return command.replace(/^\s*ls\s*/, 'rtk ls ');
  }

  // git → rtk git
  if (/^\s*git\s+/.test(command)) {
    return command.replace(/^\s*git\s+/, 'rtk git ');
  }

  // gh → rtk gh
  if (/^\s*gh\s+/.test(command)) {
    return command.replace(/^\s*gh\s+/, 'rtk gh ');
  }

  // No rewrite for everything else (sed, npm, docker, echo, etc.)
  return null;
}

// ── Baseline scenarios ──

export const ALL_SCENARIOS: EvalScenario[] = [
  // ── Bash commands: transparent rewrite when rtk available ──

  {
    id: 'bash_cat_code',
    category: 'bash',
    description: 'cat a code file via Bash — transparent rewrite to rtk read',
    toolCall: { tool: 'Bash', args: { command: 'cat src/router/resolver.ts' } },
    expected: {
      full: { action: 'rewrite', tool: 'rtk read' },
      rtk_only: { action: 'rewrite', tool: 'rtk read' },
      jm_only: { action: 'advise', tool: 'jcodemunch' },
      jm_not_indexed: { action: 'advise', tool: 'Read' },
      neither: { action: 'advise', tool: 'Read' },
    },
  },

  {
    id: 'bash_head_code',
    category: 'bash',
    description: 'head a code file via Bash — transparent rewrite to rtk read',
    toolCall: { tool: 'Bash', args: { command: 'head -20 package.json' } },
    expected: {
      full: { action: 'rewrite', tool: 'rtk read' },
      rtk_only: { action: 'rewrite', tool: 'rtk read' },
      jm_only: { action: 'advise', tool: 'jcodemunch' },
      jm_not_indexed: { action: 'advise', tool: 'Read' },
      neither: { action: 'advise', tool: 'Read' },
    },
  },

  {
    id: 'bash_grep',
    category: 'bash',
    description: 'grep via Bash — transparent rewrite to rtk grep',
    toolCall: { tool: 'Bash', args: { command: 'grep -r "TODO" src/' } },
    expected: {
      full: { action: 'rewrite', tool: 'rtk grep' },
      rtk_only: { action: 'rewrite', tool: 'rtk grep' },
      jm_only: { action: 'advise', tool: 'jcodemunch' },
      jm_not_indexed: { action: 'advise', tool: 'Grep' },
      neither: { action: 'advise', tool: 'Grep' },
    },
  },

  {
    id: 'bash_rg',
    category: 'bash',
    description: 'rg (ripgrep) via Bash — transparent rewrite to rtk grep',
    toolCall: { tool: 'Bash', args: { command: 'rg "export.*function" .' } },
    expected: {
      full: { action: 'rewrite', tool: 'rtk grep' },
      rtk_only: { action: 'rewrite', tool: 'rtk grep' },
      jm_only: { action: 'advise', tool: 'jcodemunch' },
      jm_not_indexed: { action: 'advise', tool: 'Grep' },
      neither: { action: 'advise', tool: 'Grep' },
    },
  },

  {
    id: 'bash_find',
    category: 'bash',
    description: 'find via Bash — transparent rewrite to rtk find',
    toolCall: { tool: 'Bash', args: { command: 'find . -name "*.ts"' } },
    expected: {
      full: { action: 'rewrite', tool: 'rtk find' },
      rtk_only: { action: 'rewrite', tool: 'rtk find' },
      jm_only: { action: 'advise', tool: 'jcodemunch' },
      jm_not_indexed: { action: 'advise', tool: 'Glob' },
      neither: { action: 'advise', tool: 'Glob' },
    },
  },

  {
    id: 'bash_sed_i',
    category: 'bash',
    description: 'sed -i via Bash — always blocked (resolution-level block)',
    toolCall: { tool: 'Bash', args: { command: "sed -i 's/foo/bar/' file.ts" } },
    expected: {
      full: { action: 'block' },
      rtk_only: { action: 'block' },
      jm_only: { action: 'block' },
      jm_not_indexed: { action: 'block' },
      neither: { action: 'block' },
    },
  },

  {
    id: 'bash_git_status',
    category: 'bash',
    description: 'git status — transparent rewrite to rtk git status',
    toolCall: { tool: 'Bash', args: { command: 'git status' } },
    expected: {
      full: { action: 'rewrite', tool: 'rtk git' },
      rtk_only: { action: 'rewrite', tool: 'rtk git' },
      jm_only: { action: 'allow' },
      jm_not_indexed: { action: 'allow' },
      neither: { action: 'allow' },
    },
  },

  // ── Native tools (no rewrite — these are Claude tools, not Bash) ──

  {
    id: 'native_read_code',
    category: 'native',
    description: 'Read a code file without offset/limit',
    toolCall: { tool: 'Read', args: { file_path: '/project/src/router/resolver.ts' } },
    expected: {
      full: { action: 'advise', tool: 'jcodemunch' },
      rtk_only: { action: 'allow' },
      jm_only: { action: 'advise', tool: 'jcodemunch' },
      jm_not_indexed: { action: 'allow' },
      neither: { action: 'allow' },
    },
  },

  {
    id: 'native_read_noncode',
    category: 'native',
    description: 'Read a non-code file',
    toolCall: { tool: 'Read', args: { file_path: '/project/README.md' } },
    expected: {
      full: { action: 'allow' },
      rtk_only: { action: 'allow' },
      jm_only: { action: 'allow' },
      jm_not_indexed: { action: 'allow' },
      neither: { action: 'allow' },
    },
  },

  {
    id: 'native_grep',
    category: 'native',
    description: 'Grep tool — advise jcodemunch when indexed',
    toolCall: { tool: 'Grep', args: { pattern: 'function resolve' } },
    expected: {
      full: { action: 'advise', tool: 'jcodemunch' },
      rtk_only: { action: 'allow' },
      jm_only: { action: 'advise', tool: 'jcodemunch' },
      jm_not_indexed: { action: 'allow' },
      neither: { action: 'allow' },
    },
  },

  {
    id: 'native_glob_code',
    category: 'native',
    description: 'Glob with code file pattern',
    toolCall: { tool: 'Glob', args: { pattern: '**/*.ts' } },
    expected: {
      full: { action: 'advise', tool: 'jcodemunch' },
      rtk_only: { action: 'allow' },
      jm_only: { action: 'advise', tool: 'jcodemunch' },
      jm_not_indexed: { action: 'allow' },
      neither: { action: 'allow' },
    },
  },

  {
    id: 'native_glob_noncode',
    category: 'native',
    description: 'Glob with non-code pattern (matches file_discovery via TOOL_INTENT_MAP)',
    toolCall: { tool: 'Glob', args: { pattern: '*.md' } },
    expected: {
      full: { action: 'advise', tool: 'rtk find' },
      rtk_only: { action: 'advise', tool: 'rtk find' },
      jm_only: { action: 'advise', tool: 'jcodemunch' },
      jm_not_indexed: { action: 'advise', tool: 'Glob' },
      neither: { action: 'advise', tool: 'Glob' },
    },
  },

  // ── Agent tool calls (no Bash rewrite — Agent tool isn't Bash) ──

  {
    id: 'agent_explore',
    category: 'agent',
    description: 'Agent with Explore subagent (scout_explore when jcodemunch, file_discovery otherwise)',
    toolCall: { tool: 'Agent', args: { subagent_type: 'Explore', prompt: 'find auth files' } },
    expected: {
      full: { action: 'advise', tool: 'scout' },
      rtk_only: { action: 'advise', tool: 'rtk find' },
      jm_only: { action: 'advise', tool: 'scout' },
      jm_not_indexed: { action: 'advise', tool: 'scout' },
      neither: { action: 'advise', tool: 'Glob' },
    },
  },

  {
    id: 'agent_general',
    category: 'agent',
    description: 'Agent with general-purpose subagent (pass_through)',
    toolCall: { tool: 'Agent', args: { subagent_type: 'general-purpose', prompt: 'fix the bug' } },
    expected: {
      full: { action: 'allow' },
      rtk_only: { action: 'allow' },
      jm_only: { action: 'allow' },
      jm_not_indexed: { action: 'allow' },
      neither: { action: 'allow' },
    },
  },

  // ── Pipe and compound commands ──

  {
    id: 'pipe_grep_output',
    category: 'pipe',
    description: 'piped grep as output filter — rtk skips pipes, falls through to allow',
    toolCall: { tool: 'Bash', args: { command: 'docker compose build 2>&1 | grep -E "error|Error"' } },
    expected: {
      full: { action: 'allow' },
      rtk_only: { action: 'allow' },
      jm_only: { action: 'allow' },
      jm_not_indexed: { action: 'allow' },
      neither: { action: 'allow' },
    },
  },

  {
    id: 'pipe_cat_grep',
    category: 'pipe',
    description: 'piped cat | grep — compound command passes through without rewrite or advisory',
    toolCall: { tool: 'Bash', args: { command: 'cat file | grep pattern' } },
    expected: {
      full: { action: 'allow' },
      rtk_only: { action: 'allow' },
      jm_only: { action: 'allow' },
      jm_not_indexed: { action: 'allow' },
      neither: { action: 'allow' },
    },
  },

  {
    id: 'compound_grep_sed',
    category: 'pipe',
    description: 'compound grep ; sed -i — always blocked (file_modify)',
    toolCall: { tool: 'Bash', args: { command: "rg pattern . ; sed -i 's/a/b/g' f" } },
    expected: {
      full: { action: 'block' },
      rtk_only: { action: 'block' },
      jm_only: { action: 'block' },
      jm_not_indexed: { action: 'block' },
      neither: { action: 'block' },
    },
  },

  // ── Edge cases ──

  {
    id: 'edge_read_offset',
    category: 'edge',
    description: 'Read code file with offset (targeted re-read)',
    toolCall: { tool: 'Read', args: { file_path: '/project/src/types.ts', offset: 10, limit: 20 } },
    expected: {
      full: { action: 'allow' },
      rtk_only: { action: 'allow' },
      jm_only: { action: 'allow' },
      jm_not_indexed: { action: 'allow' },
      neither: { action: 'allow' },
    },
  },

  {
    id: 'edge_rtk_cat_code',
    category: 'edge',
    description: 'rtk cat on code file — blocked (resolution-level block)',
    toolCall: { tool: 'Bash', args: { command: 'rtk cat src/types.ts' } },
    expected: {
      full: { action: 'block' },
      rtk_only: { action: 'block' },
      jm_only: { action: 'block' },
      jm_not_indexed: { action: 'block' },
      neither: { action: 'block' },
    },
  },

  {
    id: 'edge_passthrough',
    category: 'edge',
    description: 'npm test — rtk has no rewrite rule, falls through to allow',
    toolCall: { tool: 'Bash', args: { command: 'npm test' } },
    expected: {
      full: { action: 'allow' },
      rtk_only: { action: 'allow' },
      jm_only: { action: 'allow' },
      jm_not_indexed: { action: 'allow' },
      neither: { action: 'allow' },
    },
  },

  {
    id: 'edge_cat_noncode',
    category: 'edge',
    description: 'cat a non-code file — transparent rewrite',
    toolCall: { tool: 'Bash', args: { command: 'cat /tmp/log.txt' } },
    expected: {
      full: { action: 'rewrite', tool: 'rtk read' },
      rtk_only: { action: 'rewrite', tool: 'rtk read' },
      jm_only: { action: 'advise', tool: 'jcodemunch' },
      jm_not_indexed: { action: 'advise', tool: 'Read' },
      neither: { action: 'advise', tool: 'Read' },
    },
  },

];

// ── Python environment presets ──

export interface PythonEnvPreset {
  name: string;
  pythonEnv: PythonEnv;
  existsCheck: (path: string) => boolean;
}

export const PYTHON_ENV_PRESETS: PythonEnvPreset[] = [
  {
    name: 'venv',
    pythonEnv: { venvPath: '/project/.venv', uvAvailable: false, uvPath: null, detectedAt: Date.now() },
    existsCheck: (p) => p.startsWith('/project/.venv/bin/'),
  },
  {
    name: 'uv_only',
    pythonEnv: { venvPath: null, uvAvailable: true, uvPath: '/usr/bin/uv', detectedAt: Date.now() },
    existsCheck: () => false,
  },
  {
    name: 'both',
    pythonEnv: { venvPath: '/project/.venv', uvAvailable: true, uvPath: '/usr/bin/uv', detectedAt: Date.now() },
    existsCheck: (p) => p.startsWith('/project/.venv/bin/'),
  },
  {
    name: 'no_python',
    pythonEnv: { venvPath: null, uvAvailable: false, uvPath: null, detectedAt: Date.now() },
    existsCheck: () => false,
  },
];

// ── Python eval scenarios ──

export const PYTHON_SCENARIOS: EvalScenario[] = [
  {
    id: 'python_pytest_venv',
    category: 'python',
    description: 'pytest with .py file when venv available → rewrite to .venv/bin/pytest',
    toolCall: { tool: 'Bash', args: { command: 'pytest tests/test_foo.py -v' } },
    cwd: '/project',
    expected: {
      venv: { action: 'rewrite', tool: '.venv/bin/pytest' },
      uv_only: { action: 'rewrite', tool: 'uv run' },
      both: { action: 'rewrite', tool: '.venv/bin/pytest' },
      no_python: { action: 'allow' },
    },
  },
  {
    id: 'python_pytest_uv',
    category: 'python',
    description: 'pytest with .py file when only uv available → rewrite to uv run',
    toolCall: { tool: 'Bash', args: { command: 'pytest tests/test_foo.py -v' } },
    cwd: '/project',
    expected: {
      venv: { action: 'rewrite', tool: '.venv/bin/pytest' },
      uv_only: { action: 'rewrite', tool: 'uv run' },
      both: { action: 'rewrite', tool: '.venv/bin/pytest' },
      no_python: { action: 'allow' },
    },
  },
  {
    id: 'python_pytest_nopy',
    category: 'python',
    description: 'pytest --version — still a Python binary, rewrites even without .py in args',
    toolCall: { tool: 'Bash', args: { command: 'pytest --version' } },
    cwd: '/project',
    expected: {
      venv: { action: 'rewrite', tool: '.venv/bin/pytest' },
      uv_only: { action: 'rewrite', tool: 'uv run' },
      both: { action: 'rewrite', tool: '.venv/bin/pytest' },
      no_python: { action: 'allow' },
    },
  },
  {
    id: 'python_python_venv',
    category: 'python',
    description: 'python with .py file when venv available → rewrite to .venv/bin/python',
    toolCall: { tool: 'Bash', args: { command: 'python src/main.py' } },
    cwd: '/project',
    expected: {
      venv: { action: 'rewrite', tool: '.venv/bin/python' },
      uv_only: { action: 'rewrite', tool: 'uv run' },
      both: { action: 'rewrite', tool: '.venv/bin/python' },
      no_python: { action: 'allow' },
    },
  },
  {
    id: 'python_git_add_py',
    category: 'python',
    description: 'git add with .py files — NOT a Python binary, no rewrite',
    toolCall: { tool: 'Bash', args: { command: 'git add src/store.py tests/test_store.py' } },
    cwd: '/project',
    expected: {
      venv: { action: 'allow' },
      uv_only: { action: 'allow' },
      both: { action: 'allow' },
      no_python: { action: 'allow' },
    },
  },
  {
    id: 'python_compound_git',
    category: 'python',
    description: 'compound git add .py && git commit — no Python rewrite on compound commands',
    toolCall: { tool: 'Bash', args: { command: 'pytest tests/test_foo.py && git add src/store.py' } },
    cwd: '/project',
    expected: {
      venv: { action: 'allow' },
      uv_only: { action: 'allow' },
      both: { action: 'allow' },
      no_python: { action: 'allow' },
    },
  },
  {
    id: 'python_black_venv',
    category: 'python',
    description: 'black formatter with .py file when venv available → rewrite',
    toolCall: { tool: 'Bash', args: { command: 'black src/format_me.py' } },
    cwd: '/project',
    expected: {
      venv: { action: 'rewrite', tool: '.venv/bin/black' },
      uv_only: { action: 'rewrite', tool: 'uv run' },
      both: { action: 'rewrite', tool: '.venv/bin/black' },
      no_python: { action: 'allow' },
    },
  },
];

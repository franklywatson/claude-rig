import { join, relative } from 'node:path';
import { existsSync } from 'node:fs';
import type { PythonEnv } from '../types.js';

const PYTHON_BINARIES = [
  'python', 'python3', 'pip', 'pip3',
  'pytest', 'py.test',
  'ruff', 'black', 'mypy', 'flake8', 'pylint', 'isort',
  'coverage',
  'uv', 'tox', 'nox', 'hatch', 'poetry',
  'pyinstaller', 'celery', 'gunicorn', 'uvicorn',
];

/**
 * Tools that create and manage their own environment. Wrapping them in
 * `uv run` is wrong (`uv run uv run pytest`, `uv run poetry install`), so the
 * `uv run` fallback never applies; a `.venv/bin/<tool>` binary still resolves.
 */
const SELF_MANAGING_BINARIES = ['uv', 'poetry', 'hatch', 'tox', 'nox'];

/**
 * Check if the command's binary is a known Python tool.
 * This is the signal that we're in a Python context —
 * not whether .py files appear in arguments.
 */
export function isPythonBinary(command: string): boolean {
  const binary = command.trimStart().split(/\s+/)[0] ?? '';
  return PYTHON_BINARIES.includes(binary);
}

/**
 * Try to rewrite a Bash command using Python environment detection.
 * Resolution chain:
 * 1. .venv/bin/<binary> exists → rewrite to relative venv path
 * 2. uv available → rewrite to `uv run <command>`, except for tools that
 *    manage their own environment (uv, poetry, hatch, tox, nox)
 * 3. Neither → return null (pass through)
 *
 * Only triggers when the binary is a known Python tool.
 * Uses relative paths to avoid triggering CWD path expansion rules
 * and Claude Code permission prompts on absolute paths.
 */
export function tryPythonRewrite(
  command: string,
  cwd: string,
  pythonEnv: PythonEnv,
  existsCheck: (path: string) => boolean = existsSync,
): string | null {
  if (!isPythonBinary(command)) return null;

  const { venvPath, uvAvailable } = pythonEnv;

  // Extract binary name
  const binary = command.trimStart().split(/\s+/)[0] ?? '';

  // Try .venv/bin/<binary>
  if (venvPath) {
    const venvBinary = join(venvPath, 'bin', binary);
    if (existsCheck(venvBinary)) {
      const relativeBinary = relative(cwd, venvBinary);
      return `${relativeBinary} ${command.slice(command.indexOf(binary) + binary.length).trimStart()}`;
    }
  }

  // Try uv run (self-managing tools bring their own environment)
  if (uvAvailable && !SELF_MANAGING_BINARIES.includes(binary)) {
    return `uv run ${command}`;
  }

  return null;
}

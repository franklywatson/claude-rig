import { describe, it, expect } from 'vitest';
import { isPythonBinary, tryPythonRewrite } from '../../src/router/python-rewrite.js';
import type { PythonEnv } from '../../src/types.js';

function makePythonEnv(overrides: Partial<PythonEnv> = {}): PythonEnv {
  return {
    venvPath: null,
    uvAvailable: false,
    uvPath: null,
    detectedAt: Date.now(),
    ...overrides,
  };
}

describe('isPythonBinary', () => {
  it('matches python', () => {
    expect(isPythonBinary('python src/main.py')).toBe(true);
  });

  it('matches python3', () => {
    expect(isPythonBinary('python3 -m pytest')).toBe(true);
  });

  it('matches pytest', () => {
    expect(isPythonBinary('pytest tests/test_foo.py -v')).toBe(true);
  });

  it('matches pip', () => {
    expect(isPythonBinary('pip install -r requirements.txt')).toBe(true);
  });

  it('matches ruff', () => {
    expect(isPythonBinary('ruff check src/')).toBe(true);
  });

  it('matches black', () => {
    expect(isPythonBinary('black src/main.py')).toBe(true);
  });

  it('matches mypy', () => {
    expect(isPythonBinary('mypy src/')).toBe(true);
  });

  it('matches uv', () => {
    expect(isPythonBinary('uv run pytest')).toBe(true);
  });

  it('matches coverage', () => {
    expect(isPythonBinary('coverage run -m pytest')).toBe(true);
  });

  it('does NOT match git', () => {
    expect(isPythonBinary('git add src/store.py')).toBe(false);
  });

  it('does NOT match git commit with .py in message', () => {
    expect(isPythonBinary('git commit -m "fix store.py bug"')).toBe(false);
  });

  it('does NOT match ls', () => {
    expect(isPythonBinary('ls src/python/')).toBe(false);
  });

  it('does NOT match cat', () => {
    expect(isPythonBinary('cat module.py')).toBe(false);
  });

  it('does NOT match echo', () => {
    expect(isPythonBinary('echo "test.py"')).toBe(false);
  });

  it('does NOT match curl', () => {
    expect(isPythonBinary('curl https://example.com/api.py')).toBe(false);
  });

  it('matches tox', () => {
    expect(isPythonBinary('tox')).toBe(true);
  });

  it('matches nox', () => {
    expect(isPythonBinary('nox')).toBe(true);
  });

  it('matches hatch', () => {
    expect(isPythonBinary('hatch test')).toBe(true);
  });

  it('matches poetry', () => {
    expect(isPythonBinary('poetry run pytest')).toBe(true);
  });
});

describe('tryPythonRewrite', () => {
  const cwd = '/project';

  it('rewrites to .venv/bin/<cmd> when binary exists in venv', () => {
    const pyEnv = makePythonEnv({ venvPath: '/project/.venv' });
    const result = tryPythonRewrite(
      'pytest tests/test_foo.py -v',
      cwd,
      pyEnv,
      (p) => p === '/project/.venv/bin/pytest',
    );
    expect(result).toBe('.venv/bin/pytest tests/test_foo.py -v');
  });

  it('rewrites to uv run when venv missing but uv available', () => {
    const pyEnv = makePythonEnv({ venvPath: null, uvAvailable: true, uvPath: '/usr/bin/uv' });
    const result = tryPythonRewrite(
      'pytest tests/test_foo.py -v',
      cwd,
      pyEnv,
      () => false,
    );
    expect(result).toBe('uv run pytest tests/test_foo.py -v');
  });

  it('prefers venv over uv when both available', () => {
    const pyEnv = makePythonEnv({ venvPath: '/project/.venv', uvAvailable: true, uvPath: '/usr/bin/uv' });
    const result = tryPythonRewrite(
      'pytest tests/test_foo.py -v',
      cwd,
      pyEnv,
      (p) => p === '/project/.venv/bin/pytest',
    );
    expect(result).toBe('.venv/bin/pytest tests/test_foo.py -v');
  });

  it('returns null for non-Python binary even with .py in args', () => {
    const pyEnv = makePythonEnv({ venvPath: '/project/.venv', uvAvailable: true, uvPath: '/usr/bin/uv' });
    const result = tryPythonRewrite(
      'git add src/store.py tests/test_store.py',
      cwd,
      pyEnv,
      () => false,
    );
    expect(result).toBeNull();
  });

  it('returns null for non-Python binary', () => {
    const pyEnv = makePythonEnv({ venvPath: '/project/.venv' });
    const result = tryPythonRewrite(
      'mytool tests/test_foo.py -v',
      cwd,
      pyEnv,
      () => false,
    );
    expect(result).toBeNull();
  });

  it('returns null when no python env at all', () => {
    const pyEnv = makePythonEnv();
    const result = tryPythonRewrite(
      'pytest tests/test_foo.py -v',
      cwd,
      pyEnv,
      () => false,
    );
    expect(result).toBeNull();
  });

  it('handles python -m subcommand', () => {
    const pyEnv = makePythonEnv({ venvPath: '/project/.venv' });
    const result = tryPythonRewrite(
      'python -m pytest tests/test_foo.py',
      cwd,
      pyEnv,
      (p) => p === '/project/.venv/bin/python',
    );
    expect(result).toBe('.venv/bin/python -m pytest tests/test_foo.py');
  });

  it('handles uv fallback when binary not in venv', () => {
    const pyEnv = makePythonEnv({ venvPath: '/project/.venv', uvAvailable: true, uvPath: '/usr/bin/uv' });
    const result = tryPythonRewrite(
      'black tests/test_foo.py',
      cwd,
      pyEnv,
      () => false,
    );
    expect(result).toBe('uv run black tests/test_foo.py');
  });

  it('rewrites pytest --version when venv has pytest', () => {
    const pyEnv = makePythonEnv({ venvPath: '/project/.venv' });
    const result = tryPythonRewrite(
      'pytest --version',
      cwd,
      pyEnv,
      (p) => p === '/project/.venv/bin/pytest',
    );
    expect(result).toBe('.venv/bin/pytest --version');
  });

  describe('tools that manage their own environment', () => {
    const selfManaging = ['uv', 'poetry', 'hatch', 'tox', 'nox'];

    it.each(selfManaging)('never wraps %s in uv run when only uv is available', (tool) => {
      const pyEnv = makePythonEnv({ venvPath: null, uvAvailable: true, uvPath: '/usr/bin/uv' });
      expect(tryPythonRewrite(`${tool} run pytest`, cwd, pyEnv, () => false)).toBeNull();
    });

    it.each(selfManaging)('never wraps %s in uv run when the venv lacks its binary', (tool) => {
      const pyEnv = makePythonEnv({ venvPath: '/project/.venv', uvAvailable: true, uvPath: '/usr/bin/uv' });
      expect(tryPythonRewrite(`${tool} install`, cwd, pyEnv, () => false)).toBeNull();
    });

    it.each(selfManaging)('still resolves %s through .venv/bin when the venv has its binary', (tool) => {
      const pyEnv = makePythonEnv({ venvPath: '/project/.venv', uvAvailable: true, uvPath: '/usr/bin/uv' });
      const result = tryPythonRewrite(
        `${tool} install`,
        cwd,
        pyEnv,
        (p) => p === `/project/.venv/bin/${tool}`,
      );
      expect(result).toBe(`.venv/bin/${tool} install`);
    });

    it.each(['pytest tests/', 'python -m pytest', 'pip install requests', 'ruff check .'])(
      'still wraps %s in uv run',
      (command) => {
        const pyEnv = makePythonEnv({ venvPath: null, uvAvailable: true, uvPath: '/usr/bin/uv' });
        expect(tryPythonRewrite(command, cwd, pyEnv, () => false)).toBe(`uv run ${command}`);
      },
    );
  });
});

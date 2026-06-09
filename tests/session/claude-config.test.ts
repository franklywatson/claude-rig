import { describe, it, expect } from 'vitest';
import { resolveJcodemunchRegistration } from '../../src/session/claude-config.js';

const HOME = '/home/user';
const CWD = '/work/my-project';

// The real-world registration shape that motivated this module: jcodemunch-mcp
// is distributed as a GitHub release wheel, not a PyPI package.
const WHEEL_URL =
  'https://github.com/jgravelle/jcodemunch-mcp/releases/download/v1.108.20/jcodemunch_mcp-1.108.20-py3-none-any.whl';
const WHEEL_REGISTRATION = {
  type: 'stdio',
  command: 'uvx',
  args: ['--from', WHEEL_URL, 'jcodemunch-mcp'],
  env: {},
};

function makeFiles(files: Record<string, string>): {
  readFile: (p: string) => string;
  existsCheck: (p: string) => boolean;
} {
  return {
    readFile: (p: string) => {
      if (p in files) return files[p];
      throw new Error(`ENOENT: ${p}`);
    },
    existsCheck: (p: string) => p in files,
  };
}

describe('resolveJcodemunchRegistration', () => {
  it('finds a user-scope registration in ~/.claude.json mcpServers', () => {
    const { readFile, existsCheck } = makeFiles({
      [`${HOME}/.claude.json`]: JSON.stringify({
        mcpServers: { jcodemunch: WHEEL_REGISTRATION },
      }),
    });

    const reg = resolveJcodemunchRegistration(CWD, readFile, existsCheck, HOME);
    expect(reg).toEqual({
      command: 'uvx',
      args: ['--from', WHEEL_URL, 'jcodemunch-mcp'],
      source: 'user',
    });
  });

  it('prefers project-scope .mcp.json over user scope', () => {
    const { readFile, existsCheck } = makeFiles({
      [`${HOME}/.claude.json`]: JSON.stringify({
        mcpServers: { jcodemunch: WHEEL_REGISTRATION },
      }),
      [`${CWD}/.mcp.json`]: JSON.stringify({
        mcpServers: {
          jcodemunch: { command: '/usr/local/bin/jcodemunch-mcp', args: [] },
        },
      }),
    });

    const reg = resolveJcodemunchRegistration(CWD, readFile, existsCheck, HOME);
    expect(reg).toEqual({
      command: '/usr/local/bin/jcodemunch-mcp',
      args: [],
      source: 'project',
    });
  });

  it('prefers local scope (projects[cwd].mcpServers) over project and user', () => {
    const { readFile, existsCheck } = makeFiles({
      [`${HOME}/.claude.json`]: JSON.stringify({
        mcpServers: { jcodemunch: WHEEL_REGISTRATION },
        projects: {
          [CWD]: {
            mcpServers: {
              jcodemunch: { command: 'local-jcodemunch-mcp', args: ['--local'] },
            },
          },
        },
      }),
      [`${CWD}/.mcp.json`]: JSON.stringify({
        mcpServers: {
          jcodemunch: { command: 'project-jcodemunch-mcp', args: [] },
        },
      }),
    });

    const reg = resolveJcodemunchRegistration(CWD, readFile, existsCheck, HOME);
    expect(reg).toEqual({
      command: 'local-jcodemunch-mcp',
      args: ['--local'],
      source: 'local',
    });
  });

  it('matches by substring when the server is keyed under another name', () => {
    const { readFile, existsCheck } = makeFiles({
      [`${HOME}/.claude.json`]: JSON.stringify({
        mcpServers: {
          'code-index': {
            command: 'uvx',
            args: ['--from', WHEEL_URL, 'jcodemunch-mcp'],
          },
        },
      }),
    });

    const reg = resolveJcodemunchRegistration(CWD, readFile, existsCheck, HOME);
    expect(reg?.command).toBe('uvx');
    expect(reg?.args).toContain('jcodemunch-mcp');
  });

  it('prefers an exact "jcodemunch" key over a substring match', () => {
    const { readFile, existsCheck } = makeFiles({
      [`${HOME}/.claude.json`]: JSON.stringify({
        mcpServers: {
          'jcodemunch-legacy': { command: 'old-jcodemunch-mcp', args: [] },
          jcodemunch: WHEEL_REGISTRATION,
        },
      }),
    });

    const reg = resolveJcodemunchRegistration(CWD, readFile, existsCheck, HOME);
    expect(reg?.command).toBe('uvx');
  });

  it('skips non-stdio transports', () => {
    const { readFile, existsCheck } = makeFiles({
      [`${HOME}/.claude.json`]: JSON.stringify({
        mcpServers: {
          jcodemunch: { type: 'http', url: 'https://example.com/mcp' },
        },
      }),
    });

    expect(resolveJcodemunchRegistration(CWD, readFile, existsCheck, HOME)).toBeNull();
  });

  it('skips entries without a string command', () => {
    const { readFile, existsCheck } = makeFiles({
      [`${HOME}/.claude.json`]: JSON.stringify({
        mcpServers: { jcodemunch: { args: ['jcodemunch-mcp'] } },
      }),
    });

    expect(resolveJcodemunchRegistration(CWD, readFile, existsCheck, HOME)).toBeNull();
  });

  it('defaults args to [] when absent', () => {
    const { readFile, existsCheck } = makeFiles({
      [`${HOME}/.claude.json`]: JSON.stringify({
        mcpServers: { jcodemunch: { type: 'stdio', command: 'jcodemunch-mcp' } },
      }),
    });

    const reg = resolveJcodemunchRegistration(CWD, readFile, existsCheck, HOME);
    expect(reg).toEqual({ command: 'jcodemunch-mcp', args: [], source: 'user' });
  });

  it('falls through to the next scope on malformed JSON', () => {
    const { readFile, existsCheck } = makeFiles({
      [`${HOME}/.claude.json`]: '{ not valid json',
      [`${CWD}/.mcp.json`]: JSON.stringify({
        mcpServers: { jcodemunch: { command: 'jcodemunch-mcp', args: [] } },
      }),
    });

    const reg = resolveJcodemunchRegistration(CWD, readFile, existsCheck, HOME);
    expect(reg?.source).toBe('project');
  });

  it('returns null when no config files exist', () => {
    const { readFile, existsCheck } = makeFiles({});
    expect(resolveJcodemunchRegistration(CWD, readFile, existsCheck, HOME)).toBeNull();
  });

  it('returns null when configs exist but contain no jcodemunch server', () => {
    const { readFile, existsCheck } = makeFiles({
      [`${HOME}/.claude.json`]: JSON.stringify({
        mcpServers: { graphify: { command: 'graphify-mcp', args: [] } },
      }),
      [`${CWD}/.mcp.json`]: JSON.stringify({ mcpServers: {} }),
    });

    expect(resolveJcodemunchRegistration(CWD, readFile, existsCheck, HOME)).toBeNull();
  });

  it('never throws when readFile itself throws unexpectedly', () => {
    const reg = resolveJcodemunchRegistration(
      CWD,
      () => { throw new Error('EACCES'); },
      () => true,
      HOME,
    );
    expect(reg).toBeNull();
  });
});

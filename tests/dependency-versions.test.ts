import { describe, it, expect } from 'vitest';
import {
  parseDependencyManifest,
  renderTestedAgainstLine,
  syncTestedLine,
} from '../src/dependency-versions.js';

const VALID_MANIFEST = {
  tools: [
    {
      name: 'rtk',
      readmeLabel: 'rtk',
      repo: 'rtk-ai/rtk',
      testedVersion: '0.44.1',
    },
    {
      name: 'jcodemunch',
      readmeLabel: 'jcodemunch-mcp',
      repo: 'jgravelle/jcodemunch-mcp',
      testedVersion: '~1.108.x',
      notes: 'wheel-URL uvx installs are supported transports',
    },
  ],
};

describe('parseDependencyManifest', () => {
  it('parses a valid manifest into ordered entries', () => {
    const deps = parseDependencyManifest(VALID_MANIFEST);
    expect(deps).toHaveLength(2);
    expect(deps[0]).toEqual({
      name: 'rtk',
      readmeLabel: 'rtk',
      repo: 'rtk-ai/rtk',
      testedVersion: '0.44.1',
    });
    expect(deps[1].notes).toBe('wheel-URL uvx installs are supported transports');
  });

  it('rejects a manifest without a tools array', () => {
    expect(() => parseDependencyManifest({})).toThrow(/tools/i);
    expect(() => parseDependencyManifest({ tools: 'nope' })).toThrow(/tools/i);
  });

  it('rejects entries missing required fields', () => {
    expect(() =>
      parseDependencyManifest({ tools: [{ name: 'rtk', repo: 'rtk-ai/rtk', testedVersion: '0.44.1' }] }),
    ).toThrow(/readmeLabel/);
    expect(() =>
      parseDependencyManifest({ tools: [{ name: 'rtk', readmeLabel: 'rtk', testedVersion: '0.44.1' }] }),
    ).toThrow(/repo/);
    expect(() =>
      parseDependencyManifest({ tools: [{ readmeLabel: 'rtk', repo: 'rtk-ai/rtk', testedVersion: '0.44.1' }] }),
    ).toThrow(/name/);
  });

  it('rejects malformed repo coordinates (must be owner/repo)', () => {
    expect(() =>
      parseDependencyManifest({
        tools: [{ name: 'rtk', readmeLabel: 'rtk', repo: 'not-a-coordinate', testedVersion: '0.44.1' }],
      }),
    ).toThrow(/owner\/repo/);
  });
});

describe('renderTestedAgainstLine', () => {
  it('renders the README tested-against line in manifest order', () => {
    expect(renderTestedAgainstLine(parseDependencyManifest(VALID_MANIFEST))).toBe(
      '> **Tested against:** rtk 0.44.1 · jcodemunch-mcp ~1.108.x',
    );
  });
});

describe('syncTestedLine', () => {
  const README = [
    '# rig',
    '',
    'A cockpit.',
    '',
    '> **Tested against:** rtk 0.44.1 · jcodemunch-mcp ~1.108.x',
    '',
    'More prose.',
  ].join('\n');

  it('is a no-op (same string) when the line already matches', () => {
    expect(syncTestedLine(README, parseDependencyManifest(VALID_MANIFEST))).toBe(README);
  });

  it('replaces a stale line with the rendered one', () => {
    const stale = README.replace(
      '> **Tested against:** rtk 0.44.1 · jcodemunch-mcp ~1.108.x',
      '> **Tested against:** rtk 0.40.0 · jcodemunch-mcp ~1.100.x',
    );
    expect(syncTestedLine(stale, parseDependencyManifest(VALID_MANIFEST))).toBe(README);
  });

  it('throws a clear error when the marker line is missing', () => {
    expect(() => syncTestedLine('# rig\n\nno marker here\n', parseDependencyManifest(VALID_MANIFEST))).toThrow(
      /Tested against/,
    );
  });
});

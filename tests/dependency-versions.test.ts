import { describe, it, expect } from 'vitest';
import {
  compareTestedVersions,
  mergeDependencyManifests,
  parseDependencyManifest,
  renderTestedAgainstLine,
  syncTestedLine,
} from '../src/dependency-versions.js';
import type { DependencyVersion } from '../src/dependency-versions.js';

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

const rtk = (v: string, notes?: string): DependencyVersion => ({
  name: 'rtk',
  readmeLabel: 'rtk',
  repo: 'rtk-ai/rtk',
  testedVersion: v,
  ...(notes !== undefined ? { notes } : {}),
});

const graphify = (v: string): DependencyVersion => ({
  name: 'graphify',
  readmeLabel: 'graphify',
  repo: 'Graphify-Labs/graphify',
  testedVersion: v,
});

const headroom = (v: string): DependencyVersion => ({
  name: 'headroom',
  readmeLabel: 'headroom',
  repo: 'headroomlabs-ai/headroom',
  testedVersion: v,
});

describe('compareTestedVersions', () => {
  it('orders concrete versions numerically, segment by segment', () => {
    expect(compareTestedVersions('0.46.0', '0.48.0')).toBeLessThan(0);
    expect(compareTestedVersions('0.9.55', '0.9.51')).toBeGreaterThan(0);
    expect(compareTestedVersions('6.3.0', '6.3.0')).toBe(0);
    // numeric, not lexicographic: 10 > 9
    expect(compareTestedVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
  });

  it('compares tilde ranges against concrete versions', () => {
    expect(compareTestedVersions('~1.108.x', '1.109.0')).toBeLessThan(0);
    expect(compareTestedVersions('~1.110.x', '1.109.2')).toBeGreaterThan(0);
    // the x segment sorts below a real patch number
    expect(compareTestedVersions('~1.108.x', '1.108.3')).toBeLessThan(0);
  });

  it('tolerates v prefixes and throws on a non-numeric base segment', () => {
    expect(compareTestedVersions('v0.46.0', '0.48.0')).toBeLessThan(0);
    expect(() => compareTestedVersions('not-a-version', '0.48.0')).toThrow(/testedVersion/);
  });
});

describe('mergeDependencyManifests', () => {
  it('keeps the higher testedVersion entry wholesale when both sides bumped the same tool', () => {
    const ours = [rtk('0.46.0', 'ours notes')];
    const theirs = [rtk('0.48.0', 'theirs notes')];
    expect(mergeDependencyManifests(ours, theirs)).toEqual([rtk('0.48.0', 'theirs notes')]);
  });

  it('keeps ours wholesale on a version tie (PR-side note edits survive)', () => {
    const ours = [rtk('0.46.0', 'ours notes')];
    const theirs = [rtk('0.46.0', 'theirs notes')];
    expect(mergeDependencyManifests(ours, theirs)).toEqual([rtk('0.46.0', 'ours notes')]);
  });

  it('keeps one-sided tools and appends theirs-only after ours order', () => {
    const ours = [rtk('0.46.0'), graphify('0.9.53')];
    const theirs = [graphify('0.9.55'), headroom('0.37.0')];
    expect(mergeDependencyManifests(ours, theirs)).toEqual([
      rtk('0.46.0'),
      graphify('0.9.55'),
      headroom('0.37.0'),
    ]);
  });

  it('surfaces malformed versions as a throw, never a silent pick', () => {
    expect(() => mergeDependencyManifests([rtk('junk')], [rtk('0.48.0')])).toThrow(/testedVersion/);
  });

  it('round-trips a realistic conflicted merge through parseDependencyManifest', () => {
    const oursRaw = JSON.parse(
      JSON.stringify({ tools: [rtk('0.46.0'), graphify('0.9.53'), headroom('0.37.0')] }),
    );
    const theirsRaw = { tools: [graphify('0.9.55')] };
    const merged = mergeDependencyManifests(
      parseDependencyManifest(oursRaw),
      parseDependencyManifest(theirsRaw),
    );
    expect(renderTestedAgainstLine(merged)).toBe(
      '> **Tested against:** rtk 0.46.0 · graphify 0.9.55 · headroom 0.37.0',
    );
  });
});

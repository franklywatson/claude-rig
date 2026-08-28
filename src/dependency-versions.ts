/**
 * Dependency-versions manifest: the machine-checkable source of truth for
 * which panel-tool versions rig is tested against. The README's
 * "Tested against:" line is generated from this manifest (never edited by
 * hand) via `npm run sync:versions`, so release-watch automation
 * (agentic workflows, Dependabot-style bots) has one file to read and one
 * command to run after a bump.
 */

/** One panel tool rig integrates with and the version rig is tested against. */
export interface DependencyVersion {
  /** Internal key (e.g. "jcodemunch") — stable identifier for automation. */
  name: string;
  /** Label rendered into the README line (e.g. "jcodemunch-mcp"). */
  readmeLabel: string;
  /** GitHub `owner/repo` coordinate for release probing via the API. */
  repo: string;
  /** Tested version or range, verbatim as validated (e.g. "~1.108.x"). */
  testedVersion: string;
  /** Optional free-form integration note surfaced to automation. */
  notes?: string;
}

const REPO_COORDINATE = /^[^/\s]+\/[^/\s]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Parse and validate the raw `.github/dependency-versions.json` payload.
 * Throws with a field-naming message on any malformed entry so a bad
 * manifest fails loudly at the earliest boundary instead of downstream.
 */
export function parseDependencyManifest(raw: unknown): DependencyVersion[] {
  if (!isRecord(raw) || !Array.isArray(raw.tools)) {
    throw new Error('dependency-versions manifest must be an object with a "tools" array');
  }
  return raw.tools.map((entry: unknown, i: number) => {
    if (!isRecord(entry)) {
      throw new Error(`manifest tools[${i}]: expected an object`);
    }
    const { name, readmeLabel, repo, testedVersion, notes } = entry;
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`manifest tools[${i}]: "name" must be a non-empty string`);
    }
    if (typeof readmeLabel !== 'string' || readmeLabel.length === 0) {
      throw new Error(`manifest tools[${i}] (${name}): "readmeLabel" must be a non-empty string`);
    }
    if (typeof repo !== 'string' || !REPO_COORDINATE.test(repo)) {
      throw new Error(`manifest tools[${i}] (${name}): "repo" must be an owner/repo coordinate`);
    }
    if (typeof testedVersion !== 'string' || testedVersion.length === 0) {
      throw new Error(`manifest tools[${i}] (${name}): "testedVersion" must be a non-empty string`);
    }
    if (notes !== undefined && typeof notes !== 'string') {
      throw new Error(`manifest tools[${i}] (${name}): "notes" must be a string when present`);
    }
    const dep: DependencyVersion = { name, readmeLabel, repo, testedVersion };
    if (notes !== undefined) dep.notes = notes;
    return dep;
  });
}

/** The README marker line this module owns, prefix to the rendered entries. */
export const TESTED_AGAINST_MARKER = '> **Tested against:**';

/** Render the README "Tested against" line from the manifest, in order. */
export function renderTestedAgainstLine(deps: DependencyVersion[]): string {
  const entries = deps.map((d) => `${d.readmeLabel} ${d.testedVersion}`).join(' · ');
  return `${TESTED_AGAINST_MARKER} ${entries}`;
}

/**
 * Replace the README's "Tested against" line with the one rendered from
 * `deps`. Returns the input unchanged when the line already matches;
 * throws when the marker line is absent (the README lost its anchor).
 */
export function syncTestedLine(readme: string, deps: DependencyVersion[]): string {
  const rendered = renderTestedAgainstLine(deps);
  const lines = readme.split('\n');
  const markerIndex = lines.findIndex((line) => line.startsWith(TESTED_AGAINST_MARKER));
  if (markerIndex === -1) {
    throw new Error(
      `README has no "${TESTED_AGAINST_MARKER}" line to sync — restore the marker before running sync:versions`,
    );
  }
  if (lines[markerIndex] === rendered) return readme;
  lines[markerIndex] = rendered;
  return lines.join('\n');
}

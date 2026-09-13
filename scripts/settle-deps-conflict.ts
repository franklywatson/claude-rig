#!/usr/bin/env tsx
/**
 * Resolve a mechanical conflict on .github/dependency-versions.json during
 * a deps-conflict-settle run: read ours (index stage 2) and theirs (stage
 * 3), keep the higher testedVersion per tool, and write the merged
 * manifest over the conflicted worktree file. The README is regenerated
 * afterwards by `npm run sync:versions` — this script never touches it.
 *
 * Run via `npm run settle:deps` from the repo root, inside an in-progress
 * `git merge`. Exit codes: 0 = manifest settled, or not conflicted
 * (nothing to do — the conflict is README-only and regen handles it);
 * 1 = unexpected error (missing stage on a conflicted path, malformed
 * JSON). Callers abort the merge on 1 and leave resolution to a human.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mergeDependencyManifests, parseDependencyManifest } from '../src/dependency-versions.js';

const MANIFEST_PATH = '.github/dependency-versions.json';

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf-8' });
}

const unmerged = git('ls-files', '-u', '--', MANIFEST_PATH).trim();
if (unmerged === '') {
  console.log(`${MANIFEST_PATH} is not conflicted — nothing to settle.`);
  process.exit(0);
}

let oursRaw: string;
let theirsRaw: string;
try {
  oursRaw = git('show', `:2:${MANIFEST_PATH}`);
  theirsRaw = git('show', `:3:${MANIFEST_PATH}`);
} catch (e) {
  console.error(`${MANIFEST_PATH} is conflicted but missing merge stages: ${String(e)}`);
  process.exit(1);
}

const merged = mergeDependencyManifests(
  parseDependencyManifest(JSON.parse(oursRaw)),
  parseDependencyManifest(JSON.parse(theirsRaw)),
);
writeFileSync(MANIFEST_PATH, JSON.stringify({ tools: merged }, null, 2) + '\n', 'utf-8');
console.log(`Settled ${MANIFEST_PATH}: kept the higher testedVersion per tool.`);

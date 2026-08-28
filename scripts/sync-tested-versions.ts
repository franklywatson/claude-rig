#!/usr/bin/env tsx
/**
 * Sync the README "Tested against" line from .github/dependency-versions.json.
 *
 * The manifest is the source of truth; the README line is generated. Run via
 * `npm run sync:versions` after bumping a tested version in the manifest.
 * Exit 1 (and no write) when the README lacks the marker line, so CI or an
 * agentic workflow fails loudly instead of silently skipping the sync.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  parseDependencyManifest,
  renderTestedAgainstLine,
  syncTestedLine,
} from '../src/dependency-versions.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(__dirname, '..');
const manifestPath = resolve(repoRoot, '.github', 'dependency-versions.json');
const readmePath = resolve(repoRoot, 'README.md');

const manifest = parseDependencyManifest(
  JSON.parse(readFileSync(manifestPath, 'utf-8')),
);
const readme = readFileSync(readmePath, 'utf-8');
const synced = syncTestedLine(readme, manifest);

if (synced === readme) {
  console.log('README tested-against line already matches the manifest — no change.');
  process.exit(0);
}

writeFileSync(readmePath, synced, 'utf-8');
console.log(`README updated:`);
console.log(`  ${renderTestedAgainstLine(manifest)}`);

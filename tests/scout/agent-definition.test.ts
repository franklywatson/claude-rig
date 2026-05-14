import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TEMPLATES = resolve(import.meta.dirname, '..', '..', 'templates');

describe('scout agent definition', () => {
  const agentPath = resolve(TEMPLATES, 'agents', 'scout.md');
  let content: string;

  it('template file exists', () => {
    content = readFileSync(agentPath, 'utf-8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('has valid YAML frontmatter', () => {
    expect(content).toMatch(/^---\n/);
    const frontmatter = content.split('---')[1];
    expect(frontmatter).toContain('name: scout');
    expect(frontmatter).toContain('model: inherit');
    expect(frontmatter).toContain('maxTurns: 15');
  });

  it('specifies jcodemunch and bash tools', () => {
    const frontmatter = content.split('---')[1];
    expect(frontmatter).toContain('mcp__jcodemunch');
    expect(frontmatter).toContain('Bash');
  });

  it('does not include Edit or Write tools', () => {
    const frontmatter = content.split('---')[1];
    expect(frontmatter).not.toContain('Edit');
    expect(frontmatter).not.toContain('Write');
  });

  it('includes context harvesting instructions', () => {
    expect(content).toContain('context harvesting');
    expect(content).toContain('get_repo_outline');
    expect(content).toContain('get_file_tree');
    expect(content).toContain('search_symbols');
  });

  it('includes structured output format', () => {
    expect(content).toContain('CodebaseMap');
    expect(content).toContain('entryPoints');
    expect(content).toContain('keyExports');
  });

  it('includes rtk usage instructions', () => {
    expect(content).toContain('rtk');
  });

  it('includes Read, Glob, and Grep for efficient file access', () => {
    const frontmatter = content.split('---')[1];
    expect(frontmatter).toContain('Read');
    expect(frontmatter).toContain('Glob');
    expect(frontmatter).toContain('Grep');
  });
});

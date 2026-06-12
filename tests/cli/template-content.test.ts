import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const TEMPLATES = join(process.cwd(), 'templates');

function read(rel: string): string {
  return readFileSync(join(TEMPLATES, rel), 'utf-8');
}

describe('agent templates', () => {
  it('code-reviewer is read-only, marked, and explicit-dispatch', () => {
    const content = read('agents/code-reviewer.md');
    expect(content).toContain('<!-- rig-generated -->');
    expect(content).toContain('name: code-reviewer');
    expect(content).toContain('Do not invoke proactively');
    expect(content).toMatch(/tools: "[^"]+"/);
    expect(content).not.toMatch(/tools: "[^"]*Edit/);
    expect(content).not.toMatch(/tools: "[^"]*Write/);
    expect(content).toContain('complete diff');
    expect(content).toContain('.harness.yaml');
    expect(content).toContain('### Assessment');
  });

  it('spec-reviewer is read-only, adversarial, and explicit-dispatch', () => {
    const content = read('agents/spec-reviewer.md');
    expect(content).toContain('<!-- rig-generated -->');
    expect(content).toContain('name: spec-reviewer');
    expect(content).toContain('Do not invoke proactively');
    expect(content).not.toMatch(/tools: "[^"]*Edit/);
    expect(content).not.toMatch(/tools: "[^"]*Write/);
    expect(content).toContain('Do Not Trust the Report');
  });
});

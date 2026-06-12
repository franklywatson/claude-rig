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

  it('implementer has full tools, marker, and evidence discipline', () => {
    const content = read('agents/implementer.md');
    expect(content).toContain('<!-- rig-generated -->');
    expect(content).toContain('name: implementer');
    expect(content).toContain('Do not invoke proactively');
    expect(content).not.toContain('tools:'); // omitted -> inherits all tools
    expect(content).toContain('show output before reporting');
    expect(content).toContain('BLOCKED');
  });
});

describe('skill templates — typed dispatch', () => {
  it('sdd-plus dispatches all three typed agents with fallback', () => {
    const content = read('skills/sdd-plus/SKILL.md');
    expect(content).toContain('Agent(subagent_type="implementer"');
    expect(content).toContain('Agent(subagent_type="spec-reviewer"');
    expect(content).toContain('Agent(subagent_type="code-reviewer"');
    expect(content).toContain('superpowers:subagent-driven-development');
    expect(content).toContain('fall back to a general-purpose');
    expect(content).toContain('signal stack');
  });

  it('review-plus dispatches spec-reviewer and code-reviewer', () => {
    const content = read('skills/review-plus/SKILL.md');
    expect(content).toContain('Agent(subagent_type="spec-reviewer"');
    expect(content).toContain('Agent(subagent_type="code-reviewer"');
    expect(content).toContain('fall back to a general-purpose');
  });
});

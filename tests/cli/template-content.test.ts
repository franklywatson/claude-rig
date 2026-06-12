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
    expect(content).not.toMatch(/^tools:/m); // frontmatter omits tools -> inherits all
    expect(content).toContain('show output before reporting');
    expect(content).toContain('BLOCKED');
  });

  it('agents carry backstop-level turn budgets with partial-status guidance', () => {
    const budgets: Record<string, number> = {
      'code-reviewer': 75,
      'spec-reviewer': 50,
      'implementer': 150,
    };
    for (const [agent, turns] of Object.entries(budgets)) {
      const content = read(`agents/${agent}.md`);
      expect(content).toContain(`maxTurns: ${turns}`);
      expect(content).toContain('runaway backstop');
      expect(content).toContain('partial status');
    }
    expect(read('agents/scout.md')).toContain('maxTurns: 30');
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

describe('skill templates — loop-aware vocabulary', () => {
  it('brain-plus elicits the loop trajectory opt-in', () => {
    const content = read('skills/brain-plus/SKILL.md');
    expect(content).toContain('references/agent-loops.md');
    expect(content).toContain('Loop-fit assessment');
    expect(content).toContain('opt-in');
    expect(content).toContain('signal stack');
    expect(content).not.toContain('Stack-first design');
  });

  it('plan-plus orders signal-stack-first when design opted in', () => {
    const content = read('skills/plan-plus/SKILL.md');
    expect(content).toContain('references/agent-loops.md');
    expect(content).toContain('signal-stack-first');
    expect(content).toContain('gating signal');
  });

  it('tdd-plus and verify-plus use signal-stack vocabulary', () => {
    const tdd = read('skills/tdd-plus/SKILL.md');
    expect(tdd).toContain('gating signal');
    expect(tdd).toContain('integration-layer');
    const verify = read('skills/verify-plus/SKILL.md');
    expect(verify).toContain('signal stack');
  });

  it('verify-harness covers the typed agents and sdd+', () => {
    const content = read('skills/verify-harness/SKILL.md');
    expect(content).toContain('**SK6**');
    expect(content).toContain('**AG8**');
    expect(content).toContain('Agent(subagent_type="code-reviewer")');
    expect(content).toContain('XX/35');
  });
});

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

  it('agent tool lists use get_symbol_source (jcodemunch consolidated get_symbol/get_symbols away in d040bf1)', () => {
    for (const agent of ['scout', 'code-reviewer', 'spec-reviewer']) {
      const content = read(`agents/${agent}.md`);
      expect(content).toContain('mcp__jcodemunch__get_symbol_source');
      // The exact old pair must be gone; get_symbol_source must not be a
      // substring of either removed name (it isn't), so this is unambiguous.
      expect(content).not.toContain('mcp__jcodemunch__get_symbol,mcp__jcodemunch__get_symbols');
    }
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

  it('plan-plus carries the parallelism/independence contract', () => {
    const content = read('skills/plan-plus/SKILL.md');
    expect(content).toContain('Depends on: Task');
    expect(content).toContain('exhaustive');
  });

  it('sdd-plus offers team mode behind detection and config', () => {
    const content = read('skills/sdd-plus/SKILL.md');
    expect(content).toContain('agent-teams');
    expect(content).toContain('team_execution');
    expect(content).toContain('Team mode available');
    expect(content).toContain('at most 3');
    expect(content).toContain('sequential dispatch');
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
    expect(content).toContain('XX/37');
  });

  it('tdd+ and sdd+ carry the branch-discipline preflight', () => {
    for (const skill of ['tdd-plus', 'sdd-plus']) {
      const content = read(`skills/${skill}/SKILL.md`);
      expect(content).toContain('branch discipline');
      expect(content).toContain('isolated workspace');
    }
  });

  it('review+ prefers a PR when branch discipline is active', () => {
    expect(read('skills/review-plus/SKILL.md')).toContain('gh pr create');
  });
});

describe('skill templates — savings aggregation', () => {
  it('savings aggregates counters across all matching session cache files', () => {
    const content = read('skills/savings/SKILL.md');
    // Gather every cache file for this project, not just one
    expect(content).toContain('ALL files whose `cwd` matches');
    // Sum tool-call counters across the matching files
    expect(content).toContain('Sum `metricCounters`');
    // Baseline and environment come from the most recent file only
    expect(content).toMatch(/`metricsBaseline` and `environment`[\s\S]{0,120}?most recent matching file/);
    // Staleness is anchored to session start: the most recent file's baseline
    // capture timestamp, with 24 hours as the outer bound only
    expect(content).toContain('`metricsBaseline.capturedAt`');
    expect(content).toContain('session-start anchor');
    expect(content).toMatch(/`updatedAt` predates the anchor/);
    expect(content).toContain('older than 24 hours');
  });
});

describe('hook templates — rtk rewrite auto-allow gate', () => {
  it('pre-tool-use.ts pairs permissionDecision:allow ONLY when the rewrite is autoAllow', () => {
    const content = read('hooks/pre-tool-use.ts');
    // rtk exit 3 (Ask/Default) must NOT be auto-allowed — emit updatedInput
    // without permissionDecision so Claude Code prompts (rtk-ai/rtk#1155).
    expect(content).toContain('autoAllow');
    expect(content).toMatch(/autoAllow\s*\?\s*\{\s*permissionDecision/);
  });
});

describe('verify-harness — typed-agent enforcement check', () => {
  it('includes the AG9 general-purpose→typed steering check', () => {
    const content = read('skills/verify-harness/SKILL.md');
    expect(content).toContain('typed_agent_enforcement');
    expect(content).toContain('general-purpose');
  });

  it('includes the S6 superpowers detection check', () => {
    const content = read('skills/verify-harness/SKILL.md');
    expect(content).toContain('superpowers: installed');
    expect(content).toContain('claude-plugins-official');
  });
});

describe('agent tool lists — Release 2 adoptions (F1 jcodemunch + F2 graphify)', () => {
  it('scout adopts plan_turn/get_ranked_context/assemble_task_context + get_node/get_neighbors', () => {
    const content = read('agents/scout.md');
    for (const t of ['mcp__jcodemunch__plan_turn', 'mcp__jcodemunch__get_ranked_context', 'mcp__jcodemunch__assemble_task_context', 'mcp__graphify__get_node', 'mcp__graphify__get_neighbors']) {
      expect(content, t).toContain(t);
    }
  });

  it('code-reviewer adopts search_ast/winnow_symbols + get_node/get_neighbors', () => {
    const content = read('agents/code-reviewer.md');
    for (const t of ['mcp__jcodemunch__search_ast', 'mcp__jcodemunch__winnow_symbols', 'mcp__graphify__get_node', 'mcp__graphify__get_neighbors']) {
      expect(content, t).toContain(t);
    }
  });

  it('spec-reviewer adopts graphify get_node/get_neighbors', () => {
    const content = read('agents/spec-reviewer.md');
    for (const t of ['mcp__graphify__get_node', 'mcp__graphify__get_neighbors']) {
      expect(content, t).toContain(t);
    }
  });
});

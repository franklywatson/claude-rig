import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('scout agent template', () => {
  const templatePath = resolve(__dirname, '../../templates/agents/scout.md');
  const template = readFileSync(templatePath, 'utf-8');

  it('includes graphify build step for external directories', () => {
    expect(template).toContain('graphify update');
  });

  it('includes graphify-out/graph.json check for external directories', () => {
    expect(template).toContain('graphify-out/graph.json');
  });

  it('gates graphify build on graphify availability', () => {
    // Must mention checking for graphify before running the build
    expect(template).toMatch(/which graphify|graphify.*available/i);
  });

  it('includes jcodemunch file cap reporting instructions', () => {
    expect(template).toContain('file limit');
    expect(template).toMatch(/max_folder_files|config\.jsonc/);
  });

  it('includes graphify build failure reporting instructions', () => {
    expect(template).toMatch(/graphify build failed|build fails/);
  });

  it('documents capability check before procedure steps', () => {
    // Step 0 / capability check must appear before the main procedure
    expect(template).toMatch(/Step 0|Capability [Cc]heck/);
    // Must distinguish MCP availability from CLI availability
    expect(template).toContain('mcp__graphify__graph_stats');
    expect(template).toContain('mcp__jcodemunch__list_repos');
  });

  it('documents graphify CLI fallback when MCP tools are absent', () => {
    // When MCP isn't available but CLI is, parse graph.json directly
    expect(template).toMatch(/CLI fallback|parse.*graph\.json|graph\.json.*directly/i);
  });

  it('treats .rebuild.lock as the building-state indicator', () => {
    expect(template).toContain('.rebuild.lock');
  });

  it('requires numeric symbol counts in the output', () => {
    // The output spec should require integers, not prose like "substantial"
    expect(template).toMatch(/Functions: \[?count\]?|Functions: <count>|integer count|numeric/i);
    // Anti-pattern guardrail: forbid hand-wavy wording
    expect(template).toMatch(/substantial/);
    expect(template).toMatch(/exact integer|integer count/i);
  });

  it('requires a Tools Available preamble in the output', () => {
    expect(template).toMatch(/Tools Available|tools_available|Capabilities (Used|Detected)/);
  });
});

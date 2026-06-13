import { describe, it, expect } from 'vitest';
import { buildClaudeArgs } from '../../evals/drive.js';

describe('drive: claude args', () => {
  it('builds headless stream-json args with model and permission bypass', () => {
    const a = buildClaudeArgs('do X', 'claude-opus-4-8');
    expect(a).toContain('-p');
    expect(a).toContain('do X');
    expect(a.join(' ')).toContain('--model claude-opus-4-8');
    expect(a.join(' ')).toContain('--output-format stream-json');
    expect(a).toContain('--dangerously-skip-permissions');
  });
});

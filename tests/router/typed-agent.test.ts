import { describe, it, expect, beforeEach } from 'vitest';
import { checkTypedAgentDispatch } from '../../src/router/typed-agent.js';
import { SessionCache } from '../../src/session/cache.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import type { HarnessConfig } from '../../src/types.js';

describe('checkTypedAgentDispatch', () => {
  let cache: SessionCache;
  beforeEach(() => {
    cache = new SessionCache();
  });

  const cfg = (level: 'advise' | 'block' | 'silent'): HarnessConfig => ({
    ...DEFAULT_CONFIG,
    rules: {
      ...DEFAULT_CONFIG.rules,
      workflow: { ...DEFAULT_CONFIG.rules.workflow!, typed_agent_enforcement: level },
    },
  });

  it('advises when a general-purpose subagent is dispatched during sdd+', () => {
    cache.setPhase('sdd+');
    const r = checkTypedAgentDispatch('Agent', { subagent_type: 'general-purpose', prompt: 'x' }, cfg('advise'), cache);
    expect(r).not.toBeNull();
    expect(r!.level).toBe('advise');
    expect(r!.message).toMatch(/implementer|typed|subagent_type/i);
  });

  it('advises when subagent_type is missing during review+', () => {
    cache.setPhase('review+');
    const r = checkTypedAgentDispatch('Agent', { prompt: 'x' }, cfg('advise'), cache);
    expect(r).not.toBeNull();
    expect(r!.level).toBe('advise');
  });

  it('does not flag a typed dispatch (implementer) during sdd+', () => {
    cache.setPhase('sdd+');
    const r = checkTypedAgentDispatch('Agent', { subagent_type: 'implementer', prompt: 'x' }, cfg('advise'), cache);
    expect(r).toBeNull();
  });

  it('does not flag a typed dispatch (spec-reviewer) during review+', () => {
    cache.setPhase('review+');
    const r = checkTypedAgentDispatch('Agent', { subagent_type: 'spec-reviewer', prompt: 'x' }, cfg('advise'), cache);
    expect(r).toBeNull();
  });

  it('does not enforce outside sdd+/review+ (e.g. brain+)', () => {
    cache.setPhase('brain+');
    const r = checkTypedAgentDispatch('Agent', { subagent_type: 'general-purpose', prompt: 'x' }, cfg('advise'), cache);
    expect(r).toBeNull();
  });

  it('does not enforce when no phase is set', () => {
    const r = checkTypedAgentDispatch('Agent', { subagent_type: 'general-purpose', prompt: 'x' }, cfg('advise'), cache);
    expect(r).toBeNull();
  });

  it('blocks at block level during sdd+', () => {
    cache.setPhase('sdd+');
    const r = checkTypedAgentDispatch('Agent', { subagent_type: 'general-purpose', prompt: 'x' }, cfg('block'), cache);
    expect(r!.level).toBe('block');
  });

  it('is silent at silent level', () => {
    cache.setPhase('sdd+');
    const r = checkTypedAgentDispatch('Agent', { subagent_type: 'general-purpose', prompt: 'x' }, cfg('silent'), cache);
    expect(r).toBeNull();
  });

  it('ignores non-dispatch tools', () => {
    cache.setPhase('sdd+');
    const r = checkTypedAgentDispatch('Bash', { command: 'echo hi' }, cfg('advise'), cache);
    expect(r).toBeNull();
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { SkillPhaseTracker } from '../../src/skills/phase-tracker.js';

describe('SkillPhaseTracker', () => {
  let tracker: SkillPhaseTracker;

  beforeEach(() => {
    tracker = new SkillPhaseTracker();
  });

  it('starts with no phase', () => {
    expect(tracker.getCurrentPhase()).toBeNull();
  });

  it('tracks phase transitions', () => {
    tracker.setPhase('brain+');
    expect(tracker.getCurrentPhase()).toBe('brain+');
    tracker.setPhase('plan+');
    expect(tracker.getCurrentPhase()).toBe('plan+');
  });

  it('records phase history', () => {
    tracker.setPhase('brain+');
    tracker.setPhase('plan+');
    tracker.setPhase('tdd+');
    const history = tracker.getHistory();
    expect(history).toEqual([
      { phase: 'brain+', enteredAt: expect.any(Number) },
      { phase: 'plan+', enteredAt: expect.any(Number) },
      { phase: 'tdd+', enteredAt: expect.any(Number) },
    ]);
  });

  it('validates forward transitions', () => {
    tracker.setPhase('brain+');
    expect(tracker.canTransitionTo('plan+')).toBe(true);
    expect(tracker.canTransitionTo('tdd+')).toBe(true);
    expect(tracker.canTransitionTo('brain+')).toBe(true); // re-entry allowed
  });

  it('allows review+ from any phase', () => {
    tracker.setPhase('brain+');
    expect(tracker.canTransitionTo('review+')).toBe(true);
  });

  it('allows debug+ from any phase with no prerequisite', () => {
    expect(tracker.canTransitionTo('debug+')).toBe(true);
    tracker.setPhase('brain+');
    expect(tracker.canTransitionTo('debug+')).toBe(true);
    tracker.setPhase('tdd+');
    expect(tracker.canTransitionTo('debug+')).toBe(true);
  });

  it('allows verify+ only after tdd+', () => {
    tracker.setPhase('brain+');
    expect(tracker.canTransitionTo('verify+')).toBe(false);
    tracker.setPhase('plan+');
    expect(tracker.canTransitionTo('verify+')).toBe(false);
    tracker.setPhase('tdd+');
    expect(tracker.canTransitionTo('verify+')).toBe(true);
  });

  it('allows re-entry to same phase', () => {
    tracker.setPhase('brain+');
    tracker.setPhase('plan+');
    expect(tracker.canTransitionTo('brain+')).toBe(true); // can go back
  });

  it('returns all valid phases', () => {
    const phases = tracker.getAllPhases();
    expect(phases).toEqual(['brain+', 'plan+', 'tdd+', 'sdd+', 'verify+', 'review+', 'debug+']);
  });

  it('returns phase index for ordering', () => {
    expect(tracker.getPhaseIndex('brain+')).toBe(0);
    expect(tracker.getPhaseIndex('plan+')).toBe(1);
    expect(tracker.getPhaseIndex('tdd+')).toBe(2);
    expect(tracker.getPhaseIndex('sdd+')).toBe(3);
    expect(tracker.getPhaseIndex('verify+')).toBe(4);
    expect(tracker.getPhaseIndex('review+')).toBe(5);
    expect(tracker.getPhaseIndex('debug+')).toBe(6);
    expect(tracker.getPhaseIndex('unknown')).toBe(-1);
  });

  it('allows sdd+ as a free transition like tdd+', () => {
    tracker.setPhase('plan+');
    expect(tracker.canTransitionTo('sdd+')).toBe(true);
  });

  it('verify+ accepts a prior sdd+ visit', () => {
    tracker.setPhase('sdd+');
    expect(tracker.canTransitionTo('verify+')).toBe(true);
  });

  it('verify+ rejected without tdd+ or sdd+ visit', () => {
    tracker.setPhase('plan+');
    expect(tracker.canTransitionTo('verify+')).toBe(false);
  });

  it('includes sdd+ in phase order', () => {
    expect(tracker.getAllPhases()).toContain('sdd+');
  });

  it('detects tdd+ phase', () => {
    tracker.setPhase('tdd+');
    expect(tracker.isTddPhase()).toBe(true);
    tracker.setPhase('verify+');
    expect(tracker.isTddPhase()).toBe(false);
  });

  it('detects verify+ phase', () => {
    tracker.setPhase('verify+');
    expect(tracker.isVerifyPhase()).toBe(true);
  });

  it('resets to no phase', () => {
    tracker.setPhase('brain+');
    tracker.reset();
    expect(tracker.getCurrentPhase()).toBeNull();
    expect(tracker.getHistory()).toEqual([]);
  });
});

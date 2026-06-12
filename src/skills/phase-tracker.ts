const PHASE_ORDER = ['brain+', 'plan+', 'tdd+', 'sdd+', 'verify+', 'review+', 'debug+'] as const;
export type SkillPhase = (typeof PHASE_ORDER)[number];

interface PhaseEntry {
  phase: SkillPhase;
  enteredAt: number;
}

export class SkillPhaseTracker {
  private currentPhase: SkillPhase | null = null;
  private history: PhaseEntry[] = [];

  getCurrentPhase(): SkillPhase | null {
    return this.currentPhase;
  }

  setPhase(phase: SkillPhase): void {
    this.currentPhase = phase;
    this.history.push({ phase, enteredAt: Date.now() });
  }

  canTransitionTo(target: SkillPhase): boolean {
    // review+ and debug+ are accessible from any phase
    if (target === 'review+' || target === 'debug+') return true;

    // verify+ requires tdd+ or sdd+ to have been visited
    if (target === 'verify+') {
      return this.history.some(e => e.phase === 'tdd+' || e.phase === 'sdd+');
    }

    // All other phases allow free transitions (re-entry, forward, backward)
    return true;
  }

  getHistory(): PhaseEntry[] {
    return [...this.history];
  }

  getAllPhases(): readonly SkillPhase[] {
    return PHASE_ORDER;
  }

  getPhaseIndex(phase: string): number {
    return PHASE_ORDER.indexOf(phase as SkillPhase);
  }

  isTddPhase(): boolean {
    return this.currentPhase === 'tdd+';
  }

  isVerifyPhase(): boolean {
    return this.currentPhase === 'verify+';
  }

  reset(): void {
    this.currentPhase = null;
    this.history = [];
  }
}

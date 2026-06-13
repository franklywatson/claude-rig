import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, unlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { EditHistoryEntry, Environment, GraphBuildInfo, GraphifyProjectStats, MetricsBaseline, PythonEnv, SessionCacheFile } from '../types.js';

const ENV_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Advisory re-advisory cycle length: after an advisory fires, shouldAdvise()
 * suppresses the next ADVISORY_READVISE_PERIOD - 1 occurrences and re-advises
 * on the ADVISORY_READVISE_PERIOD-th — i.e. calls 1, 11, 21, ... advise.
 */
export const ADVISORY_READVISE_PERIOD = 10;

export function sessionCachePath(cwd: string, sessionId?: string): string {
  // Canonicalize the cwd so callers that pass an unresolved path (e.g. macOS
  // /var/folders/... which resolves to /private/var/folders/...) hash to the
  // same file as the hook subprocess, which sees the resolved path via
  // process.cwd().
  let canonical = cwd;
  try {
    canonical = realpathSync(cwd);
  } catch {
    // Path does not exist or is unreadable — fall back to the original input
    // so synthetic paths in tests still produce a deterministic hash.
  }
  const input = sessionId ? `${canonical}:${sessionId}` : canonical;
  const hash = createHash('sha256').update(input).digest('hex').slice(0, 12);
  return join('/tmp', `rig-session-${hash}.json`);
}

export class SessionCache {
  private cwd: string | undefined;
  private sessionId: string | undefined;
  private environment: Environment | undefined;
  private editedFiles: Map<string, Set<string>> = new Map();
  private currentPhase: string | null = null;
  private metricsBaseline: MetricsBaseline | undefined;
  private graphBuildInfo: GraphBuildInfo | undefined;
  private metricCounters = { rtkCalls: 0, jmCalls: 0, efficientCalls: 0, graphifyCalls: 0 };
  private changedFiles: string[] = [];
  private toolsWarned = false;
  private pythonEnv: PythonEnv | undefined;
  private advisedIntents: Set<string> = new Set();
  private advisorySuppressCounts: Map<string, number> = new Map();
  private editTurnCounter = 0;
  private editHistory: EditHistoryEntry[] = [];
  private lastStaleKey = '';
  private saveSuppressed = false;
  private saveDirty = false;

  constructor(cwd?: string, sessionId?: string) {
    this.cwd = cwd;
    this.sessionId = sessionId;
    if (cwd) {
      this.load();
    }
  }

  getEnvironment(): Environment | undefined {
    return this.environment;
  }

  getCwd(): string | undefined {
    return this.cwd;
  }

  setEnvironment(env: Environment): void {
    this.environment = env;
    this.save();
  }

  isEnvironmentStale(): boolean {
    if (!this.environment) return true;
    return Date.now() - this.environment.detectedAt > ENV_TTL_MS;
  }

  addEditedFile(filePath: string, category: 'source' | 'test'): void {
    let set = this.editedFiles.get(category);
    if (!set) {
      set = new Set<string>();
      this.editedFiles.set(category, set);
    }
    set.add(filePath);
    this.save();
  }

  getEditedFiles(category: 'source' | 'test'): string[] {
    return Array.from(this.editedFiles.get(category) ?? []);
  }

  /**
   * Clear all recorded source and test edits (including the turn-stamped
   * history). Called when a scoped-execution phase (tdd+/sdd+) is entered
   * from a different phase, so test-scope suggestions and stale-test checks
   * reflect the current feature's edits, not the whole session's. The turn
   * counter itself stays monotonic — only the history is scoped.
   */
  clearEditedFiles(): void {
    this.editedFiles.clear();
    this.editHistory = [];
    this.save();
  }

  /**
   * Cross-process turn model for the stale-test check: one PostToolUse
   * Edit/Write invocation = one turn. Hooks run as separate processes, so
   * the counter must live here, not in the in-memory FileTracker.
   */
  getEditTurn(): number {
    return this.editTurnCounter;
  }

  /** Advance the edit-turn counter and return the new turn number. */
  advanceEditTurn(): number {
    this.editTurnCounter++;
    this.save();
    return this.editTurnCounter;
  }

  /** Record a turn-stamped edit for cross-process stale-test detection. The
   *  file's category is reclassified on hydration, so it isn't stored here. */
  recordEditTurn(file: string, turn: number): void {
    this.editHistory.push({ file, turn });
    this.save();
  }

  getEditHistory(): EditHistoryEntry[] {
    return [...this.editHistory];
  }

  /**
   * Stale-test advisory dedup. Returns true when `key` differs from the last
   * stale set we advised on (and stores the new key), false when unchanged.
   * The handler passes the sorted unique set of stale source files; an empty
   * key ('' — nothing stale) is stored too, so a set that clears and later
   * re-appears re-fires instead of staying suppressed forever. Keeps the
   * stale-test advisory from re-emitting an identical (often growing) list on
   * every Edit/Write — the advisory-fatigue fix.
   */
  updateStaleKey(key: string): boolean {
    if (key === this.lastStaleKey) return false;
    this.lastStaleKey = key;
    this.save();
    return true;
  }

  /**
   * Run `fn` with intermediate save()s suppressed, then write the cache file
   * exactly once at the end — and only if a save was actually requested. A
   * single PostToolUse invocation mutates several fields (turn counter,
   * edited-file sets, turn-stamped history, stale key, metric counters);
   * without batching, each setter rewrites the whole JSON file. Re-entrant
   * calls flatten — only the outermost transaction performs the write.
   */
  transaction<T>(fn: () => T): T {
    if (this.saveSuppressed) return fn(); // already inside a transaction
    this.saveSuppressed = true;
    this.saveDirty = false;
    try {
      return fn();
    } finally {
      this.saveSuppressed = false;
      if (this.saveDirty) this.save();
    }
  }

  setPhase(phase: string): void {
    this.currentPhase = phase;
    this.save();
  }

  getCurrentPhase(): string | null {
    return this.currentPhase;
  }

  getMetricsBaseline(): MetricsBaseline | undefined {
    return this.metricsBaseline;
  }

  setMetricsBaseline(baseline: MetricsBaseline): void {
    this.metricsBaseline = baseline;
    this.save();
  }

  getMetricCounters(): { rtkCalls: number; jmCalls: number } {
    return { ...this.metricCounters };
  }

  incrementMetricCounter(counter: 'rtkCalls' | 'jmCalls' | 'efficientCalls' | 'graphifyCalls'): void {
    this.metricCounters[counter]++;
    this.save();
  }

  getGraphBuildInfo(): GraphBuildInfo | undefined {
    return this.graphBuildInfo;
  }

  setGraphBuildInfo(info: GraphBuildInfo): void {
    this.graphBuildInfo = info;
    this.save();
  }

  getChangedFiles(): string[] {
    return [...this.changedFiles];
  }

  setChangedFiles(files: string[]): void {
    this.changedFiles = files;
    this.save();
  }

  getToolsWarned(): boolean {
    return this.toolsWarned;
  }

  setToolsWarned(value: boolean): void {
    this.toolsWarned = value;
    this.save();
  }

  hasAdvised(intent: string): boolean {
    return this.advisedIntents.has(intent);
  }

  markAdvised(intent: string): void {
    this.advisedIntents.add(intent);
    this.save();
  }

  /**
   * Stateful advisory gate with periodic re-advisory. Returns true on the
   * first call for an intent (and marks it advised), then false for the next
   * nine occurrences, then true again on the tenth suppressed occurrence —
   * i.e. calls 1, 11, 21, ... advise (cycle length ADVISORY_READVISE_PERIOD);
   * everything in between is suppressed. The suppression counter is
   * persisted alongside advisedIntents so the cycle survives across hook
   * processes. hasAdvised() remains a pure query.
   *
   * WARNING: every call consumes one slot in the suppression cycle, whether
   * or not the caller acts on the result. Call it at most once per advisory
   * decision, and mind evaluation order when composing with hasAdvised() —
   * `hasAdvised(x) && !shouldAdvise(x)` only spends a slot once the intent
   * is already marked, whereas calling shouldAdvise() first would advance
   * the cycle on paths that never advise.
   */
  shouldAdvise(intent: string): boolean {
    if (!this.advisedIntents.has(intent)) {
      // No counter seed needed: a missing key reads as 0 via `?? 0` below,
      // which is also the state markAdvised() leaves behind.
      this.advisedIntents.add(intent);
      this.save();
      return true;
    }
    const suppressed = (this.advisorySuppressCounts.get(intent) ?? 0) + 1;
    if (suppressed >= ADVISORY_READVISE_PERIOD) {
      // Final suppressed occurrence of the cycle — re-advise and restart.
      this.advisorySuppressCounts.set(intent, 0);
      this.save();
      return true;
    }
    this.advisorySuppressCounts.set(intent, suppressed);
    this.save();
    return false;
  }

  getPythonEnv(): PythonEnv | undefined {
    return this.pythonEnv;
  }

  setPythonEnv(env: PythonEnv): void {
    this.pythonEnv = env;
    this.save();
  }

  getGraphifyStats(dir: string): GraphifyProjectStats | undefined {
    return this.metricsBaseline?.graphifyStats?.[dir];
  }

  setGraphifyStats(dir: string, stats: GraphifyProjectStats): void {
    if (!this.metricsBaseline) {
      this.metricsBaseline = { totalSaved: 0, capturedAt: Date.now() };
    }
    if (!this.metricsBaseline.graphifyStats) {
      this.metricsBaseline.graphifyStats = {};
    }
    this.metricsBaseline.graphifyStats[dir] = stats;
    this.save();
  }

  getAllGraphifyStats(): Record<string, GraphifyProjectStats> | undefined {
    return this.metricsBaseline?.graphifyStats ?? undefined;
  }

  reset(): void {
    this.environment = undefined;
    this.editedFiles.clear();
    this.currentPhase = null;
    this.metricsBaseline = undefined;
    this.graphBuildInfo = undefined;
    this.metricCounters = { rtkCalls: 0, jmCalls: 0, efficientCalls: 0, graphifyCalls: 0 };
    this.toolsWarned = false;
    this.changedFiles = [];
    this.pythonEnv = undefined;
    this.advisedIntents = new Set();
    this.advisorySuppressCounts = new Map();
    this.editTurnCounter = 0;
    this.editHistory = [];
    this.lastStaleKey = '';
    this.save();
  }

  private serialize(): SessionCacheFile {
    const editedFilesObj: Record<string, string[]> = {};
    for (const [key, set] of this.editedFiles) {
      editedFilesObj[key] = Array.from(set);
    }
    return {
      updatedAt: Date.now(),
      cwd: this.cwd ?? null,
      environment: this.environment ?? null,
      editedFiles: editedFilesObj,
      currentPhase: this.currentPhase,
      metricsBaseline: this.metricsBaseline ?? null,
      graphBuildInfo: this.graphBuildInfo ?? undefined,
      metricCounters: { ...this.metricCounters },
      toolsWarned: this.toolsWarned,
      changedFiles: [...this.changedFiles],
      pythonEnv: this.pythonEnv ?? null,
      advisedIntents: Array.from(this.advisedIntents),
      advisorySuppressCounts: Object.fromEntries(this.advisorySuppressCounts),
      editTurnCounter: this.editTurnCounter,
      editHistory: [...this.editHistory],
      lastStaleKey: this.lastStaleKey,
    };
  }

  private load(): void {
    if (!this.cwd) return;
    const path = sessionCachePath(this.cwd, this.sessionId);
    try {
      if (!existsSync(path)) return;
      const raw = readFileSync(path, 'utf-8');
      const data = JSON.parse(raw) as SessionCacheFile;

      // Restore environment unconditionally as last-known-good. The TTL is
      // reported via isEnvironmentStale() so SessionStart re-detects, but the
      // env is never dropped here: clearing it made hooks fall back to
      // defaultEnv() (everything unavailable) and silently disabled rtk and
      // jcodemunch routing for the remainder of any session older than the
      // TTL. A stale rtkPath degrades gracefully — the spawn fails and the
      // command falls through unrewritten.
      if (data.environment) {
        this.environment = data.environment;
      }

      // Restore edited files
      if (data.editedFiles) {
        for (const [key, files] of Object.entries(data.editedFiles)) {
          this.editedFiles.set(key, new Set(files));
        }
      }

      this.currentPhase = data.currentPhase ?? null;
      this.metricsBaseline = data.metricsBaseline ?? undefined;
      this.graphBuildInfo = data.graphBuildInfo ?? undefined;
      this.metricCounters = data.metricCounters ?? { rtkCalls: 0, jmCalls: 0, efficientCalls: 0, graphifyCalls: 0 };
      this.toolsWarned = data.toolsWarned ?? false;
      this.changedFiles = data.changedFiles ?? [];
      this.pythonEnv = data.pythonEnv ?? undefined;
      this.advisedIntents = new Set(data.advisedIntents ?? []);
      this.advisorySuppressCounts = new Map(Object.entries(data.advisorySuppressCounts ?? {}));
      this.editTurnCounter = data.editTurnCounter ?? 0;
      this.editHistory = data.editHistory ?? [];
      this.lastStaleKey = data.lastStaleKey ?? '';
    } catch {
      // Corrupt or unreadable file — start fresh
    }
  }

  private save(): void {
    // Inside a transaction, defer the write and remember that one is due.
    if (this.saveSuppressed) {
      this.saveDirty = true;
      return;
    }
    if (!this.cwd) return;
    const path = sessionCachePath(this.cwd, this.sessionId);
    try {
      writeFileSync(path, JSON.stringify(this.serialize(), null, 2) + '\n', 'utf-8');
    } catch {
      // Best-effort — don't fail hooks if /tmp is unwritable
    }
  }
}

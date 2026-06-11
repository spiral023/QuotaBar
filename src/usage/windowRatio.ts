export interface ProviderRatioState {
  sumFivePct: number;
  sumWeeklyPct: number;
  pairCount: number;
  lastFive: number | null;
  lastWeekly: number | null;
  lastFiveResetsAt: string | null;
  lastPlanType: string | null;
}

export interface WindowRatioFile {
  version: 1;
  seededThrough: string | null;
  providers: Record<string, ProviderRatioState>;
}

/** Mindestens zwei volle 5h-Fenster an Beobachtung, bevor das Verhältnis als belastbar gilt. */
export const MIN_SAMPLE_FIVE_PCT = 200;
/** Schutz gegen Division durch ~0 bei extremer Ganzzahl-Rundung des Weekly-Werts. */
export const MIN_SAMPLE_WEEKLY_PCT = 5;
/** Exponentielles Vergessen: oberhalb dieses Deckels werden beide Summen halbiert. */
export const DECAY_CAP_FIVE_PCT = 3000;
export const WEEKLY_SATURATION_PCT = 99.5;

export function emptyProviderState(): ProviderRatioState {
  return {
    sumFivePct: 0,
    sumWeeklyPct: 0,
    pairCount: 0,
    lastFive: null,
    lastWeekly: null,
    lastFiveResetsAt: null,
    lastPlanType: null,
  };
}

export function emptyRatioFile(): WindowRatioFile {
  return { version: 1, seededThrough: null, providers: {} };
}

export interface RatioObservation {
  fivePct: number;
  weeklyPct: number;
  fiveResetsAt?: string | null;
  planType?: string | null;
}

/**
 * Verarbeitet eine Beobachtung (ein Snapshot) und liefert den neuen State.
 * Ein "Paar" sind zwei aufeinanderfolgende Beobachtungen; nur Paare mit
 * ko-okkurrierendem Wachstum beider Fenster fließen in die Summen ein.
 */
export function recordObservation(state: ProviderRatioState, obs: RatioObservation): ProviderRatioState {
  let s = state;
  if (obs.planType != null && s.lastPlanType != null && obs.planType !== s.lastPlanType) {
    s = emptyProviderState();
  }
  const next: ProviderRatioState = { ...s };
  if (s.lastFive !== null && s.lastWeekly !== null) {
    const dFive = obs.fivePct - s.lastFive;
    const dWeekly = obs.weeklyPct - s.lastWeekly;
    const rollover = s.lastFiveResetsAt != null && obs.fiveResetsAt != null && obs.fiveResetsAt !== s.lastFiveResetsAt;
    const saturated = s.lastWeekly >= WEEKLY_SATURATION_PCT;
    if (dFive > 0 && dWeekly >= 0 && !rollover && !saturated) {
      next.sumFivePct = s.sumFivePct + dFive;
      next.sumWeeklyPct = s.sumWeeklyPct + dWeekly;
      next.pairCount = s.pairCount + 1;
      if (next.sumFivePct > DECAY_CAP_FIVE_PCT) {
        next.sumFivePct /= 2;
        next.sumWeeklyPct /= 2;
      }
    }
  }
  next.lastFive = obs.fivePct;
  next.lastWeekly = obs.weeklyPct;
  next.lastFiveResetsAt = obs.fiveResetsAt ?? null;
  next.lastPlanType = obs.planType ?? s.lastPlanType;
  return next;
}

export interface WindowBudget {
  learning: false;
  windowsPerWeek: number;
  usedWindows: number;
  remainingWindows: number;
  sampleFivePct: number;
}

export interface WindowBudgetLearning {
  learning: true;
  sampleFivePct: number;
}

export type WindowBudgetInfo = WindowBudget | WindowBudgetLearning;

export function computeBudget(state: ProviderRatioState | undefined, weeklyUsedPercent: number): WindowBudgetInfo {
  if (!state || state.sumFivePct < MIN_SAMPLE_FIVE_PCT || state.sumWeeklyPct < MIN_SAMPLE_WEEKLY_PCT) {
    return { learning: true, sampleFivePct: state?.sumFivePct ?? 0 };
  }
  const windowsPerWeek = state.sumFivePct / state.sumWeeklyPct;
  const usedWindows = (weeklyUsedPercent / 100) * windowsPerWeek;
  return {
    learning: false,
    windowsPerWeek,
    usedWindows,
    remainingWindows: Math.max(0, windowsPerWeek - usedWindows),
    sampleFivePct: state.sumFivePct,
  };
}

/**
 * Löscht die last-Werte aller Provider. Beim App-Start aufrufen: ein Paar
 * über eine App-Pause hinweg (Stunden/Tage) wäre wertlos bis irreführend.
 * lastPlanType bleibt erhalten, damit ein Plan-Wechsel während der Pause
 * trotzdem erkannt wird.
 */
export function clearTransients(file: WindowRatioFile): WindowRatioFile {
  const providers: Record<string, ProviderRatioState> = {};
  for (const [name, s] of Object.entries(file.providers)) {
    providers[name] = { ...s, lastFive: null, lastWeekly: null, lastFiveResetsAt: null };
  }
  return { ...file, providers };
}

export class WindowRatioTracker {
  constructor(private file: WindowRatioFile = emptyRatioFile()) {}

  record(provider: string, obs: RatioObservation): void {
    const prev = this.file.providers[provider] ?? emptyProviderState();
    this.file.providers[provider] = recordObservation(prev, obs);
  }

  getBudget(provider: string, weeklyUsedPercent: number): WindowBudgetInfo {
    return computeBudget(this.file.providers[provider], weeklyUsedPercent);
  }

  /** Addiert Seed-Summen (aus Debug-Logs) auf den bestehenden State. */
  mergeSeed(seed: WindowRatioFile): void {
    for (const [provider, s] of Object.entries(seed.providers)) {
      const cur = this.file.providers[provider] ?? emptyProviderState();
      this.file.providers[provider] = {
        ...cur,
        sumFivePct: cur.sumFivePct + s.sumFivePct,
        sumWeeklyPct: cur.sumWeeklyPct + s.sumWeeklyPct,
        pairCount: cur.pairCount + s.pairCount,
      };
    }
    this.file.seededThrough = seed.seededThrough;
  }

  getFile(): WindowRatioFile {
    return this.file;
  }
}

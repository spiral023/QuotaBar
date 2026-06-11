export interface ProviderRatioState {
  sumFivePct: number;
  sumWeeklyPct: number;
  pairCount: number;
  lastFive: number | null;
  lastWeekly: number | null;
  lastFiveResetsAt: string | null;
  lastPlanType: string | null;
  lastTs: string | null;
}

export interface WindowRatioFile {
  version: 2;
  seededThrough: string | null;
  providers: Record<string, ProviderRatioState>;
}

/** Mindestens zwei volle 5h-Fenster an Beobachtung, bevor das Verhältnis als belastbar gilt. */
export const MIN_SAMPLE_FIVE_PCT = 200;
/** Schutz gegen Division durch ~0 bei extremer Ganzzahl-Rundung des Weekly-Werts. */
export const MIN_SAMPLE_WEEKLY_PCT = 5;
/** Exponentielles Vergessen: oberhalb dieses Deckels werden beide Summen halbiert. */
export const DECAY_CAP_FIVE_PCT = 3000;
/**
 * At or above this weekly percentage the weekly window is effectively exhausted
 * and can no longer grow, so pairs are discarded to avoid polluting the ratio.
 * 99.5 rather than 100 leaves margin for integer-rounded values.
 */
export const WEEKLY_SATURATION_PCT = 99.5;

/** Paare über größere Lücken (Konto-Wechsel, App-Pausen, Log-Lücken) sind wertlos. */
export const MAX_PAIR_AGE_MS = 10 * 60 * 1000;

/** State-Map-Key: das Fenster-Verhältnis ist eine Eigenschaft des Tiers (planType). */
export function ratioKey(provider: string, planType: string | null | undefined): string {
  return `${provider}:${planType ?? "default"}`;
}

export function emptyProviderState(): ProviderRatioState {
  return {
    sumFivePct: 0,
    sumWeeklyPct: 0,
    pairCount: 0,
    lastFive: null,
    lastWeekly: null,
    lastFiveResetsAt: null,
    lastPlanType: null,
    lastTs: null,
  };
}

export function emptyRatioFile(): WindowRatioFile {
  return { version: 2, seededThrough: null, providers: {} };
}

export interface RatioObservation {
  fivePct: number;
  weeklyPct: number;
  fiveResetsAt?: string | null;
  planType?: string | null;
  ts: string;
}

/**
 * Verarbeitet eine Beobachtung (ein Snapshot) und liefert den neuen State.
 * Ein "Paar" sind zwei aufeinanderfolgende Beobachtungen; nur Paare mit
 * ko-okkurrierendem Wachstum beider Fenster fließen in die Summen ein.
 */
export function recordObservation(state: ProviderRatioState, obs: RatioObservation): ProviderRatioState {
  let s = state;
  // Defense-in-depth: reset on planType change. Within a tier-keyed state (keyed by
  // ratioKey(provider, planType) in WindowRatioTracker), planType is stable by construction.
  // This branch guards against direct callers that don't use the tier-keyed map.
  if (obs.planType != null && s.lastPlanType != null && obs.planType !== s.lastPlanType) {
    s = emptyProviderState();
  }
  const next: ProviderRatioState = { ...s };
  if (s.lastFive !== null && s.lastWeekly !== null) {
    const dFive = obs.fivePct - s.lastFive;
    const dWeekly = obs.weeklyPct - s.lastWeekly;
    // Rollover is only detected when BOTH the previous and current fiveResetsAt are
    // present. A null→present transition is treated as no-rollover by design: Claude
    // sometimes omits resetsAt at 0% usage, so we accept the small risk of a pair
    // spanning an undetected reset rather than throwing away all first observations.
    const rollover = s.lastFiveResetsAt != null && obs.fiveResetsAt != null && obs.fiveResetsAt !== s.lastFiveResetsAt;
    const saturated = s.lastWeekly >= WEEKLY_SATURATION_PCT;
    // Gap guard: pairs spanning account switches, app pauses, or log gaps are worthless.
    // NaN gap (lastTs null or unparsable) means no prior timestamp → reject.
    const gapMs = s.lastTs !== null ? new Date(obs.ts).getTime() - new Date(s.lastTs).getTime() : NaN;
    // dWeekly === 0 is intentionally accepted: any token usage moves the 5h window
    // by a larger percentage than the weekly window (smaller denominator), so a
    // positive weekly tick never occurs without a positive 5h tick. Zero-delta-weekly
    // pairs therefore never drop a real weekly increment, and sumWeeklyPct telescopes
    // to the true total weekly movement — the ratio stays unbiased.
    if (dFive > 0 && dWeekly >= 0 && !rollover && !saturated && Number.isFinite(gapMs) && gapMs >= 0 && gapMs <= MAX_PAIR_AGE_MS) {
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
  next.lastTs = obs.ts;
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
    providers[name] = { ...s, lastFive: null, lastWeekly: null, lastFiveResetsAt: null, lastTs: null };
  }
  return { ...file, providers };
}

export class WindowRatioTracker {
  constructor(private file: WindowRatioFile = emptyRatioFile()) {}

  record(provider: string, obs: RatioObservation): void {
    const key = ratioKey(provider, obs.planType);
    const prev = this.file.providers[key] ?? emptyProviderState();
    this.file.providers[key] = recordObservation(prev, obs);
  }

  getBudget(provider: string, planType: string | null | undefined, weeklyUsedPercent: number): WindowBudgetInfo {
    return computeBudget(this.file.providers[ratioKey(provider, planType)], weeklyUsedPercent);
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

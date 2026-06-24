import { resetsAtChanged } from "./windowRatio";
import { classifyWeeklyTransition, isTransientWeeklySpike } from "./weeklyTransition";

export interface CurrentWindowObservation {
  ts: string;
  fivePct: number;
  fiveResetsAt: string | null;
  weeklyPct: number;
  weeklyResetsAt: string | null;
}

export interface CurrentWindowUsage {
  observedUsedWindows: number;
  preResetWeeklyPercent: number;
  resetAdjustedWeeklyPercent: number;
  preResetUsedWindows: number;
  currentSegmentUsedWindows: number;
  budgetEquivalentUsedWindows: number;
  remainingWindows: number;
  totalWindows: number;
  bonusResetCount: number;
}

const USED_WINDOW_MIN_PCT = 5;
const FIVE_RESET_DROP_PCT = 15;

export function buildCurrentWindowUsage(
  observations: CurrentWindowObservation[],
  windowsPerWeek: number,
  currentWeeklyPct: number,
): CurrentWindowUsage {
  const sorted = observations
    .filter((o) => Number.isFinite(o.fivePct) && Number.isFinite(o.weeklyPct))
    .slice()
    .sort((a, b) => a.ts.localeCompare(b.ts));

  const observedUsedWindows = countUsedFiveHourWindows(sorted);
  const preResetWeeklyPercent = sumPreResetWeeklyPercent(sorted);
  const resetAdjustedWeeklyPercent = preResetWeeklyPercent + currentWeeklyPct;
  const preResetUsedWindows = (preResetWeeklyPercent / 100) * windowsPerWeek;
  const currentSegmentUsedWindows = (currentWeeklyPct / 100) * windowsPerWeek;
  const budgetEquivalentUsedWindows = (resetAdjustedWeeklyPercent / 100) * windowsPerWeek;
  const remainingWindows = Math.max(0, ((100 - currentWeeklyPct) / 100) * windowsPerWeek);

  return {
    observedUsedWindows,
    preResetWeeklyPercent,
    resetAdjustedWeeklyPercent,
    preResetUsedWindows,
    currentSegmentUsedWindows,
    budgetEquivalentUsedWindows,
    remainingWindows,
    totalWindows: budgetEquivalentUsedWindows + remainingWindows,
    bonusResetCount: countBonusResets(sorted),
  };
}

function countUsedFiveHourWindows(observations: CurrentWindowObservation[]): number {
  let used = 0;
  let started = false;
  let curReset: string | null = null;
  let curPeak = 0;
  let lastFivePct = 0;
  let prevWeekly: CurrentWindowObservation | null = null;

  const flush = (): void => {
    if (started && curPeak > USED_WINDOW_MIN_PCT) used++;
  };

  for (const o of observations) {
    // Ein regulärer Weekly-Reset beginnt eine neue 7d-Periode → bereits gezählte
    // 5h-Fenster der Vorperiode dürfen nicht in die aktuelle Periode übertragen.
    if (prevWeekly && classifyWeeklyTransition(prevWeekly, o) === "regular") {
      flush();
      used = 0;
      started = false;
    }
    prevWeekly = o;
    const rollover = started
      && (
        (resetsAtChanged(curReset, o.fiveResetsAt) && o.fivePct < lastFivePct)
        || o.fivePct < lastFivePct - FIVE_RESET_DROP_PCT
      );
    if (!started || rollover) {
      flush();
      started = true;
      curReset = o.fiveResetsAt;
      curPeak = o.fivePct;
    } else {
      if (o.fivePct > curPeak) curPeak = o.fivePct;
      curReset = o.fiveResetsAt ?? curReset;
    }
    lastFivePct = o.fivePct;
  }
  flush();
  return used;
}

function sumPreResetWeeklyPercent(observations: CurrentWindowObservation[]): number {
  let sum = 0;
  let prevValid: CurrentWindowObservation | null = null;

  for (const o of observations) {
    if (prevValid) {
      if (isTransientWeeklySpike(prevValid, o)) continue;
      const kind = classifyWeeklyTransition(prevValid, o);
      if (kind === "bonus") sum += prevValid.weeklyPct;
      // Regulärer Reset → neue Periode: Vor-Reset-Verbrauch nicht über die
      // Periodengrenze hinweg mitschleppen.
      else if (kind === "regular") sum = 0;
    }
    prevValid = o;
  }
  return sum;
}

function countBonusResets(observations: CurrentWindowObservation[]): number {
  let count = 0;
  let prevValid: CurrentWindowObservation | null = null;

  for (const o of observations) {
    if (prevValid) {
      if (isTransientWeeklySpike(prevValid, o)) continue;
      const kind = classifyWeeklyTransition(prevValid, o);
      if (kind === "bonus") count++;
      else if (kind === "regular") count = 0;
    }
    prevValid = o;
  }
  return count;
}

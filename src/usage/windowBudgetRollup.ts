import { resetsAtChanged } from "./windowRatio";

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
const WEEKLY_SPIKE_MIN_PCT = 99.5;
const WEEKLY_SPIKE_DELTA_PCT = 20;
const BONUS_PREV_MIN_PCT = 20;
const BONUS_NEXT_MAX_PCT = 5;
const REGULAR_RESET_ADVANCE_MIN_MS = 6 * 24 * 60 * 60 * 1000;

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

  const flush = (): void => {
    if (started && curPeak > USED_WINDOW_MIN_PCT) used++;
  };

  for (const o of observations) {
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
    if (prevValid && isTransientWeeklySpike(prevValid, o)) continue;
    if (prevValid && isBonusResetTransition(prevValid, o)) {
      sum += prevValid.weeklyPct;
    }
    prevValid = o;
  }
  return sum;
}

function countBonusResets(observations: CurrentWindowObservation[]): number {
  let count = 0;
  let prevValid: CurrentWindowObservation | null = null;

  for (const o of observations) {
    if (prevValid && isTransientWeeklySpike(prevValid, o)) continue;
    if (prevValid && isBonusResetTransition(prevValid, o)) count++;
    prevValid = o;
  }
  return count;
}

function isTransientWeeklySpike(prev: CurrentWindowObservation, next: CurrentWindowObservation): boolean {
  const dFive = next.fivePct - prev.fivePct;
  const dWeekly = next.weeklyPct - prev.weeklyPct;
  return next.weeklyPct >= WEEKLY_SPIKE_MIN_PCT
    && dWeekly > WEEKLY_SPIKE_DELTA_PCT
    && dWeekly > dFive;
}

function isBonusResetTransition(prev: CurrentWindowObservation, next: CurrentWindowObservation): boolean {
  if (prev.weeklyPct < BONUS_PREV_MIN_PCT || next.weeklyPct >= BONUS_NEXT_MAX_PCT) return false;
  return !isRegularWeeklyReset(prev.weeklyResetsAt, next.weeklyResetsAt);
}

function isRegularWeeklyReset(prevResetsAt: string | null, nextResetsAt: string | null): boolean {
  if (prevResetsAt == null || nextResetsAt == null) return false;
  const prevMs = new Date(prevResetsAt).getTime();
  const nextMs = new Date(nextResetsAt).getTime();
  if (!Number.isFinite(prevMs) || !Number.isFinite(nextMs)) return false;
  return nextMs - prevMs >= REGULAR_RESET_ADVANCE_MIN_MS;
}

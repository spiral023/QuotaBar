import { resetsAtChanged, RESETS_AT_TOLERANCE_MS } from "./windowRatio";

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
// Springt der 7d-resetsAt um mindestens so viel nach vorn, wurde ein neues
// 7d-Fenster gestartet (geplanter ODER selbst eingelöster Reset) — kein Bonus.
// Ein echter Kulanz-Bonus lässt resetsAt praktisch unverändert. Siehe
// NEW_WINDOW_ADVANCE_MIN_MS in bonusReset.ts.
const NEW_WINDOW_ADVANCE_MIN_MS = 60 * 60 * 1000;

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

function isTransientWeeklySpike(prev: CurrentWindowObservation, next: CurrentWindowObservation): boolean {
  const dFive = next.fivePct - prev.fivePct;
  const dWeekly = next.weeklyPct - prev.weeklyPct;
  return next.weeklyPct >= WEEKLY_SPIKE_MIN_PCT
    && dWeekly > WEEKLY_SPIKE_DELTA_PCT
    && dWeekly > dFive;
}

type WeeklyTransitionKind = "none" | "regular" | "bonus";

/**
 * Klassifiziert den Übergang prev→next: "none" (kein nennenswerter Abfall),
 * "regular" (geplanter 7d-Reset) oder "bonus" (außerplanmäßiger Kulanz-Reset).
 */
function classifyWeeklyTransition(prev: CurrentWindowObservation, next: CurrentWindowObservation): WeeklyTransitionKind {
  if (prev.weeklyPct < BONUS_PREV_MIN_PCT || next.weeklyPct >= BONUS_NEXT_MAX_PCT) return "none";
  return isRegularWeeklyReset(prev, next) ? "regular" : "bonus";
}

/**
 * Neuer Fenster-Start statt Bonus, wenn ENTWEDER der resetsAt nennenswert nach
 * vorn rückt (geplanter Reset ~7 d ODER selbst eingelöster Reset = Restzeit)
 * ODER der Abfall am/nach dem zuvor geplanten Reset-Termin auftritt. Letzteres
 * ist nötig, weil Claude bei 0 % Verbrauch `resetsAt` weglässt (null) — genau am
 * regulären Reset. In diesem Fall lässt sich nur über den Drop-Zeitstempel ggü.
 * `prev.weeklyResetsAt` entscheiden, ob die Periodengrenze erreicht wurde
 * (regulär) oder der Drop davor liegt (Bonus).
 */
function isRegularWeeklyReset(prev: CurrentWindowObservation, next: CurrentWindowObservation): boolean {
  const prevMs = prev.weeklyResetsAt != null ? new Date(prev.weeklyResetsAt).getTime() : NaN;
  const nextMs = next.weeklyResetsAt != null ? new Date(next.weeklyResetsAt).getTime() : NaN;
  if (Number.isFinite(prevMs) && Number.isFinite(nextMs) && nextMs - prevMs >= NEW_WINDOW_ADVANCE_MIN_MS) {
    return true;
  }
  const dropMs = next.ts != null ? new Date(next.ts).getTime() : NaN;
  return Number.isFinite(prevMs) && Number.isFinite(dropMs) && dropMs >= prevMs - RESETS_AT_TOLERANCE_MS;
}

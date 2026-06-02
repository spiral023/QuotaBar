export type PaceStage =
  | "onTrack"
  | "slightlyAhead"
  | "ahead"
  | "farAhead"
  | "slightlyBehind"
  | "behind"
  | "farBehind";

export interface UsagePace {
  stage: PaceStage;
  deltaPercent: number;
  expectedUsedPercent: number;
  actualUsedPercent: number;
  etaSeconds: number | null;
  willLastToReset: boolean;
}

export interface RateWindow {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: Date | null;
}

export function toRateWindow(w: {
  usedPercent?: number;
  windowSeconds?: number;
  resetsAt?: string;
}): RateWindow {
  return {
    usedPercent: w.usedPercent ?? 0,
    windowMinutes: w.windowSeconds != null ? w.windowSeconds / 60 : null,
    resetsAt: w.resetsAt ? new Date(w.resetsAt) : null,
  };
}

export function computeLinearPace(
  window: RateWindow,
  now: Date = new Date()
): UsagePace | null {
  if (!window.resetsAt) return null;
  const windowMinutes = window.windowMinutes ?? 10080;
  if (windowMinutes <= 0) return null;

  const duration = windowMinutes * 60;
  const timeUntilReset = (window.resetsAt.getTime() - now.getTime()) / 1000;

  if (timeUntilReset <= 0) return null;
  if (timeUntilReset > duration) return null;

  const elapsed = clamp(duration - timeUntilReset, 0, duration);
  const expected = clamp((elapsed / duration) * 100, 0, 100);
  const actual = clamp(window.usedPercent, 0, 100);

  if (elapsed === 0 && actual > 0) return null;

  const delta = actual - expected;
  const stage = stageFor(delta);

  let etaSeconds: number | null = null;
  let willLastToReset = false;

  if (elapsed > 0 && actual > 0) {
    const rate = actual / elapsed;
    if (rate > 0) {
      const remaining = Math.max(0, 100 - actual);
      const candidate = remaining / rate;
      if (candidate >= timeUntilReset) {
        willLastToReset = true;
      } else {
        etaSeconds = candidate;
      }
    }
  } else if (elapsed > 0 && actual === 0) {
    willLastToReset = true;
  }

  return {
    stage,
    deltaPercent: delta,
    expectedUsedPercent: expected,
    actualUsedPercent: actual,
    etaSeconds,
    willLastToReset,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function stageFor(delta: number): PaceStage {
  const abs = Math.abs(delta);
  if (abs <= 2) return "onTrack";
  if (abs <= 6) return delta >= 0 ? "slightlyAhead" : "slightlyBehind";
  if (abs <= 12) return delta >= 0 ? "ahead" : "behind";
  return delta >= 0 ? "farAhead" : "farBehind";
}

export function computeSafetyGap(
  resetsAt: string,
  pace: UsagePace,
  now: Date = new Date()
): number | null {
  const timeToReset = (new Date(resetsAt).getTime() - now.getTime()) / 1000;
  if (timeToReset <= 0) return null;
  if (pace.willLastToReset) return timeToReset;
  if (pace.etaSeconds !== null) return timeToReset - pace.etaSeconds;
  return null;
}

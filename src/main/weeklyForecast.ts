import type { UsagePace } from "../usage/usagePace";
import type { BackfillDayRecord } from "../reports/types";

const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const PROFILE_DAYS = 28;
const MIN_PROFILE_WEEKS = 2;

export interface WeeklyProfile {
  /** Index 0 = Sonntag … 6 = Samstag (Date.getUTCDay) */
  avgTokensPerWeekday: number[];
  weeksOfData: number;
}

/**
 * Typische Token-Menge pro Wochentag aus den Backfill-Tagessummen der
 * letzten 28 Tage. 28 Tage ≙ jeder Wochentag kommt genau 4× vor, daher
 * ist der Divisor konstant 4 (Tage ohne Nutzung zählen als 0).
 */
export function buildWeeklyProfile(records: BackfillDayRecord[], provider: "claude" | "codex", now: Date): WeeklyProfile {
  const sinceMs = now.getTime() - PROFILE_DAYS * DAY_MS;
  const totals = new Array<number>(7).fill(0);
  const weeks = new Set<number>();
  for (const r of records) {
    if (r.provider !== provider) continue;
    const dayMs = new Date(`${r.date}T00:00:00.000Z`).getTime();
    if (Number.isNaN(dayMs) || dayMs < sinceMs || dayMs > now.getTime()) continue;
    totals[new Date(dayMs).getUTCDay()] += r.totalTokens;
    weeks.add(Math.floor(dayMs / (7 * DAY_MS)));
  }
  return {
    avgTokensPerWeekday: totals.map((t) => t / 4),
    weeksOfData: weeks.size,
  };
}

export interface WeeklyForecastInput {
  weeklyUsedPercent: number;
  weeklyResetsAt: string | null;
  /** Token-Summe des Providers innerhalb des aktuellen Weekly-Fensters (Tagesgranularität). */
  tokensInCurrentWindow: number;
  burnRatePctPerHour: number | null;
  pace: UsagePace | null;
  profile: WeeklyProfile;
  now: Date;
}

export interface WeeklyForecastResult {
  primaryAt: string | null;
  primaryKind: "profile" | "linear";
  primaryLastsUntilReset: boolean;
  burnRateAt: string | null;
  /** null = keine Burn-Rate verfügbar */
  burnRateLastsUntilReset: boolean | null;
}

export function computeWeeklyForecast(input: WeeklyForecastInput): WeeklyForecastResult {
  const nowMs = input.now.getTime();
  const resetMs = input.weeklyResetsAt ? new Date(input.weeklyResetsAt).getTime() : null;

  // Sekundär: aktuelle Burn-Rate, linear hochgerechnet
  let burnRateAt: string | null = null;
  let burnRateLastsUntilReset: boolean | null = null;
  if (input.burnRatePctPerHour !== null) {
    if (input.burnRatePctPerHour > 0 && input.weeklyUsedPercent < 100) {
      const atMs = nowMs + ((100 - input.weeklyUsedPercent) / input.burnRatePctPerHour) * HOUR_MS;
      if (resetMs !== null && atMs >= resetMs) {
        burnRateLastsUntilReset = true;
      } else {
        burnRateAt = new Date(atMs).toISOString();
        burnRateLastsUntilReset = false;
      }
    } else {
      burnRateLastsUntilReset = true;
    }
  }

  // Primär: Wochenprofil — stündliche Simulation bis zum Reset
  const profileUsable = input.profile.weeksOfData >= MIN_PROFILE_WEEKS
    && input.tokensInCurrentWindow > 0
    && input.weeklyUsedPercent > 0
    && input.weeklyUsedPercent < 100
    && resetMs !== null
    && input.profile.avgTokensPerWeekday.some((t) => t > 0);
  if (profileUsable) {
    const pctPerToken = input.weeklyUsedPercent / input.tokensInCurrentWindow;
    let pct = input.weeklyUsedPercent;
    for (let t = nowMs; t < resetMs!; t += HOUR_MS) {
      pct += pctPerToken * (input.profile.avgTokensPerWeekday[new Date(t).getUTCDay()] / 24);
      if (pct >= 100) {
        return {
          primaryAt: new Date(t + HOUR_MS).toISOString(),
          primaryKind: "profile",
          primaryLastsUntilReset: false,
          burnRateAt,
          burnRateLastsUntilReset,
        };
      }
    }
    return { primaryAt: null, primaryKind: "profile", primaryLastsUntilReset: true, burnRateAt, burnRateLastsUntilReset };
  }

  // Fallback: lineare Pace (Wochen-Durchschnitt seit Fensterbeginn)
  if (input.pace) {
    if (input.pace.willLastToReset || input.pace.etaSeconds === null) {
      return { primaryAt: null, primaryKind: "linear", primaryLastsUntilReset: true, burnRateAt, burnRateLastsUntilReset };
    }
    return {
      primaryAt: new Date(nowMs + input.pace.etaSeconds * 1000).toISOString(),
      primaryKind: "linear",
      primaryLastsUntilReset: false,
      burnRateAt,
      burnRateLastsUntilReset,
    };
  }
  return { primaryAt: null, primaryKind: "linear", primaryLastsUntilReset: false, burnRateAt, burnRateLastsUntilReset };
}

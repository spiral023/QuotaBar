import { ratioKey, resetsAtChanged } from "./windowRatio";

/**
 * Erkennung außerplanmäßiger ("Bonus-")Resets des Weekly-Fensters.
 *
 * Hintergrund: Ein NORMALER Weekly-Reset senkt den Verbrauch UND schiebt
 * `resetsAt` um ~7 Tage nach vorn. Ein AUSSERPLANMÄSSIGER Reset (z. B. Kulanz/
 * Vorfall bei Anthropic) setzt den Weekly-Verbrauch zurück, OHNE den
 * 7d-Reset-Zeitpunkt entsprechend zu verschieben. Dadurch steht bis zum
 * regulären Reset effektiv erneut Budget zur Verfügung — „Bonus-Fenster".
 */

/** Vorheriger Weekly-%-Wert muss mindestens so hoch gewesen sein. */
export const BONUS_PREV_MIN_PCT = 20;
/** Aktueller Weekly-%-Wert muss darunter gefallen sein. */
export const BONUS_NEXT_MAX_PCT = 5;
/**
 * Springt der 7d-`resetsAt` um mindestens so viel nach vorn, war es ein
 * regulärer Reset (kein Bonus). Knapp unter 7 d, um Jitter/Teilperioden zu
 * tolerieren.
 */
export const BONUS_RESET_ADVANCE_MIN_MS = 6 * 24 * 60 * 60 * 1000;

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;

export interface WeeklyObservation {
  usedPercent: number;
  resetsAt: string | null;
}

/**
 * true, wenn der Übergang prev→next ein außerplanmäßiger Reset ist: Weekly fiel
 * deutlich, aber der 7d-Reset-Zeitpunkt ist NICHT um ~eine volle Periode
 * weitergesprungen.
 */
export function isBonusReset(prev: WeeklyObservation, next: WeeklyObservation): boolean {
  const weeklyDropped = prev.usedPercent >= BONUS_PREV_MIN_PCT && next.usedPercent < BONUS_NEXT_MAX_PCT;
  if (!weeklyDropped) return false;
  // Kein resetsAt bekannt → nicht entscheidbar, konservativ kein Bonus.
  if (prev.resetsAt == null || next.resetsAt == null) return false;
  const advanceMs = new Date(next.resetsAt).getTime() - new Date(prev.resetsAt).getTime();
  if (!Number.isFinite(advanceMs)) return false;
  // Regulärer Reset: resetsAt springt ~+7 d nach vorn → kein Bonus.
  return advanceMs < BONUS_RESET_ADVANCE_MIN_MS;
}

/**
 * Grobe Schätzung der zusätzlichen 5h-Fenster bis zum (unveränderten) regulären
 * 7d-Reset: durch die verbleibende Zeit begrenzt, auf das Budget gedeckelt.
 */
export function estimateBonusWindows(weeklyResetsAt: string | null, nowMs: number, windowsPerWeek: number): number {
  if (weeklyResetsAt == null) return 0;
  const resetMs = new Date(weeklyResetsAt).getTime();
  if (!Number.isFinite(resetMs)) return 0;
  const remainingMs = resetMs - nowMs;
  if (remainingMs <= 0) return 0;
  const byTime = remainingMs / FIVE_HOUR_MS;
  return Math.max(0, Math.min(windowsPerWeek, byTime));
}

interface BonusProviderState {
  lastWeeklyPct: number | null;
  lastWeeklyResetsAt: string | null;
  /** resetsAt der Periode, für die der Bonus gilt; null = kein aktiver Bonus. */
  bonusForResetsAt: string | null;
}

export interface BonusStateFile {
  version: 1;
  providers: Record<string, BonusProviderState>;
}

export function emptyBonusStateFile(): BonusStateFile {
  return { version: 1, providers: {} };
}

function emptyBonusProviderState(): BonusProviderState {
  return { lastWeeklyPct: null, lastWeeklyResetsAt: null, bonusForResetsAt: null };
}

/**
 * Verfolgt pro provider:tier den Weekly-Verlauf und hält den Bonus-Marker für
 * die laufende Periode. Persistiert über `BonusStateFile`, damit das Badge
 * App-Neustarts übersteht.
 */
export class BonusResetTracker {
  constructor(private file: BonusStateFile = emptyBonusStateFile()) {}

  /** Eine neue Weekly-Beobachtung verarbeiten und den Bonus-Marker aktualisieren. */
  record(provider: string, planType: string | null | undefined, obs: WeeklyObservation): void {
    const key = ratioKey(provider, planType);
    const s = this.file.providers[key] ?? emptyBonusProviderState();

    if (s.lastWeeklyPct !== null) {
      const prev: WeeklyObservation = { usedPercent: s.lastWeeklyPct, resetsAt: s.lastWeeklyResetsAt };
      if (isBonusReset(prev, obs)) {
        // Bonus gilt für die nun laufende Periode (deren resetsAt).
        s.bonusForResetsAt = obs.resetsAt;
      } else if (s.bonusForResetsAt && resetsAtChanged(s.bonusForResetsAt, obs.resetsAt)) {
        // Periode regulär weitergesprungen → Bonus-Marker verfällt.
        s.bonusForResetsAt = null;
      }
    }

    s.lastWeeklyPct = obs.usedPercent;
    s.lastWeeklyResetsAt = obs.resetsAt;
    this.file.providers[key] = s;
  }

  /**
   * Bonus-Info für die aktuelle Periode oder null. `active` ist nur true, wenn
   * der gespeicherte Bonus-Marker zur aktuell beobachteten Periode passt.
   */
  getBonus(
    provider: string,
    planType: string | null | undefined,
    weeklyResetsAt: string | null,
    nowMs: number,
    windowsPerWeek: number,
  ): { active: boolean; estimatedExtraWindows: number } | null {
    const s = this.file.providers[ratioKey(provider, planType)];
    if (!s || s.bonusForResetsAt == null) return null;
    // Marker muss zur aktuell gemeldeten Periode gehören.
    if (resetsAtChanged(s.bonusForResetsAt, weeklyResetsAt)) return null;
    return {
      active: true,
      estimatedExtraWindows: estimateBonusWindows(weeklyResetsAt, nowMs, windowsPerWeek),
    };
  }

  getFile(): BonusStateFile {
    return this.file;
  }
}

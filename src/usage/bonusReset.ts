import { ratioKey, resetsAtChanged } from "./windowRatio";
import {
  isBonusReset as isBonusResetPoint,
  isTransientWeeklySpike as isTransientWeeklySpikePoint,
  type WeeklyPoint,
} from "./weeklyTransition";

/**
 * Live-Tracker für außerplanmäßige ("Bonus-")Resets des Weekly-Fensters. Die
 * eigentliche Übergangs-Klassifikation liegt in `weeklyTransition.ts`; hier
 * leben nur die WeeklyObservation-API (für den Live-Pfad in `refreshLoop`), der
 * persistente Bonus-Marker und die Restbudget-Schätzung.
 */

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;

export interface WeeklyObservation {
  usedPercent: number;
  resetsAt: string | null;
  /**
   * 5h-Auslastung desselben Snapshots. Optional, dient als Plausibilitätsanker:
   * ein Weekly-Sprung, der die physikalische Invariante ΔWeekly ≤ Δ5h verletzt,
   * ist ein API-Artefakt und kein echter Verbrauch.
   */
  fivePercent?: number | null;
  /**
   * Zeitstempel des Snapshots (ISO). Optional, dient als Reset-Anker: Claude
   * lässt `resetsAt` bei 0 % weg (null) — genau am regulären Reset. Liegt der
   * Drop am/nach dem zuvor geplanten Reset-Termin (prev.resetsAt), war es ein
   * regulärer Reset; liegt er davor, ein außerplanmäßiger (Bonus-)Reset.
   */
  ts?: string | null;
}

/** WeeklyObservation (Live-Pfad) → neutraler WeeklyPoint (weeklyTransition). */
function toPoint(o: WeeklyObservation): WeeklyPoint {
  return { weeklyPct: o.usedPercent, weeklyResetsAt: o.resetsAt, fivePct: o.fivePercent, ts: o.ts };
}

/**
 * WeeklyObservation-Adapter über `weeklyTransition.isTransientWeeklySpike`.
 * Beibehalten, weil Live-Tracker und `windowHistory` mit der `usedPercent`-API
 * arbeiten.
 */
export function isTransientWeeklySpike(prev: WeeklyObservation, next: WeeklyObservation): boolean {
  return isTransientWeeklySpikePoint(toPoint(prev), toPoint(next));
}

/** WeeklyObservation-Adapter über `weeklyTransition.isBonusReset` (drop-basiert). */
export function isBonusReset(prev: WeeklyObservation, next: WeeklyObservation): boolean {
  return isBonusResetPoint(toPoint(prev), toPoint(next));
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

export interface BonusProviderState {
  lastWeeklyPct: number | null;
  lastWeeklyResetsAt: string | null;
  /** 5h-Wert der letzten plausiblen Beobachtung (Anker für den Spike-Filter). */
  lastFivePct: number | null;
  /** resetsAt der Periode, für die der Bonus gilt; null = kein aktiver Bonus. */
  bonusForResetsAt: string | null;
}

/**
 * Aktuelle Schemaversion. v2 führte `lastFivePct` (Spike-Filter-Anker) ein;
 * beim Laden einer v1-Datei werden Bonus-Marker verworfen, da sie noch mit der
 * spike-anfälligen Erkennung (vor dem utilization-Skalen-Fix) gesetzt wurden.
 */
export const BONUS_STATE_VERSION = 2;

export interface BonusStateFile {
  version: typeof BONUS_STATE_VERSION;
  providers: Record<string, BonusProviderState>;
}

export function emptyBonusStateFile(): BonusStateFile {
  return { version: BONUS_STATE_VERSION, providers: {} };
}

function emptyBonusProviderState(): BonusProviderState {
  return { lastWeeklyPct: null, lastWeeklyResetsAt: null, lastFivePct: null, bonusForResetsAt: null };
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
      const prev: WeeklyObservation = {
        usedPercent: s.lastWeeklyPct,
        resetsAt: s.lastWeeklyResetsAt,
        fivePercent: s.lastFivePct,
      };
      // Transiente Weekly-Spikes (API-Artefakte wie das frühere 1 % → 100 %)
      // verwerfen, BEVOR sie zum Vergleichsanker werden — sonst sieht der
      // anschließende Abfall 100 → 2 wie ein außerplanmäßiger Reset aus.
      if (isTransientWeeklySpike(prev, obs)) return;
      if (isBonusReset(prev, obs)) {
        // Bonus gilt für die laufende Periode. Claude lässt resetsAt bei 0 %
        // weg (null) — dann den Periodentermin von prev übernehmen, sonst ginge
        // der gerade erkannte Bonus-Marker (null = kein Bonus) sofort verloren.
        s.bonusForResetsAt = obs.resetsAt ?? prev.resetsAt;
      } else if (s.bonusForResetsAt && resetsAtChanged(s.bonusForResetsAt, obs.resetsAt)) {
        // Periode regulär weitergesprungen → Bonus-Marker verfällt.
        s.bonusForResetsAt = null;
      }
    }

    s.lastWeeklyPct = obs.usedPercent;
    s.lastWeeklyResetsAt = obs.resetsAt;
    s.lastFivePct = typeof obs.fivePercent === "number" ? obs.fivePercent : null;
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

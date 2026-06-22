import { ratioKey, resetsAtChanged, RESETS_AT_TOLERANCE_MS } from "./windowRatio";

/**
 * Erkennung außerplanmäßiger ("Bonus-")Resets des Weekly-Fensters.
 *
 * Hintergrund: Ein NORMALER Weekly-Reset senkt den Verbrauch UND schiebt
 * `resetsAt` um ~7 Tage nach vorn. Ein AUSSERPLANMÄSSIGER Reset (z. B. Kulanz/
 * Vorfall bei Anthropic) setzt den Weekly-Verbrauch zurück, OHNE den
 * 7d-Reset-Zeitpunkt entsprechend zu verschieben. Dadurch steht bis zum
 * regulären Reset effektiv erneut Budget zur Verfügung — „Bonus-Fenster".
 */

/**
 * Mindest-Abfall (Prozentpunkte) des Weekly-Werts, der als außerplanmäßiger
 * Reset zählt. Ein Kulanz-Reset ist stand-unabhängig (kann bei 12 % genauso
 * passieren wie bei 80 %), daher wird der ABFALL bewertet, nicht der absolute
 * Vorstand. Liegt über dem Ganzzahl-Rundungsrauschen (z. B. 3 → 0 zählt nicht).
 */
export const BONUS_DROP_MIN_PCT = 10;
/** Aktueller Weekly-%-Wert muss darunter gefallen sein (Budget effektiv freigegeben). */
export const BONUS_NEXT_MAX_PCT = 5;
/**
 * Springt der 7d-`resetsAt` um mindestens so viel NACH VORN, wurde ein neues
 * 7d-Fenster gestartet — sei es der geplante Reset (~7 d Sprung) ODER ein vom
 * Nutzer selbst eingelöster Reset (Sprung = Restzeit, kann deutlich < 7 d sein).
 * Beides ist KEIN Bonus. Ein echter Kulanz-Bonus lässt `resetsAt` dagegen
 * praktisch unverändert (nur Sekunden-Jitter). Schwelle deutlich über Codex'
 * Minuten-„Treppung" des resetsAt, aber weit unter jedem realen Fenster-Sprung
 * (Stunden bis Tage).
 */
export const NEW_WINDOW_ADVANCE_MIN_MS = 60 * 60 * 1000;

/** Ab diesem Weekly-%-Wert gilt next als Sättigungs-Ausreißer-Kandidat. */
export const WEEKLY_SPIKE_MIN_PCT = 99.5;
/** Mindest-Sprunghöhe (Prozentpunkte) eines verdächtigen Aufwärts-Spikes. */
export const WEEKLY_SPIKE_DELTA_PCT = 20;

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

/**
 * true, wenn next ein transienter Weekly-Aufwärts-Spike ggü. prev ist: Weekly
 * springt auf ~100 %, der Sprung ist groß UND übersteigt die parallele 5h-
 * Bewegung. Genau dieses Muster erzeugte die alte utilization-Skala (1 % → 100 %
 * direkt nach einem Reset) — der hohe Wert ist physikalisch unmöglich, weil das
 * 5h-Fenster dann noch fast leer ist. Ohne 5h-Wert wird konservativ allein der
 * implausible Sprung auf Sättigung bewertet.
 */
export function isTransientWeeklySpike(prev: WeeklyObservation, next: WeeklyObservation): boolean {
  const dWeekly = next.usedPercent - prev.usedPercent;
  if (next.usedPercent < WEEKLY_SPIKE_MIN_PCT || dWeekly <= WEEKLY_SPIKE_DELTA_PCT) return false;
  if (typeof prev.fivePercent !== "number" || typeof next.fivePercent !== "number") return true;
  const dFive = next.fivePercent - prev.fivePercent;
  return dWeekly > dFive;
}

/**
 * true, wenn der Übergang prev→next ein außerplanmäßiger Reset ist: Weekly fiel
 * deutlich (auf ~0), aber der 7d-Reset-Zeitpunkt ist NICHT um ~eine volle
 * Periode weitergesprungen. Transiente Spikes werden vorgelagert gefiltert
 * (siehe BonusResetTracker.record), sodass prev hier ein plausibler Stand ist.
 */
export function isBonusReset(prev: WeeklyObservation, next: WeeklyObservation): boolean {
  const drop = prev.usedPercent - next.usedPercent;
  const weeklyDropped = drop >= BONUS_DROP_MIN_PCT && next.usedPercent < BONUS_NEXT_MAX_PCT;
  if (!weeklyDropped) return false;
  // Ohne prev.resetsAt fehlt der Bezugs-Termin → nicht entscheidbar, kein Bonus.
  if (prev.resetsAt == null) return false;
  // Regulärer Reset → kein Bonus.
  return !isRegularWeeklyReset(prev, next);
}

/**
 * Neuer Fenster-Start statt Bonus, wenn ENTWEDER der resetsAt nennenswert nach
 * vorn rückt (geplanter Reset ~7 d ODER selbst eingelöster Reset = Restzeit)
 * ODER der Abfall am/nach dem zuvor geplanten Reset-Termin (prev.resetsAt)
 * auftritt. Letzteres ist nötig, weil Claude bei 0 % Verbrauch `resetsAt`
 * weglässt (null) — genau am regulären Reset.
 */
function isRegularWeeklyReset(prev: WeeklyObservation, next: WeeklyObservation): boolean {
  const prevMs = prev.resetsAt != null ? new Date(prev.resetsAt).getTime() : NaN;
  const nextMs = next.resetsAt != null ? new Date(next.resetsAt).getTime() : NaN;
  if (Number.isFinite(prevMs) && Number.isFinite(nextMs) && nextMs - prevMs >= NEW_WINDOW_ADVANCE_MIN_MS) {
    return true;
  }
  const dropMs = next.ts != null ? new Date(next.ts).getTime() : NaN;
  return Number.isFinite(prevMs) && Number.isFinite(dropMs) && dropMs >= prevMs - RESETS_AT_TOLERANCE_MS;
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

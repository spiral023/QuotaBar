import { RESETS_AT_TOLERANCE_MS } from "./windowRatio";

/**
 * Gemeinsame Klassifikation von Weekly-Fenster-Übergängen (regulärer Reset,
 * außerplanmäßiger „Bonus"-Reset, transienter API-Spike). Single Source of
 * Truth für drei Consumer: den Live-Tracker (`bonusReset.ts`), den Rückblick
 * auf die laufende Periode (`windowBudgetRollup.ts`) und die Perioden-Historie
 * (`windowHistory.ts`).
 *
 * Hintergrund: Ein NORMALER Weekly-Reset senkt den Verbrauch UND schiebt
 * `resetsAt` um ~7 Tage nach vorn. Ein AUSSERPLANMÄSSIGER Reset (z. B. Kulanz/
 * Vorfall bei Anthropic) setzt den Weekly-Verbrauch zurück, OHNE den
 * 7d-Reset-Zeitpunkt entsprechend zu verschieben — bis zum regulären Reset
 * steht effektiv erneut Budget zur Verfügung („Bonus-Fenster").
 */

/** Ab diesem Weekly-%-Wert gilt next als Sättigungs-Ausreißer-Kandidat. */
export const WEEKLY_SPIKE_MIN_PCT = 99.5;
/** Mindest-Sprunghöhe (Prozentpunkte) eines verdächtigen Aufwärts-Spikes. */
export const WEEKLY_SPIKE_DELTA_PCT = 20;
/**
 * Springt der 7d-`resetsAt` um mindestens so viel NACH VORN, wurde ein neues
 * 7d-Fenster gestartet — sei es der geplante Reset (~7 d Sprung) ODER ein vom
 * Nutzer selbst eingelöster Reset (Sprung = Restzeit, kann deutlich < 7 d sein).
 * Beides ist KEIN Bonus. Ein echter Kulanz-Bonus lässt `resetsAt` dagegen
 * praktisch unverändert (nur Sekunden-Jitter). Schwelle deutlich über Codex'
 * Minuten-„Treppung" des resetsAt, aber weit unter jedem realen Fenster-Sprung.
 */
export const NEW_WINDOW_ADVANCE_MIN_MS = 60 * 60 * 1000;
/** Aktueller Weekly-%-Wert muss darunter gefallen sein (Budget effektiv freigegeben). */
export const BONUS_NEXT_MAX_PCT = 5;

/**
 * Bonus-EINTRITTSkriterium des Live-/Historien-Pfads ({@link isBonusReset}):
 * bewertet den ABFALL (prev − next). Ein Kulanz-Reset ist stand-unabhängig
 * (kann bei 12 % genauso passieren wie bei 80 %), daher zählt der Abfall, nicht
 * der absolute Vorstand. Liegt über dem Ganzzahl-Rundungsrauschen.
 *
 * BEWUSST abweichend von {@link BONUS_PREV_MIN_PCT} (Rollup-Pfad): Der
 * Live-Tracker sieht einzelne aufeinanderfolgende Übergänge und soll auch
 * kleinere, aber eindeutige Resets erkennen; der Rollup wertet eine ganze
 * historische Serie aus und ist konservativer (verlangt höheren Vorstand), um
 * Fehlerkennungen über viele Datenpunkte nicht zu kumulieren. Die beiden Werte
 * sind hier zentralisiert, damit die Divergenz sichtbar bleibt und nicht erneut
 * auseinanderdriftet.
 */
export const BONUS_DROP_MIN_PCT = 10;
/**
 * Bonus-EINTRITTSkriterium des Rollup-Pfads ({@link classifyWeeklyTransition}):
 * bewertet den absoluten VORSTAND (prev). Siehe Divergenz-Hinweis bei
 * {@link BONUS_DROP_MIN_PCT}.
 */
export const BONUS_PREV_MIN_PCT = 20;

export type WeeklyTransitionKind = "none" | "regular" | "bonus";

/**
 * Minimaler Übergangs-Datenpunkt. `CurrentWindowObservation` (Rollup) und
 * `HistoryObservation` (Historie) sind strukturell kompatibel; der Live-Tracker
 * mappt seine `WeeklyObservation` darauf.
 */
export interface WeeklyPoint {
  weeklyPct: number;
  weeklyResetsAt: string | null;
  /**
   * 5h-Auslastung desselben Snapshots. Optional, dient als Plausibilitätsanker:
   * ein Weekly-Sprung, der die Invariante ΔWeekly ≤ Δ5h verletzt, ist ein
   * API-Artefakt und kein echter Verbrauch.
   */
  fivePct?: number | null;
  /**
   * Zeitstempel des Snapshots (ISO). Reset-Anker: Claude lässt `resetsAt` bei
   * 0 % weg (null) — genau am regulären Reset. Liegt der Drop am/nach dem zuvor
   * geplanten Reset-Termin, war es ein regulärer Reset; davor ein Bonus-Reset.
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
export function isTransientWeeklySpike(prev: WeeklyPoint, next: WeeklyPoint): boolean {
  const dWeekly = next.weeklyPct - prev.weeklyPct;
  if (next.weeklyPct < WEEKLY_SPIKE_MIN_PCT || dWeekly <= WEEKLY_SPIKE_DELTA_PCT) return false;
  if (typeof prev.fivePct !== "number" || typeof next.fivePct !== "number") return true;
  const dFive = next.fivePct - prev.fivePct;
  return dWeekly > dFive;
}

/**
 * Neuer Fenster-Start statt Bonus, wenn ENTWEDER der resetsAt nennenswert nach
 * vorn rückt (geplanter Reset ~7 d ODER selbst eingelöster Reset = Restzeit)
 * ODER der Abfall am/nach dem zuvor geplanten Reset-Termin (prev) auftritt.
 * Letzteres ist nötig, weil Claude bei 0 % Verbrauch `resetsAt` weglässt (null)
 * — genau am regulären Reset.
 */
export function isRegularWeeklyReset(prev: WeeklyPoint, next: WeeklyPoint): boolean {
  const prevMs = prev.weeklyResetsAt != null ? new Date(prev.weeklyResetsAt).getTime() : NaN;
  const nextMs = next.weeklyResetsAt != null ? new Date(next.weeklyResetsAt).getTime() : NaN;
  if (Number.isFinite(prevMs) && Number.isFinite(nextMs) && nextMs - prevMs >= NEW_WINDOW_ADVANCE_MIN_MS) {
    return true;
  }
  const dropMs = next.ts != null ? new Date(next.ts).getTime() : NaN;
  return Number.isFinite(prevMs) && Number.isFinite(dropMs) && dropMs >= prevMs - RESETS_AT_TOLERANCE_MS;
}

/**
 * Drop-basiertes Bonus-Kriterium (Live-/Historien-Pfad): Weekly fiel deutlich
 * (≥ {@link BONUS_DROP_MIN_PCT}) auf ~0, aber der 7d-Reset-Zeitpunkt ist NICHT
 * um ~eine volle Periode weitergesprungen. Transiente Spikes werden vorgelagert
 * gefiltert, sodass prev hier ein plausibler Stand ist.
 */
export function isBonusReset(prev: WeeklyPoint, next: WeeklyPoint): boolean {
  const drop = prev.weeklyPct - next.weeklyPct;
  const weeklyDropped = drop >= BONUS_DROP_MIN_PCT && next.weeklyPct < BONUS_NEXT_MAX_PCT;
  if (!weeklyDropped) return false;
  // Ohne prev.weeklyResetsAt fehlt der Bezugs-Termin → nicht entscheidbar, kein Bonus.
  if (prev.weeklyResetsAt == null) return false;
  return !isRegularWeeklyReset(prev, next);
}

/**
 * Prev-basiertes Bonus-Kriterium (Rollup-Pfad): klassifiziert den Übergang
 * prev→next als "none" (kein nennenswerter Abfall), "regular" (geplanter
 * 7d-Reset) oder "bonus" (außerplanmäßiger Kulanz-Reset). Verlangt einen
 * höheren Vorstand als der Live-Pfad — siehe {@link BONUS_PREV_MIN_PCT}.
 */
export function classifyWeeklyTransition(prev: WeeklyPoint, next: WeeklyPoint): WeeklyTransitionKind {
  if (prev.weeklyPct < BONUS_PREV_MIN_PCT || next.weeklyPct >= BONUS_NEXT_MAX_PCT) return "none";
  return isRegularWeeklyReset(prev, next) ? "regular" : "bonus";
}

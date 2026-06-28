import { resetsAtChanged } from "./windowRatio";
import { isBonusReset, isTransientWeeklySpike } from "./weeklyTransition";

/**
 * Historie „genutzte vs. mögliche 5h-Fenster pro 7d-Fenster". Aus den
 * Snapshot-Beobachtungen der Live-Logs rekonstruiert; ein Eintrag pro
 * abgeschlossener 7d-Periode und Anbieter.
 */
export interface WindowHistoryEntry {
  provider: string;
  weekStart: string;            // ISO; Periodenbeginn (= weekEnd − 7 d)
  weekEnd: string;              // ISO; Periodenende (= Weekly-resetsAt)
  usedWindows: number;          // 5h-Fenster mit nennenswerter Aktivität (>5 %)
  maxWindows: number | null;    // gelerntes windowsPerWeek dieser Periode (null = zu wenig Daten)
  bonus: boolean;               // außerplanmäßiger Reset in dieser Periode
}

export interface WindowHistoryFile {
  version: 2;
  entries: WindowHistoryEntry[];
}

export function emptyWindowHistoryFile(): WindowHistoryFile {
  return { version: 2, entries: [] };
}

export interface HistoryObservation {
  provider: string;
  ts: string;
  fivePct: number;
  fiveResetsAt: string | null;
  weeklyPct: number;
  weeklyResetsAt: string | null;
}

/** Ab diesem Spitzen-Füllgrad gilt ein 5h-Fenster als „genutzt". */
export const USED_WINDOW_MIN_PCT = 5;
/** Mindest-Σ-Weekly-Bewegung, damit maxWindows einer Periode belastbar ist. */
const MIN_PERIOD_WEEKLY_PCT = 5;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Erst ein resetsAt-Sprung über dieser Schwelle beginnt eine neue 7d-Periode.
 * Echte Resets liegen Tage auseinander; Codex' Weekly-resetsAt „treppt" beim
 * Übergang dagegen in Minuten-Schritten — die müssen im selben Fenster bleiben,
 * sonst zerfällt eine Periode in viele leere Pseudo-Perioden.
 */
const PERIOD_SPLIT_MS = 2 * 24 * 60 * 60 * 1000;

interface Period {
  lastReset: string;            // zuletzt beobachteter resetsAt der Periode (= weekEnd)
  obs: HistoryObservation[];
}

/**
 * Rekonstruiert die abgeschlossenen 7d-Perioden aus chronologischen
 * Beobachtungen. Die jeweils laufende (letzte, noch nicht abgelöste und in der
 * Zukunft endende) Periode wird ausgelassen.
 */
export function buildWindowHistory(observations: HistoryObservation[], nowMs: number): WindowHistoryEntry[] {
  const byProvider = new Map<string, HistoryObservation[]>();
  for (const o of observations) {
    const list = byProvider.get(o.provider) ?? [];
    list.push(o);
    byProvider.set(o.provider, list);
  }

  const entries: WindowHistoryEntry[] = [];
  for (const [provider, list] of byProvider) {
    list.sort((a, b) => a.ts.localeCompare(b.ts));
    const periods = segmentByWeeklyReset(list);
    for (const p of periods) {
      const resetMs = new Date(p.lastReset).getTime();
      if (!Number.isFinite(resetMs)) continue;
      // Nur abgeschlossene Perioden: Endzeitpunkt liegt in der Vergangenheit.
      if (resetMs > nowMs) continue;
      entries.push(buildEntry(provider, p));
    }
  }
  entries.sort((a, b) => a.weekEnd.localeCompare(b.weekEnd));
  return entries;
}

function segmentByWeeklyReset(obs: HistoryObservation[]): Period[] {
  const periods: Period[] = [];
  let current: Period | null = null;
  for (const o of obs) {
    if (o.weeklyResetsAt == null) {
      // Ohne Periodengrenze der laufenden Periode zuschlagen (sofern vorhanden).
      if (current) current.obs.push(o);
      continue;
    }
    const newMs = new Date(o.weeklyResetsAt).getTime();
    const curMs = current ? new Date(current.lastReset).getTime() : NaN;
    const jumpMs = Number.isFinite(curMs) && Number.isFinite(newMs) ? Math.abs(newMs - curMs) : Infinity;
    if (!current || jumpMs > PERIOD_SPLIT_MS) {
      current = { lastReset: o.weeklyResetsAt, obs: [o] };
      periods.push(current);
    } else {
      current.obs.push(o);
      // Innerhalb der Periode den eingependelten resetsAt nachführen.
      current.lastReset = o.weeklyResetsAt;
    }
  }
  return periods;
}

function buildEntry(provider: string, p: Period): WindowHistoryEntry {
  const weekEnd = p.lastReset;
  const weekStart = new Date(new Date(weekEnd).getTime() - SEVEN_DAYS_MS).toISOString();

  // 5h-Fenster zählen: nach fiveResetsAt segmentieren, je Fenster den Spitzenwert.
  let usedWindows = 0;
  let curFiveReset: string | null | undefined;
  let curFivePeak = 0;
  let started = false;
  const flushFive = (): void => {
    if (started && curFivePeak > USED_WINDOW_MIN_PCT) usedWindows++;
  };
  for (const o of p.obs) {
    if (!started) {
      started = true;
      curFiveReset = o.fiveResetsAt;
      curFivePeak = o.fivePct;
    } else if (resetsAtChanged(curFiveReset, o.fiveResetsAt)) {
      flushFive();
      curFiveReset = o.fiveResetsAt;
      curFivePeak = o.fivePct;
    } else {
      if (o.fivePct > curFivePeak) curFivePeak = o.fivePct;
    }
  }
  flushFive();

  // maxWindows: periodenspezifisches windowsPerWeek aus validen Paaren.
  let sumFive = 0;
  let sumWeekly = 0;
  for (let i = 1; i < p.obs.length; i++) {
    const prev = p.obs[i - 1];
    const cur = p.obs[i];
    const dFive = cur.fivePct - prev.fivePct;
    const dWeekly = cur.weeklyPct - prev.weeklyPct;
    const fiveRollover = resetsAtChanged(prev.fiveResetsAt, cur.fiveResetsAt);
    if (dFive > 0 && dWeekly >= 0 && dWeekly <= dFive && !fiveRollover) {
      sumFive += dFive;
      sumWeekly += dWeekly;
    }
  }
  const maxWindows = sumWeekly >= MIN_PERIOD_WEEKLY_PCT ? sumFive / sumWeekly : null;

  // bonus: außerplanmäßiger Reset innerhalb der Periode (Weekly fiel deutlich,
  // resetsAt blieb). Transiente Weekly-Spikes (Skalen-Artefakte) werden
  // verworfen statt als Anker zu dienen — sonst sieht der Abfall vom
  // aufgeblähten Wert wie ein Reset aus. Vgl. windowBudgetRollup.
  let bonus = false;
  let prevValid: HistoryObservation | null = null;
  for (const o of p.obs) {
    if (prevValid) {
      if (isTransientWeeklySpike(prevValid, o)) continue;
      if (isBonusReset(prevValid, o)) bonus = true;
    }
    prevValid = o;
  }

  return { provider, weekStart, weekEnd, usedWindows, maxWindows, bonus };
}

/** Spitzen-fivePct, ab dem ein 5h-Fenster als „heiß" (throttling-nah) gilt. */
export const PRESSURE_HOT_PCT = 90;

export interface PressureDist {
  buckets: { crit: number; high: number; mid: number; low: number; min: number };
  total: number;     // aktive Fenster (Peak > USED_WINDOW_MIN_PCT)
  hotCount: number;  // Fenster mit Peak >= PRESSURE_HOT_PCT (= buckets.crit)
  worst: { pct: number; windowStart: string } | null;
}

/**
 * Verteilung der Spitzen-Auslastung (fivePct) über die aktiven 5h-Fenster eines
 * Anbieters im Zeitraum [sinceMs, untilMs]. Segmentiert nach fiveResetsAt; je
 * Fenster zählt der Spitzenwert. Idle-Fenster (Peak <= 5 %) werden verworfen.
 */
export function buildFiveHourPressure(
  observations: HistoryObservation[],
  sinceMs: number,
  untilMs: number,
  provider: string,
): PressureDist {
  const buckets = { crit: 0, high: 0, mid: 0, low: 0, min: 0 };
  let total = 0;
  let worst: { pct: number; windowStart: string } | null = null;

  const list = observations
    .filter((o) => o.provider === provider)
    .sort((a, b) => a.ts.localeCompare(b.ts));

  let curReset: string | null | undefined;
  let curPeak = 0;
  let curStart: string | null = null;
  let started = false;

  const flush = (): void => {
    if (!started || curStart === null) return;
    const startMs = new Date(curStart).getTime();
    if (!Number.isFinite(startMs) || startMs < sinceMs || startMs > untilMs) return;
    if (curPeak <= USED_WINDOW_MIN_PCT) return;
    total++;
    if (curPeak >= 90) buckets.crit++;
    else if (curPeak >= 75) buckets.high++;
    else if (curPeak >= 50) buckets.mid++;
    else if (curPeak >= 25) buckets.low++;
    else buckets.min++;
    if (!worst || curPeak > worst.pct) worst = { pct: curPeak, windowStart: curStart };
  };

  for (const o of list) {
    if (!started) {
      started = true;
      curReset = o.fiveResetsAt;
      curPeak = o.fivePct;
      curStart = o.ts;
    } else if (resetsAtChanged(curReset, o.fiveResetsAt)) {
      flush();
      curReset = o.fiveResetsAt;
      curPeak = o.fivePct;
      curStart = o.ts;
    } else if (o.fivePct > curPeak) {
      curPeak = o.fivePct;
    }
  }
  flush();

  return { buckets, total, hotCount: buckets.crit, worst };
}

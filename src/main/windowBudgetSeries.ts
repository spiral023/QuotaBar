import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resetsAtChanged } from "../usage/windowRatio";

const LIVE_LOG_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const RESET_DROP_PCT = 15;
const SPIKE_DELTA_PCT = 20;
export const GAP_THRESHOLD_MS = 60 * 60_000;
export const WEEKLY_RESET_DROP_PCT = 15;

export interface WeeklySeriesPoint {
  t: string;
  weeklyPct: number | null;
}

export interface WindowBudgetSeries {
  points: WeeklySeriesPoint[];
  fiveHourResets: string[];
}

/**
 * Liest die Weekly-Auslastung eines Providers aus den Live-Debug-Logs als
 * Zeitreihe (gebuckted) und markiert 5h-Fenster-Resets. Quelle sind die
 * Snapshot-Events; Backfill-Dateien enthalten keine und werden ignoriert.
 */
export async function readWeeklySeries(
  logDir: string,
  provider: string,
  windowStartMs: number,
  nowMs: number,
  bucketMinutes = 30,
  planType?: string | null,
): Promise<WindowBudgetSeries> {
  const empty: WindowBudgetSeries = { points: [], fiveHourResets: [] };
  let entries: string[];
  try {
    entries = await fs.readdir(logDir);
  } catch {
    return empty;
  }
  const startKey = utcDateKey(new Date(windowStartMs));
  const files = entries
    .map((e) => LIVE_LOG_RE.exec(e))
    .filter((m): m is RegExpExecArray => m !== null && m[1] >= startKey)
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map((m) => path.join(logDir, m[0]));

  const bucketMs = bucketMinutes * 60_000;
  const buckets = new Map<number, number>();
  const resets: string[] = [];
  let prevFivePct: number | null = null;
  let prevFiveResetsAt: string | null = null;

  for (const file of files) {
    try {
      const rl = createInterface({
        input: createReadStream(file, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.includes('"kind":"snapshot"')) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (event.kind !== "snapshot" || event.provider !== provider || event.status !== "ok") continue;
        // Filter by planType before bucketing AND reset detection so that
        // account-switches (different planType) are never mistaken for 5h resets.
        if (typeof planType === "string" && event.planType !== planType) continue;
        const ts = typeof event.ts === "string" ? event.ts : null;
        if (!ts) continue;
        const tsMs = new Date(ts).getTime();
        if (Number.isNaN(tsMs) || tsMs < windowStartMs || tsMs > nowMs) continue;
        const windows = Array.isArray(event.windows) ? (event.windows as Array<Record<string, unknown>>) : [];
        const weekly = windows.find((w) => w.name === "weekly");
        const five = windows.find((w) => w.name === "fiveHour");
        if (typeof weekly?.usedPercent === "number") {
          buckets.set(Math.floor(tsMs / bucketMs) * bucketMs, weekly.usedPercent);
        }
        if (typeof five?.usedPercent === "number") {
          const fiveResetsAt = typeof five.resetsAt === "string" ? five.resetsAt : null;
          // Codex idle windows roll resetsAt forward on every poll (ts+5h) while
          // usage stays flat/rising — only count a resetsAt change as a genuine
          // reset when usage also decreased (a real rollover empties the window).
          if (resetsAtChanged(prevFiveResetsAt, fiveResetsAt) && prevFivePct !== null && five.usedPercent < prevFivePct) {
            resets.push(ts);
          } else if (prevFivePct !== null && five.usedPercent < prevFivePct - RESET_DROP_PCT) {
            resets.push(ts);
          }
          prevFivePct = five.usedPercent;
          prevFiveResetsAt = fiveResetsAt;
        }
      }
    } catch {
      // Datei nicht lesbar — überspringen
    }
  }

  const points = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ms, pct]) => ({ t: new Date(ms).toISOString(), weeklyPct: pct }));
  return { points: insertBreaks(removeSpikes(points)), fiveHourResets: resets };
}

/** Entfernt isolierte Ausreißer-Buckets (transiente weekly=100-Spikes der API). */
function removeSpikes(points: WeeklySeriesPoint[]): WeeklySeriesPoint[] {
  if (points.length < 2) return points;
  return points.filter((p, i) => {
    if (p.weeklyPct === null) return true;
    const left = i > 0 ? points[i - 1].weeklyPct : null;
    const right = i < points.length - 1 ? points[i + 1].weeklyPct : null;
    const aboveLeft = left === null || p.weeklyPct - left > SPIKE_DELTA_PCT;
    const aboveRight = right === null || p.weeklyPct - right > SPIKE_DELTA_PCT;
    return !(aboveLeft && aboveRight);
  });
}

export function insertBreaks(points: WeeklySeriesPoint[]): WeeklySeriesPoint[] {
  if (points.length < 2) return points;
  const out: WeeklySeriesPoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (prev.weeklyPct !== null && cur.weeklyPct !== null) {
      const prevMs = new Date(prev.t).getTime();
      const curMs = new Date(cur.t).getTime();
      const gap = curMs - prevMs > GAP_THRESHOLD_MS;
      const drop = prev.weeklyPct - cur.weeklyPct > WEEKLY_RESET_DROP_PCT;
      if (gap || drop) {
        out.push({ t: new Date((prevMs + curMs) / 2).toISOString(), weeklyPct: null });
      }
    }
    out.push(cur);
  }
  return out;
}

function utcDateKey(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

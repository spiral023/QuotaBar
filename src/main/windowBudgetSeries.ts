import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const LIVE_LOG_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const RESET_DROP_PCT = 15;

export interface WeeklySeriesPoint {
  t: string;
  weeklyPct: number;
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
          if (prevFiveResetsAt !== null && fiveResetsAt !== null && fiveResetsAt !== prevFiveResetsAt) {
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
  return { points, fiveHourResets: resets };
}

function utcDateKey(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

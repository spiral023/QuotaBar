import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  clearTransients,
  emptyProviderState,
  emptyRatioFile,
  ratioKey,
  recordObservation,
  type WindowRatioFile,
} from "../usage/windowRatio";

const LIVE_LOG_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * Einmal-Seed: liest alle Live-Debug-Logs (Snapshot-Events) chronologisch und
 * füttert denselben Akkumulator wie der Live-Tracker. Backfill-Dateien
 * enthalten keine Snapshot-Events und werden ignoriert.
 */
export async function seedFromDebugLogs(logDir: string): Promise<WindowRatioFile> {
  const result = emptyRatioFile();
  let entries: string[];
  try {
    entries = await fs.readdir(logDir);
  } catch {
    return result;
  }
  const files = entries
    .map((e) => LIVE_LOG_RE.exec(e))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => a[1].localeCompare(b[1]));

  for (const match of files) {
    await seedFile(path.join(logDir, match[0]), result);
    result.seededThrough = match[1];
  }
  return clearTransients(result);
}

async function seedFile(filePath: string, result: WindowRatioFile): Promise<void> {
  try {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
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
      if (event.kind !== "snapshot" || event.status !== "ok") continue;
      const provider = typeof event.provider === "string" ? event.provider : null;
      if (!provider) continue;
      const ts = typeof event.ts === "string" ? event.ts : null;
      if (!ts) continue;
      const windows = Array.isArray(event.windows) ? (event.windows as Array<Record<string, unknown>>) : [];
      const five = windows.find((w) => w.name === "fiveHour");
      const weekly = windows.find((w) => w.name === "weekly");
      if (typeof five?.usedPercent !== "number" || typeof weekly?.usedPercent !== "number") continue;
      const key = ratioKey(provider, typeof event.planType === "string" ? event.planType : null);
      const prev = result.providers[key] ?? emptyProviderState();
      result.providers[key] = recordObservation(prev, {
        fivePct: five.usedPercent,
        weeklyPct: weekly.usedPercent,
        fiveResetsAt: typeof five.resetsAt === "string" ? five.resetsAt : null,
        planType: typeof event.planType === "string" ? event.planType : null,
        ts,
      });
    }
  } catch {
    // Datei nicht lesbar — überspringen
  }
}

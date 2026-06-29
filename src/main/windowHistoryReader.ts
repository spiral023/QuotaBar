import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { HistoryObservation } from "../usage/windowHistory";

const LIVE_LOG_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * Liest alle Live-Debug-Logs (Snapshot-Events) und liefert die rohen 5h-/Weekly-
 * Beobachtungen je Anbieter — Grundlage für die 7d-Fenster-Historie.
 */
export async function readWindowHistoryObservations(logDir: string): Promise<HistoryObservation[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(logDir);
  } catch {
    return [];
  }
  const files = entries
    .map((e) => LIVE_LOG_RE.exec(e))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => a[1].localeCompare(b[1]));

  const out: HistoryObservation[] = [];
  for (const match of files) {
    await readFile(path.join(logDir, match[0]), out);
  }
  return out;
}

async function readFile(filePath: string, out: HistoryObservation[]): Promise<void> {
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
      const ts = typeof event.ts === "string" ? event.ts : null;
      if (!provider || !ts) continue;
      const windows = Array.isArray(event.windows) ? (event.windows as Array<Record<string, unknown>>) : [];
      const five = windows.find((w) => w.name === "fiveHour");
      const weekly = windows.find((w) => w.name === "weekly");
      if (typeof five?.usedPercent !== "number" || typeof weekly?.usedPercent !== "number") continue;
      out.push({
        provider,
        ts,
        fivePct: five.usedPercent,
        fiveResetsAt: typeof five.resetsAt === "string" ? five.resetsAt : null,
        weeklyPct: weekly.usedPercent,
        weeklyResetsAt: typeof weekly.resetsAt === "string" ? weekly.resetsAt : null,
      });
    }
  } catch {
    // Datei nicht lesbar — überspringen
  }
}

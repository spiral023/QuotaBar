import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { BackfillDayRecord, BackfillPerModelEntry } from "./types";

/**
 * Reads and parses all backfill day records from JSONL files in the given directory.
 * @param logDir - Directory containing .backfill.jsonl files
 * @param since - Optional inclusive lower bound for filtering records by date.
 *                Records whose date equals or is after `since` are included.
 * @returns Array of parsed BackfillDayRecord entries, sorted by date
 */
export async function readBackfillDayRecords(
  logDir: string,
  since?: Date,
): Promise<BackfillDayRecord[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(logDir);
  } catch {
    return [];
  }
  const files = entries
    .filter((e) => e.endsWith(".backfill.jsonl"))
    .map((e) => path.join(logDir, e));

  const records: BackfillDayRecord[] = [];
  for (const file of files) {
    records.push(...(await parseBackfillFile(file, since)));
  }
  return records.sort((a, b) => a.date.localeCompare(b.date));
}

async function parseBackfillFile(
  filePath: string,
  since?: Date,
): Promise<BackfillDayRecord[]> {
  const records: BackfillDayRecord[] = [];
  try {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;
        const record = parseDaySummary(event, since);
        if (record) records.push(record);
      } catch {
        // ungültige Zeile überspringen
      }
    }
  } catch {
    // Datei nicht lesbar – ignorieren
  }
  return records;
}

function parseDaySummary(
  event: Record<string, unknown>,
  since?: Date,
): BackfillDayRecord | null {
  if (event.kind !== "tokens.daySummary") return null;
  const provider = event.provider;
  if (provider !== "claude" && provider !== "codex") return null;
  const date = typeof event.date === "string" ? event.date : null;
  if (!date) return null;
  if (since && new Date(`${date}T00:00:00.000Z`) < since) return null;

  const perModelRaw = event.perModel;
  const perModel: Record<string, BackfillPerModelEntry> = {};
  if (perModelRaw && typeof perModelRaw === "object" && !Array.isArray(perModelRaw)) {
    for (const [model, pm] of Object.entries(perModelRaw as Record<string, unknown>)) {
      if (!pm || typeof pm !== "object" || Array.isArray(pm)) continue;
      const p = pm as Record<string, unknown>;
      const inputTokens = num(p.input);
      const outputTokens = num(p.output);
      const cacheCreationTokens = num(p.cacheCreation);
      const cacheReadTokens = num(p.cacheRead ?? p.cachedInput);
      const reasoningOutput = num(p.reasoningOutput);
      const totalTokens = provider === "claude"
        ? inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens
        : inputTokens + outputTokens + reasoningOutput;
      perModel[model] = {
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        totalTokens,
        costUSD: num(p.costUSD),
      };
    }
  }

  return {
    date,
    provider,
    inputTokens: num(event.input),
    outputTokens: num(event.output),
    cacheCreationTokens: num(event.cacheCreation),
    cacheReadTokens: num(event.cacheRead ?? event.cachedInput),
    totalTokens: num(event.totalTokens),
    costUSD: num(event.totalCostUSD),
    sessionCount: num(event.sessionCount),
    models: Array.isArray(event.models) ? (event.models as string[]) : [],
    perModel,
  };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

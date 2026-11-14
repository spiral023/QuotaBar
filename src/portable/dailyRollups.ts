import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { reconcileStoredCost } from "../pricing/stored-cost";
import { isNeutralInternalMarker } from "./eventAdapters";
import { sanitizePortableEvent } from "./usageEventCodec";
import type { PortableUsageEvent } from "./types";

/** Derived data only: never export these rows as canonical usage events. */
export interface DailyUsageRollup {
  day: string;
  firstActivity: string;
  count: number;
  pricing: { inputComplete: boolean; cacheComplete: boolean; inputTokens: number; cacheTokens: number; inputCost: number; cacheCost: number };
  reportEvent: PortableUsageEvent;
  rawEvent: PortableUsageEvent;
}

const REVISION_FILE = "daily-rollups-revision";
const VERSION = 1;
const costKeys = ["inputCostUSD", "outputCostUSD", "cacheCreationCostUSD", "cacheReadCostUSD"] as const;
const tokenKeys = ["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens", "reasoningOutputTokens"] as const;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function atomicWrite(file: string, contents: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

/** Called under the store lock BEFORE append, replacement, removal or recovery. */
export async function invalidateDailyRollups(root: string): Promise<void> {
  const marker = path.join(root, REVISION_FILE);
  try {
    const info = await fs.lstat(marker);
    if (!info.isFile() || info.isSymbolicLink()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  // An invalidation failure must stop the source write: serving stale data is worse.
  await atomicWrite(marker, randomUUID());
}

export function aggregateDaily(events: readonly PortableUsageEvent[], timeZone: string): DailyUsageRollup[] {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const rows = new Map<string, DailyUsageRollup>();
  for (const event of events) {
    if (isNeutralInternalMarker(event)) continue;
    const instant = new Date(event.occurredAt);
    const parts = formatter.formatToParts(instant);
    const part = (name: string) => parts.find((item) => item.type === name)?.value;
    const day = `${part("year")}-${part("month")}-${part("day")}`;
    // Imported ISO timestamps may use offsets. Keep those as individual rows so
    // lexical timestamp ordering cannot corrupt exact instant range boundaries.
    const key = JSON.stringify([day, event.provider, event.model,
      ...(event.occurredAt === instant.toISOString() ? [] : [event.id])]);
    const costs = reconcileStoredCost(event);
    let row = rows.get(key);
    if (!row) {
      const base: PortableUsageEvent = {
        schemaVersion: 1, id: digest(key), sessionKey: digest(key),
        occurredAt: event.occurredAt, provider: event.provider, model: event.model,
        source: event.provider === "claude" ? "claude-log" : "codex-log", synthetic: false,
        inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningOutputTokens: 0,
        costUSD: 0, inputCostUSD: 0, outputCostUSD: 0, cacheCreationCostUSD: 0, cacheReadCostUSD: 0,
      };
      row = { day, firstActivity: event.occurredAt, count: 0,
        pricing: { inputComplete: true, cacheComplete: true, inputTokens: 0, cacheTokens: 0, inputCost: 0, cacheCost: 0 },
        reportEvent: { ...base }, rawEvent: { ...base } };
      rows.set(key, row);
    }
    row.count++;
    if (event.occurredAt < row.firstActivity) row.firstActivity = event.occurredAt;
    for (const target of [row.reportEvent, row.rawEvent]) {
      if (event.occurredAt > target.occurredAt) target.occurredAt = event.occurredAt;
      for (const field of tokenKeys) target[field] += event[field];
    }
    row.reportEvent.costUSD! += costs.costUSD;
    row.rawEvent.costUSD! += event.costUSD ?? costKeys.reduce((sum, field) => sum + (event[field] ?? 0), 0);
    for (const field of costKeys) {
      row.reportEvent[field]! += costs[field];
      row.rawEvent[field]! += event[field] ?? 0;
    }
    if (event.inputTokens > 0) {
      row.pricing.inputComplete &&= event.inputCostUSD !== undefined;
      row.pricing.inputTokens += event.inputTokens;
      row.pricing.inputCost += event.inputCostUSD ?? 0;
    }
    if (event.cacheReadTokens > 0) {
      row.pricing.cacheComplete &&= event.cacheReadCostUSD !== undefined;
      row.pricing.cacheTokens += event.cacheReadTokens;
      row.pricing.cacheCost += event.cacheReadCostUSD ?? 0;
    }
  }
  return [...rows.values()].sort((a, b) => a.firstActivity.localeCompare(b.firstActivity));
}

function validRows(value: unknown): value is DailyUsageRollup[] {
  return Array.isArray(value) && value.every((row: DailyUsageRollup) => row && /^\d{4}-\d{2}-\d{2}$/.test(row.day)
    && Number.isInteger(row.count) && row.count > 0 && Number.isFinite(Date.parse(row.firstActivity))
    && row.pricing && typeof row.pricing.inputComplete === "boolean" && typeof row.pricing.cacheComplete === "boolean"
    && [row.pricing.inputTokens, row.pricing.cacheTokens, row.pricing.inputCost, row.pricing.cacheCost].every((n) => Number.isFinite(n) && n >= 0)
    && sanitizePortableEvent(row.reportEvent).event !== undefined && sanitizePortableEvent(row.rawEvent).event !== undefined);
}

/** Source identities include inode; the durable revision also covers same-stat writes. */
export async function loadDailyRollups(
  root: string, timeZone: string, sourceIdentity: string, readEvents: () => Promise<PortableUsageEvent[]>,
): Promise<DailyUsageRollup[]> {
  new Intl.DateTimeFormat("en", { timeZone }); // Validate before touching the cache.
  const directory = path.join(root, "daily-rollups");
  const cacheFile = path.join(directory, `${digest(timeZone)}.json`);
  let fingerprint: string | undefined;
  try {
    const marker = path.join(root, REVISION_FILE);
    const info = await fs.lstat(marker).catch(() => undefined);
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("Unsafe cache marker");
    const revision = info ? await fs.readFile(marker, "utf8") : randomUUID();
    if (!info) {
      await fs.mkdir(root, { recursive: true });
      await atomicWrite(marker, revision);
    }
    fingerprint = digest(JSON.stringify([VERSION, timeZone, sourceIdentity, revision]));
    const directoryInfo = await fs.lstat(directory).catch(() => undefined);
    if (directoryInfo && (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())) throw new Error("Unsafe cache directory");
    const cacheInfo = await fs.lstat(cacheFile).catch(() => undefined);
    if (cacheInfo?.isFile() && !cacheInfo.isSymbolicLink()) {
      try {
        const cached = JSON.parse(await fs.readFile(cacheFile, "utf8")) as { fingerprint: string; payload: string; checksum: string };
        if (cached.fingerprint === fingerprint && typeof cached.payload === "string" && digest(cached.payload) === cached.checksum) {
          const rows: unknown = JSON.parse(cached.payload);
          if (validRows(rows)) return rows;
        }
      } catch { /* Rebuild malformed cache contents below. */ }
    }
  } catch {
    // Derived files are disposable. Canonical read errors still propagate below.
    fingerprint = undefined;
  }
  const rows = aggregateDaily(await readEvents(), timeZone);
  if (fingerprint !== undefined) {
    try {
      await fs.mkdir(directory, { recursive: true });
      const payload = JSON.stringify(rows);
      await atomicWrite(cacheFile, JSON.stringify({ fingerprint, payload, checksum: digest(payload) }));
    } catch { /* Read-only or full cache storage must not block reports. */ }
  }
  return rows;
}

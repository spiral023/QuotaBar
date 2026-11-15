import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { reconcileStoredCost } from "../pricing/stored-cost";
import { zonedDayKey } from "../shared/zonedDate";
import { isNeutralInternalMarker } from "./eventAdapters";
import type { PortableUsageEvent } from "./types";
import { monthKeyOf, sanitizePortableEvent } from "./usageEventCodec";

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
const VERSION = 3;
interface RollupRevision { epoch: string; partitions: Record<string, string> }
export interface RollupSource { month: string; identity: string }
interface CachedPartition { identity: string; rows: DailyUsageRollup[] }
interface RollupSnapshot { version: number; timeZone: string; revision: RollupRevision; independentPartitions: boolean; partitions: Record<string, CachedPartition> }

function parseRevision(value: unknown): RollupRevision {
  const revision = value as RollupRevision;
  if (!revision || typeof revision.epoch !== "string" || !revision.partitions || typeof revision.partitions !== "object"
    || Array.isArray(revision.partitions) || Object.entries(revision.partitions).some(([month, token]) => !/^\d{4}-\d{2}$/.test(month) || typeof token !== "string")) {
    throw new Error("Invalid rollup generation");
  }
  return revision;
}
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
export async function invalidateDailyRollups(root: string, changedPaths: readonly string[] = []): Promise<void> {
  const marker = path.join(root, REVISION_FILE);
  try {
    const info = await fs.lstat(marker);
    if (!info.isFile() || info.isSymbolicLink()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let revision: RollupRevision;
  try { revision = parseRevision(JSON.parse(await fs.readFile(marker, "utf8"))); }
  catch { revision = { epoch: randomUUID(), partitions: {} }; }
  const months = changedPaths.map((file) => /^(\d{4}-\d{2})\.jsonl$/.exec(path.basename(file))?.[1]).filter((month): month is string => Boolean(month));
  if (months.length === 0) revision.epoch = randomUUID();
  for (const month of months) revision.partitions[month] = randomUUID();
  // Persist before source writes, including same-stat mutations and crash recovery.
  await atomicWrite(marker, JSON.stringify(revision));
}

export function aggregateDaily(events: readonly PortableUsageEvent[], timeZone: string): DailyUsageRollup[] {
  new Intl.DateTimeFormat("en", { timeZone });
  const rows = new Map<string, DailyUsageRollup>();
  for (const event of events) {
    if (isNeutralInternalMarker(event)) continue;
    const instant = new Date(event.occurredAt);
    const day = zonedDayKey(instant, timeZone);
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

/** Restrict a snapshot to exact instants without mixing independent offset rows. */
export async function selectDailyRollups(
  rows: readonly DailyUsageRollup[], timeZone: string, bounds: { since?: number; until?: number },
  readRange: (range: { since: string; until: string }) => Promise<PortableUsageEvent[]>,
): Promise<DailyUsageRollup[]> {
  const result: DailyUsageRollup[] = [];
  for (const row of rows) {
    const first = Date.parse(row.firstActivity), last = Date.parse(row.reportEvent.occurredAt);
    if ((bounds.since !== undefined && last < bounds.since) || (bounds.until !== undefined && first > bounds.until)) continue;
    if ((bounds.since === undefined || first >= bounds.since) && (bounds.until === undefined || last <= bounds.until)) result.push(row);
    else {
      const events = await readRange({
        since: new Date(Math.max(first, bounds.since ?? first)).toISOString(),
        until: new Date(Math.min(last, bounds.until ?? last)).toISOString(),
      });
      const groups = aggregateDaily(events.filter((event) => event.provider === row.reportEvent.provider && event.model === row.reportEvent.model), timeZone);
      result.push(...groups.filter((group) => group.reportEvent.id === row.reportEvent.id));
    }
  }
  return result.sort((a, b) => a.firstActivity.localeCompare(b.firstActivity));
}

/** Merge UTC partitions that contribute to the same local day/provider/model. */
function mergePartitions(partitions: Record<string, CachedPartition>): DailyUsageRollup[] {
  const merged = new Map<string, DailyUsageRollup>();
  for (const month of Object.keys(partitions).sort()) {
    for (const row of partitions[month].rows) {
      const prior = merged.get(row.reportEvent.id);
      if (!prior) {
        merged.set(row.reportEvent.id, { ...row, pricing: { ...row.pricing }, reportEvent: { ...row.reportEvent }, rawEvent: { ...row.rawEvent } });
        continue;
      }
      prior.count += row.count;
      if (row.firstActivity < prior.firstActivity) prior.firstActivity = row.firstActivity;
      for (const field of ["inputTokens", "cacheTokens", "inputCost", "cacheCost"] as const) prior.pricing[field] += row.pricing[field];
      prior.pricing.inputComplete &&= row.pricing.inputComplete;
      prior.pricing.cacheComplete &&= row.pricing.cacheComplete;
      for (const field of ["reportEvent", "rawEvent"] as const) {
        const target = prior[field], source = row[field];
        if (source.occurredAt > target.occurredAt) target.occurredAt = source.occurredAt;
        for (const key of tokenKeys) target[key] += source[key];
        for (const key of ["costUSD", ...costKeys] as const) target[key]! += source[key]!;
      }
    }
  }
  return [...merged.values()].sort((a, b) => a.firstActivity.localeCompare(b.firstActivity));
}

function parseSnapshot(value: unknown, timeZone: string): RollupSnapshot {
  const snapshot = value as RollupSnapshot;
  if (!snapshot || snapshot.version !== VERSION || snapshot.timeZone !== timeZone || typeof snapshot.independentPartitions !== "boolean" || !snapshot.partitions
    || typeof snapshot.partitions !== "object" || Array.isArray(snapshot.partitions)) throw new Error("Invalid rollup snapshot");
  parseRevision(snapshot.revision);
  for (const [month, part] of Object.entries(snapshot.partitions)) {
    if (!/^\d{4}-\d{2}$/.test(month) || !part || typeof part.identity !== "string" || !validRows(part.rows)) throw new Error("Invalid rollup partition");
  }
  return snapshot;
}

/** Reuse only mutations tracked by the writer; external changes require global deduplication. */
export async function loadDailyRollups(
  root: string, timeZone: string, sources: readonly RollupSource[],
  readEvents: () => Promise<{ events: PortableUsageEvent[]; independentPartitions: boolean }>, readPartition: (month: string) => Promise<PortableUsageEvent[]>,
): Promise<DailyUsageRollup[]> {
  new Intl.DateTimeFormat("en", { timeZone });
  const directory = path.join(root, "daily-rollups");
  const cacheFile = path.join(directory, `${digest(timeZone)}.json`);
  let revision: RollupRevision | undefined;
  let previous: RollupSnapshot | undefined;
  try {
    const marker = path.join(root, REVISION_FILE);
    const info = await fs.lstat(marker).catch(() => undefined);
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("Unsafe cache marker");
    try { revision = info ? parseRevision(JSON.parse(await fs.readFile(marker, "utf8"))) : undefined; }
    catch { /* Upgrade old markers with a new global generation. */ }
    if (!revision) {
      revision = { epoch: randomUUID(), partitions: {} };
      await fs.mkdir(root, { recursive: true });
      await atomicWrite(marker, JSON.stringify(revision));
    }
    const dirInfo = await fs.lstat(directory).catch(() => undefined);
    if (dirInfo && (!dirInfo.isDirectory() || dirInfo.isSymbolicLink())) throw new Error("Unsafe cache directory");
    const cacheInfo = await fs.lstat(cacheFile).catch(() => undefined);
    if (cacheInfo?.isFile() && !cacheInfo.isSymbolicLink()) {
      try {
        const cached = JSON.parse(await fs.readFile(cacheFile, "utf8")) as { payload: string; checksum: string };
        if (typeof cached.payload === "string" && digest(cached.payload) === cached.checksum) previous = parseSnapshot(JSON.parse(cached.payload), timeZone);
      } catch { /* Corrupt derived data is rebuilt from canonical events. */ }
    }
  } catch { revision = undefined; }
  const identities = new Map(sources.map((source) => [source.month, source.identity]));
  const months = new Set([...identities.keys(), ...Object.keys(previous?.partitions ?? {})]);
  const unchanged = previous && revision && [...months].every((month) => previous.partitions[month]?.identity === identities.get(month)
    && previous.revision.partitions[month] === revision.partitions[month]);
  const canReuse = revision && previous && previous.revision.epoch === revision.epoch
    && (previous.independentPartitions || unchanged)
    && [...months].every((month) => previous.partitions[month]?.identity === identities.get(month)
      || previous.revision.partitions[month] !== revision.partitions[month]);
  const partitions: Record<string, CachedPartition> = {};
  let independentPartitions = previous?.independentPartitions ?? true;
  if (canReuse && previous && revision) {
    let changed = false;
    for (const { month, identity } of sources) {
      const old = previous.partitions[month];
      if (old && old.identity === identity && previous.revision.partitions[month] === revision.partitions[month]) partitions[month] = old;
      else { partitions[month] = { identity, rows: aggregateDaily(await readPartition(month), timeZone) }; changed = true; }
    }
    if (!changed && sources.length === Object.keys(previous.partitions).length) return mergePartitions(partitions);
  } else {
    // Full reads preserve global ID deduplication even after external edits.
    const byMonth = new Map<string, PortableUsageEvent[]>();
    const canonical = await readEvents();
    independentPartitions = canonical.independentPartitions;
    for (const event of canonical.events) {
      const month = monthKeyOf(event.occurredAt);
      const group = byMonth.get(month) ?? [];
      group.push(event); byMonth.set(month, group);
    }
    for (const { month, identity } of sources) partitions[month] = { identity, rows: aggregateDaily(byMonth.get(month) ?? [], timeZone) };
  }
  const rows = mergePartitions(partitions);
  if (revision) {
    try {
      await fs.mkdir(directory, { recursive: true });
      const payload = JSON.stringify({ version: VERSION, timeZone, revision, independentPartitions, partitions });
      await atomicWrite(cacheFile, JSON.stringify({ payload, checksum: digest(payload) }));
    } catch { /* Cache storage must not block canonical reports. */ }
  }
  return rows;
}

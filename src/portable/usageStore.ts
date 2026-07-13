import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPortableUsageDir } from "../config/paths";
import {
  PORTABLE_STORE_VERSION,
  type PortableStoreMetadata,
  type PortableUsageEvent,
} from "./types";

const PARTITION_FILE = /^(\d{4}-\d{2})\.jsonl$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
  "reasoningOutputTokens",
] as const;
const COST_FIELDS = [
  "costUSD",
  "inputCostUSD",
  "outputCostUSD",
  "cacheCreationCostUSD",
  "cacheReadCostUSD",
] as const;

type Range = { since?: string; until?: string };

export class PortableUsageStore {
  constructor(private readonly rootDir = getPortableUsageDir()) {}

  async read(range: Range = {}): Promise<PortableUsageEvent[]> {
    const bounds = parseRange(range);
    const partitions = await this.listPartitions();
    const firstMonth = bounds.since === undefined ? undefined : monthKey(new Date(bounds.since));
    const lastMonth = bounds.until === undefined ? undefined : monthKey(new Date(bounds.until));
    const relevant = partitions.filter(
      ({ month }) => (!firstMonth || month >= firstMonth) && (!lastMonth || month <= lastMonth),
    );

    const events: PortableUsageEvent[] = [];
    for (const { filePath } of relevant) {
      events.push(...(await readValidEvents(filePath)).values());
    }

    return events
      .filter((item) => {
        const occurredAt = Date.parse(item.occurredAt);
        return (bounds.since === undefined || occurredAt >= bounds.since)
          && (bounds.until === undefined || occurredAt <= bounds.until);
      })
      .sort(compareEvents);
  }

  async upsert(events: readonly PortableUsageEvent[]): Promise<{ inserted: number; existing: number }> {
    for (const item of events) {
      const problem = eventValidationProblem(item);
      if (problem) throw new Error(`Invalid portable usage event: ${problem}`);
    }

    const byMonth = new Map<string, PortableUsageEvent[]>();
    for (const item of events) {
      const month = monthKey(new Date(item.occurredAt));
      const monthEvents = byMonth.get(month) ?? [];
      monthEvents.push(item);
      byMonth.set(month, monthEvents);
    }

    let inserted = 0;
    let existing = 0;
    const eventsDir = path.join(this.rootDir, "events");
    for (const month of [...byMonth.keys()].sort()) {
      const target = path.join(eventsDir, `${month}.jsonl`);
      const stored = await readValidEvents(target);
      for (const item of byMonth.get(month) ?? []) {
        if (stored.has(item.id)) {
          existing += 1;
        } else {
          stored.set(item.id, item);
          inserted += 1;
        }
      }
      const output = [...stored.values()]
        .sort(compareEvents)
        .map((item) => JSON.stringify(item))
        .join("\n");
      await atomicWrite(target, `${output}\n`);
    }

    await this.rebuildMetadata();
    return { inserted, existing };
  }

  async rebuildMetadata(): Promise<PortableStoreMetadata> {
    const partitions: PortableStoreMetadata["partitions"] = {};
    for (const { month, filePath } of await this.listPartitions()) {
      const events = [...(await readValidEvents(filePath)).values()].sort(compareEvents);
      if (events.length === 0) continue;
      partitions[month] = {
        eventCount: events.length,
        firstAt: events[0].occurredAt,
        lastAt: events[events.length - 1].occurredAt,
      };
    }

    const metadata: PortableStoreMetadata = {
      schemaVersion: PORTABLE_STORE_VERSION,
      partitions,
      updatedAt: new Date().toISOString(),
    };
    await atomicWrite(path.join(this.rootDir, "store-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    return metadata;
  }

  private async listPartitions(): Promise<Array<{ month: string; filePath: string }>> {
    const eventsDir = path.join(this.rootDir, "events");
    let names: string[];
    try {
      names = await readdir(eventsDir);
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    return names
      .map((name) => ({ name, match: PARTITION_FILE.exec(name) }))
      .filter((item): item is { name: string; match: RegExpExecArray } => item.match !== null)
      .map(({ name, match }) => ({ month: match[1], filePath: path.join(eventsDir, name) }))
      .filter(({ month }) => isValidMonth(month))
      .sort((a, b) => a.month.localeCompare(b.month));
  }
}

async function readValidEvents(filePath: string): Promise<Map<string, PortableUsageEvent>> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return new Map();
    throw error;
  }

  const events = new Map<string, PortableUsageEvent>();
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!eventValidationProblem(parsed)) {
        const valid = parsed as PortableUsageEvent;
        events.set(valid.id, valid);
      }
    } catch {
      // A damaged line must not hide valid records in the same partition.
    }
  }
  return events;
}

async function atomicWrite(target: string, contents: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if (!isMissingFile(cleanupError)) throw cleanupError;
    }
    throw error;
  }
}

function eventValidationProblem(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return "expected an object";
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== PORTABLE_STORE_VERSION) return "schemaVersion must be 1";
  if (item.provider !== "claude" && item.provider !== "codex") return "provider is not supported";
  if (!isNonEmptyString(item.id)) return "id must be a non-empty string";
  if (!isIsoTimestamp(item.occurredAt)) return "occurredAt must be an ISO timestamp";
  if (!isNonEmptyString(item.model)) return "model must be a non-empty string";
  if (!isNonEmptyString(item.sessionKey)) return "sessionKey must be a non-empty string";
  if (item.source !== "claude-log" && item.source !== "codex-log" && item.source !== "legacy-reconciliation") {
    return "source is not supported";
  }
  if (typeof item.synthetic !== "boolean") return "synthetic must be a boolean";
  for (const field of TOKEN_FIELDS) {
    if (!isNonNegativeFiniteNumber(item[field])) return `${field} must be finite and non-negative`;
  }
  for (const field of COST_FIELDS) {
    if (item[field] !== undefined && !isNonNegativeFiniteNumber(item[field])) {
      return `${field} must be finite and non-negative`;
    }
  }
  if (item.projectName !== undefined && typeof item.projectName !== "string") return "projectName must be a string";
  if (item.pricingVersion !== undefined && !isNonEmptyString(item.pricingVersion)) {
    return "pricingVersion must be a non-empty string";
  }
  return undefined;
}

function parseRange(range: Range): { since?: number; until?: number } {
  const since = range.since === undefined ? undefined : parseBoundary(range.since, false);
  const until = range.until === undefined ? undefined : parseBoundary(range.until, true);
  if (since === null || until === null) throw new Error("Invalid portable usage range");
  if (since !== undefined && until !== undefined && since > until) {
    throw new Error("Invalid portable usage range: since is after until");
  }
  return { since, until };
}

function parseBoundary(value: string, endOfDay: boolean): number | null {
  if (DATE_ONLY.test(value)) {
    const timestamp = `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`;
    return isIsoTimestamp(timestamp) ? Date.parse(timestamp) : null;
  }
  return isIsoTimestamp(value) ? Date.parse(value) : null;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_TIMESTAMP.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  return month >= 1 && month <= 12
    && day >= 1 && day <= daysInMonth(year, month)
    && hour <= 23
    && minute <= 59
    && second <= 59
    && offsetHour <= 23
    && offsetMinute <= 59;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isValidMonth(month: string): boolean {
  const monthNumber = Number(month.slice(5));
  return monthNumber >= 1 && monthNumber <= 12;
}

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function compareEvents(left: PortableUsageEvent, right: PortableUsageEvent): number {
  return Date.parse(left.occurredAt) - Date.parse(right.occurredAt) || left.id.localeCompare(right.id);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

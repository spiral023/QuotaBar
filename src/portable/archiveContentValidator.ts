import { sanitizeImportedSettings } from "./archiveManifest";
import { parseMigrationState } from "./migration";
import { validateQuotaSnapshotForArchive } from "./quotaStore";
import type { PortableStoreMetadata } from "./types";
import { PORTABLE_STORE_VERSION } from "./types";
import { validatePortableEventForArchive } from "./usageStore";
import { isWindowHistoryFile } from "../usage/windowHistoryStore";
import { isWindowRatioFile } from "../usage/windowRatioStore";
import { migrateBonusStateFile } from "../usage/bonusStateStore";

export interface PortableContentFile {
  path: string;
  data: Uint8Array;
}

const USAGE_PARTITION = /^usage\/events\/(\d{4}-\d{2})\.jsonl$/;
const QUOTA_PARTITION = /^quota\/snapshots\/(\d{4}-\d{2})\.jsonl$/;

/** Validates every portable payload without mutating either source or destination. */
export function validatePortableArchiveContents(files: readonly PortableContentFile[]): void {
  const validator = new PortableArchiveContentValidator();
  for (const file of files) validator.add(file);
  validator.finish();
}

interface UsageAggregate {
  eventCount: number;
  firstAt: string;
  lastAt: string;
}

/** Incremental validator retaining only IDs and bounded per-partition aggregates. */
export class PortableArchiveContentValidator {
  private readonly usageByMonth = new Map<string, UsageAggregate>();
  private readonly eventIds = new Set<string>();
  private metadata: PortableStoreMetadata | undefined;

  add(file: PortableContentFile): void {
    try {
      const usage = USAGE_PARTITION.exec(file.path);
      if (usage) {
        if (this.usageByMonth.has(usage[1])) fail();
        let aggregate: UsageAggregate | undefined;
        forEachJsonLine(file.data, (value) => {
          const event = validatePortableEventForArchive(value);
          if (event.occurredAt.slice(0, 7) !== usage[1] || this.eventIds.has(event.id)) fail();
          this.eventIds.add(event.id);
          aggregate = aggregate
            ? {
              eventCount: aggregate.eventCount + 1,
              firstAt: event.occurredAt < aggregate.firstAt ? event.occurredAt : aggregate.firstAt,
              lastAt: event.occurredAt > aggregate.lastAt ? event.occurredAt : aggregate.lastAt,
            }
            : { eventCount: 1, firstAt: event.occurredAt, lastAt: event.occurredAt };
        });
        if (!aggregate) fail();
        this.usageByMonth.set(usage[1], aggregate);
        return;
      }
      const quota = QUOTA_PARTITION.exec(file.path);
      if (quota) {
        forEachJsonLine(file.data, (value) => {
          const snapshot = validateQuotaSnapshotForArchive(value);
          if (snapshot.fetchedAt.slice(0, 7) !== quota[1]) fail();
        });
        return;
      }
      switch (file.path) {
        case "usage/store-metadata.json":
          if (this.metadata) fail();
          this.metadata = parseStoreMetadata(parseJson(file.data));
          break;
        case "usage/migration-state.json": {
          const parsed = parseMigrationState(parseJson(file.data));
          if (!parsed.state || parsed.rewriteRequired) fail();
          break;
        }
        case "settings.json": {
          const value = parseJson(file.data);
          if (!isRecord(value)) fail();
          const sanitized = sanitizeImportedSettings(value, "");
          if (canonicalJson(value) !== canonicalJson(sanitized)) fail();
          break;
        }
        case "window-history.json":
          if (!isWindowHistoryFile(parseJson(file.data))) fail();
          break;
        case "window-ratio.json":
          if (!isWindowRatioFile(parseJson(file.data))) fail();
          break;
        case "bonus-state.json":
          if (!migrateBonusStateFile(parseJson(file.data))) fail();
          break;
        case "notification-state.json":
          validateNotificationState(parseJson(file.data));
          break;
        case "notifications.log":
          forEachJsonLine(file.data, validateNotificationLogEntry);
          break;
        default:
          fail();
      }
    } catch {
      fail();
    }
  }

  finish(): void {
    try {
      if (this.usageByMonth.size > 0) {
        if (this.metadata) {
          if (Object.keys(this.metadata.partitions).length !== this.usageByMonth.size) fail();
          for (const [month, aggregate] of this.usageByMonth) {
            const expected = this.metadata.partitions[month];
            if (!expected || expected.eventCount !== aggregate.eventCount
              || expected.firstAt !== aggregate.firstAt || expected.lastAt !== aggregate.lastAt) fail();
          }
        }
      } else if (this.metadata && Object.keys(this.metadata.partitions).length > 0) {
        fail();
      }
    } catch {
      fail();
    }
  }
}

function parseStoreMetadata(value: unknown): PortableStoreMetadata {
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "partitions", "updatedAt"])
    || value.schemaVersion !== PORTABLE_STORE_VERSION || !isIso(value.updatedAt) || !isRecord(value.partitions)) fail();
  const partitions: PortableStoreMetadata["partitions"] = {};
  for (const [month, raw] of Object.entries(value.partitions)) {
    if (!validMonth(month) || !isRecord(raw) || !hasExactKeys(raw, ["eventCount", "firstAt", "lastAt"])
      || !Number.isSafeInteger(raw.eventCount) || (raw.eventCount as number) < 1
      || !isIso(raw.firstAt) || !isIso(raw.lastAt)
      || (raw.firstAt as string).slice(0, 7) !== month || (raw.lastAt as string).slice(0, 7) !== month
      || (raw.firstAt as string) > (raw.lastAt as string)) fail();
    partitions[month] = raw as unknown as PortableStoreMetadata["partitions"][string];
  }
  return { schemaVersion: PORTABLE_STORE_VERSION, partitions, updatedAt: value.updatedAt };
}

function validateNotificationState(value: unknown): void {
  if (!isRecord(value) || Object.keys(value).some((key) => ![
    "lastFired", "lastGlobalFiredAt", "lastPercent", "lastResetsAt", "lastPaceStage", "dismissedUpdateVersion",
  ].includes(key)) || !isRecord(value.lastFired) || !isFiniteNumber(value.lastGlobalFiredAt)) fail();
  for (const entry of Object.values(value.lastFired)) if (!isFiniteNumber(entry)) fail();
  if (value.lastPercent !== undefined && (!isRecord(value.lastPercent)
    || Object.values(value.lastPercent).some((entry) => !isFiniteNumber(entry)))) fail();
  if (value.lastResetsAt !== undefined && (!isRecord(value.lastResetsAt)
    || Object.values(value.lastResetsAt).some((entry) => typeof entry !== "string"))) fail();
  if (value.lastPaceStage !== undefined && (!isRecord(value.lastPaceStage)
    || Object.values(value.lastPaceStage).some((entry) => ![
      "onTrack", "slightlyAhead", "ahead", "farAhead", "slightlyBehind", "behind", "farBehind",
    ].includes(String(entry))))) fail();
  if (value.dismissedUpdateVersion !== undefined
    && value.dismissedUpdateVersion !== null && typeof value.dismissedUpdateVersion !== "string") fail();
}

function validateNotificationLogEntry(value: unknown): unknown {
  if (!isRecord(value)) fail();
  return value;
}

function forEachJsonLine(bytes: Uint8Array, visit: (value: unknown) => unknown): void {
  const text = decodeUtf8(bytes);
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    visit(parseJsonText(line));
  }
}

function parseJson(bytes: Uint8Array): unknown {
  return parseJsonText(decodeUtf8(bytes));
}

function parseJsonText(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return fail(); }
}

function decodeUtf8(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return fail(); }
}

function validMonth(value: string): boolean {
  const date = new Date(`${value}-01T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 7) === value;
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return keys.length === canonical.length && keys.every((key, index) => key === canonical[index]);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fail(): never {
  throw new Error("Invalid portable archive contents");
}

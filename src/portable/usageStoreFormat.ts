import { createHash } from "node:crypto";
import path from "node:path";
import {
  PORTABLE_STORE_VERSION,
  type PortableStoreMetadata,
  type PortableUsageEvent
} from "./types";
import {
  canonicalSerialize,
  compareCanonicalEvents,
  compareText,
  isIsoTimestamp,
  isNonEmptyString
} from "./usageEventCodec";

export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const TEMP_FILE = /^(?:store-metadata\.json|ingest-state\.json|pending-store-transaction\.json|\d{4}-\d{2}\.jsonl)\.\d+\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;

export type Range = { since?: string; until?: string };

export interface PartitionFile {
  month: string;
  filePath: string;
}

export interface PartitionSnapshot extends PartitionFile {
  events: readonly PortableUsageEvent[];
}

export interface TransactionEntry {
  target: string;
  temporary: string;
  sha256: string;
}

export interface PendingTransaction {
  schemaVersion: 1;
  transactionId: string;
  entries: TransactionEntry[];
  remove: string[];
}

export interface RepairCandidate {
  event: PortableUsageEvent;
  canonical: boolean;
}

export function snapshotsToMaps(snapshots: readonly PartitionSnapshot[]): Map<string, Map<string, PortableUsageEvent>> {
  const result = new Map<string, Map<string, PortableUsageEvent>>();
  for (const snapshot of snapshots) {
    const partition = new Map<string, PortableUsageEvent>();
    for (const item of [...snapshot.events].sort(compareCanonicalEvents)) {
      if (!partition.has(item.id)) partition.set(item.id, item);
    }
    result.set(snapshot.month, partition);
  }
  return result;
}

export function deduplicateGlobally(events: readonly PortableUsageEvent[]): PortableUsageEvent[] {
  const unique = new Map<string, PortableUsageEvent>();
  for (const item of [...events].sort(compareCanonicalEvents)) {
    if (!unique.has(item.id)) unique.set(item.id, item);
  }
  return [...unique.values()].sort(compareCanonicalEvents);
}

export function deduplicateRepairCandidates(candidates: readonly RepairCandidate[]): PortableUsageEvent[] {
  const chosen = new Map<string, RepairCandidate>();
  for (const candidate of candidates) {
    const current = chosen.get(candidate.event.id);
    if (!current || compareRepairCandidates(candidate, current) < 0) chosen.set(candidate.event.id, candidate);
  }
  return [...chosen.values()].map(({ event }) => event).sort(compareCanonicalEvents);
}

export function compareRepairCandidates(left: RepairCandidate, right: RepairCandidate): number {
  if (left.canonical !== right.canonical) return left.canonical ? -1 : 1;
  return compareCanonicalEvents(left.event, right.event);
}

export function buildMetadata(partitions: ReadonlyMap<string, ReadonlyMap<string, PortableUsageEvent>>): PortableStoreMetadata {
  const metadata: PortableStoreMetadata = {
    schemaVersion: PORTABLE_STORE_VERSION,
    partitions: {},
    updatedAt: new Date().toISOString(),
  };
  for (const [month, partition] of [...partitions].sort(([a], [b]) => a.localeCompare(b))) {
    const events = [...partition.values()].sort(compareCanonicalEvents);
    if (events.length === 0) continue;
    metadata.partitions[month] = {
      eventCount: events.length,
      firstAt: events[0].occurredAt,
      lastAt: events[events.length - 1].occurredAt,
    };
  }
  return metadata;
}

export function partitionCanonical(month: string, events: readonly PortableUsageEvent[]): string {
  const partition = new Map<string, PortableUsageEvent>();
  for (const item of [...events].sort(compareCanonicalEvents)) {
    if (!partition.has(item.id)) partition.set(item.id, item);
  }
  return JSON.stringify([month, [...partition.values()].sort(compareCanonicalEvents).map(canonicalSerialize)]);
}

export function storeRevision(partitions: ReadonlyMap<string, ReadonlyMap<string, PortableUsageEvent>>): string {
  const canonical = [...partitions]
    .sort(([left], [right]) => compareText(left, right))
    .map(([month, events]) => [
      month,
      [...events.values()].sort(compareCanonicalEvents).map(canonicalSerialize),
    ]);
  return sha256(JSON.stringify([PORTABLE_STORE_VERSION, canonical]));
}

export function serializeEvents(events: Iterable<PortableUsageEvent>): string {
  const lines = [...events].sort(compareCanonicalEvents).map((item) => canonicalSerialize(item));
  return `${lines.join("\n")}\n`;
}

export function parseTransaction(value: unknown): PendingTransaction {
  if (!value || typeof value !== "object") throw new Error("invalid transaction");
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== 1 || !isUuid(item.transactionId)
    || !Array.isArray(item.entries) || !Array.isArray(item.remove)) {
    throw new Error("invalid transaction");
  }
  const entries = item.entries.map((entry): TransactionEntry => {
    if (!entry || typeof entry !== "object") throw new Error("invalid transaction entry");
    const fields = entry as Record<string, unknown>;
    if (!isNonEmptyString(fields.target) || !isNonEmptyString(fields.temporary)
      || typeof fields.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(fields.sha256)) {
      throw new Error("invalid transaction entry");
    }
    return { target: fields.target, temporary: fields.temporary, sha256: fields.sha256 };
  });
  if (!item.remove.every((entry): entry is string => isNonEmptyString(entry))) {
    throw new Error("invalid transaction removal");
  }
  return { schemaVersion: 1, transactionId: item.transactionId, entries, remove: [...item.remove] };
}

export function isRecognizedSiblingTemp(target: string, temporary: string): boolean {
  const prefix = `${path.basename(target)}.`;
  return path.basename(temporary).startsWith(prefix) && TEMP_FILE.test(path.basename(temporary));
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function parseRange(range: Range): { since?: number; until?: number } {
  const since = range.since === undefined ? undefined : parseBoundary(range.since, false);
  const until = range.until === undefined ? undefined : parseBoundary(range.until, true);
  if (since === null || until === null) throw new Error("Invalid portable usage range");
  if (since !== undefined && until !== undefined && since > until) {
    throw new Error("Invalid portable usage range: since is after until");
  }
  return { since, until };
}

export function parseBoundary(value: string, endOfDay: boolean): number | null {
  if (DATE_ONLY.test(value)) {
    const timestamp = `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`;
    return isIsoTimestamp(timestamp) ? Date.parse(timestamp) : null;
  }
  return isIsoTimestamp(value) ? Date.parse(value) : null;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}


import path from "node:path";
import {
  PORTABLE_STORE_VERSION,
  type PortableIngestState,
  type PortableProvider,
} from "./types";

export interface CurrentIngestSourceState {
  provider: PortableProvider;
  path: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  processedAt: string;
  eventIds: string[];
  active: boolean;
}

export interface ParsedPortableIngestState {
  state: PortableIngestState;
  migrated: boolean;
}

export function sanitizePortableIngestState(value: unknown): PortableIngestState {
  // The two exact v1 legacy records remain part of the supported migration boundary.
  const parsed = parseState(value);
  return parsed.state;
}

export function parsePortableIngestStateForLoad(value: unknown): ParsedPortableIngestState {
  return parseState(value);
}

/**
 * Validated records are remembered per object. The guard itself is O(eventIds)
 * because it regex-checks every ID, and it is called inside loops that walk all
 * known sources — on a store with thousands of sources that dominated ingestion
 * time. Source records are always replaced wholesale, never mutated in place, so
 * a result stays valid for the lifetime of the object.
 */
const validatedSourceRecords = new WeakSet<object>();

export function isCurrentIngestSourceState(
  value: PortableIngestState["sources"][string] | undefined,
): value is CurrentIngestSourceState {
  if (!value || typeof value !== "object") return false;
  if (validatedSourceRecords.has(value)) return true;
  if (!isCurrentSourceRecord(value as unknown as Record<string, unknown>)) return false;
  validatedSourceRecords.add(value);
  return true;
}

export function portableIngestSourceKey(provider: PortableProvider, sourcePath: string): string {
  return `${provider}:${canonicalPath(sourcePath)}`;
}

/**
 * The ingest state lists every source with all of its event IDs and runs to
 * megabytes, yet a pass usually changes one or two sources. Rewriting the whole
 * file every pass was the dominant write load, so passes append their changed
 * records to this journal instead and the snapshot is only rewritten when the
 * journal outgrows it.
 *
 * Losing the journal, or any suffix of it, is always safe: events are committed
 * before the journal line that records them, so a shorter journal only claims
 * fewer sources as processed and the next pass re-reads them into "existing".
 */
export const PORTABLE_INGEST_JOURNAL_FILE = "ingest-state.journal.jsonl";
const JOURNAL_FORMAT = 1;

/**
 * Binds a journal to the exact snapshot it extends. A snapshot rewritten by
 * anything else (an import, an older app version) no longer matches, and the
 * journal is ignored instead of replaying stale records onto foreign state.
 */
export interface PortableIngestJournalBase {
  size: string;
  mtimeNs: string;
  sha256: string;
}

/** Changed source records by key; null removes the key. */
export type PortableIngestStateDelta = Record<string, CurrentIngestSourceState | null>;

export interface AppliedPortableIngestJournal {
  state: PortableIngestState;
  /** False when the journal is missing, stale or damaged; the next write must start a new one. */
  usable: boolean;
  /** True when records after the header had to be skipped; the next write should compact. */
  damaged: boolean;
}

export function serializePortableIngestJournalHeader(base: PortableIngestJournalBase): string {
  if (!isJournalBase(base)) throw new Error("invalid journal base");
  return `${JSON.stringify({
    journal: JOURNAL_FORMAT,
    base: { size: base.size, mtimeNs: base.mtimeNs, sha256: base.sha256 },
  })}\n`;
}

export function serializePortableIngestJournalEntry(delta: unknown): string {
  return `${JSON.stringify({ sources: parseDelta(delta) })}\n`;
}

/** Replays a journal onto its snapshot, stopping at the first line it cannot trust. */
export function applyPortableIngestJournal(
  snapshot: PortableIngestState,
  base: PortableIngestJournalBase,
  text: string,
): AppliedPortableIngestJournal {
  const lines = text.split("\n");
  let header: unknown;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return { state: snapshot, usable: false, damaged: false };
  }
  if (!isJournalHeader(header) || !sameBase(header.base, base)) {
    return { state: snapshot, usable: false, damaged: false };
  }

  const sources: PortableIngestState["sources"] = { ...snapshot.sources };
  // The final element is whatever follows the last newline: empty for a clean
  // journal, a torn line after an interrupted append otherwise. A torn line is
  // never applied, and appending after it would glue the next record onto it.
  let damaged = lines[lines.length - 1] !== "";
  for (let index = 1; index < lines.length - 1; index += 1) {
    const line = lines[index];
    let delta: PortableIngestStateDelta;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
        || !hasExactKeys(parsed as Record<string, unknown>, ["sources"])) throw new Error("invalid line");
      delta = parseDelta((parsed as { sources: unknown }).sources);
    } catch {
      damaged = true;
      break;
    }
    for (const [key, record] of Object.entries(delta)) {
      if (record === null) delete sources[key];
      else sources[key] = record;
    }
  }
  // A damaged journal is still applied up to the damage, but it must be rewritten
  // before anything is appended to it again.
  return { state: { ...snapshot, sources }, usable: !damaged, damaged };
}

function parseDelta(value: unknown): PortableIngestStateDelta {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid delta");
  const delta: PortableIngestStateDelta = {};
  for (const [key, record] of Object.entries(value as Record<string, unknown>)) {
    if (record === null) {
      delta[key] = null;
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)
      || !isCurrentSourceRecord(record as Record<string, unknown>)) throw new Error("invalid delta source");
    const current = record as CurrentIngestSourceState;
    if (key !== portableIngestSourceKey(current.provider, current.path)) throw new Error("invalid delta key");
    delta[key] = {
      provider: current.provider,
      path: current.path,
      size: current.size,
      mtimeNs: current.mtimeNs,
      ctimeNs: current.ctimeNs,
      processedAt: current.processedAt,
      eventIds: uniqueSorted(current.eventIds),
      active: current.active,
    };
  }
  return delta;
}

function isJournalHeader(value: unknown): value is { journal: number; base: PortableIngestJournalBase } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return hasExactKeys(fields, ["journal", "base"]) && fields.journal === JOURNAL_FORMAT && isJournalBase(fields.base);
}

function isJournalBase(value: unknown): value is PortableIngestJournalBase {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return hasExactKeys(fields, ["size", "mtimeNs", "sha256"])
    && isDecimal(fields.size) && isDecimal(fields.mtimeNs)
    && typeof fields.sha256 === "string" && /^[a-f0-9]{64}$/.test(fields.sha256);
}

function sameBase(left: PortableIngestJournalBase, right: PortableIngestJournalBase): boolean {
  return left.size === right.size && left.mtimeNs === right.mtimeNs && left.sha256 === right.sha256;
}

function parseState(value: unknown): ParsedPortableIngestState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid state");
  const fields = value as Record<string, unknown>;
  const stateKeys = fields.costEnrichmentVersion === undefined
    ? ["schemaVersion", "sources"]
    : ["schemaVersion", "costEnrichmentVersion", "sources"];
  if (!hasExactKeys(fields, stateKeys)
    || fields.schemaVersion !== PORTABLE_STORE_VERSION
    || (fields.costEnrichmentVersion !== undefined
      && (!Number.isSafeInteger(fields.costEnrichmentVersion) || (fields.costEnrichmentVersion as number) < 1))
    || !fields.sources || typeof fields.sources !== "object" || Array.isArray(fields.sources)) {
    throw new Error("invalid state");
  }

  const sources: PortableIngestState["sources"] = {};
  let migrated = false;
  for (const [key, sourceValue] of Object.entries(fields.sources as Record<string, unknown>)) {
    if (!sourceValue || typeof sourceValue !== "object" || Array.isArray(sourceValue)) {
      throw new Error("invalid source");
    }
    const source = sourceValue as Record<string, unknown>;
    if (isSimpleLegacySource(source)) {
      migrated = true;
      sources[key] = { size: source.size, mtimeMs: source.mtimeMs, processedAt: source.processedAt };
      continue;
    }
    if (isOwnedLegacySource(source)) {
      migrated = true;
      sources[key] = {
        provider: source.provider,
        path: source.path,
        size: source.size,
        mtimeMs: source.mtimeMs,
        processedAt: source.processedAt,
        eventIds: uniqueSorted(source.eventIds),
        active: source.active,
      };
      continue;
    }
    if (!isCurrentSourceRecord(source)) throw new Error("invalid source");
    const current = source as unknown as CurrentIngestSourceState;
    if (key !== portableIngestSourceKey(current.provider, current.path)) throw new Error("invalid source key");
    sources[key] = {
      provider: current.provider,
      path: current.path,
      size: current.size,
      mtimeNs: current.mtimeNs,
      ctimeNs: current.ctimeNs,
      processedAt: current.processedAt,
      eventIds: uniqueSorted(current.eventIds),
      active: current.active,
    };
  }
  return {
    state: {
      schemaVersion: PORTABLE_STORE_VERSION,
      ...(fields.costEnrichmentVersion !== undefined
        ? { costEnrichmentVersion: fields.costEnrichmentVersion as number }
        : {}),
      sources,
    },
    migrated,
  };
}

function isSimpleLegacySource(source: Record<string, unknown>): source is {
  size: number; mtimeMs: number; processedAt: string;
} {
  return hasExactKeys(source, ["size", "mtimeMs", "processedAt"])
    && isNonNegativeFinite(source.size) && isNonNegativeFinite(source.mtimeMs)
    && isTimestamp(source.processedAt);
}

function isOwnedLegacySource(source: Record<string, unknown>): source is {
  provider: PortableProvider; path: string; size: number; mtimeMs: number;
  processedAt: string; eventIds: string[]; active: boolean;
} {
  return hasExactKeys(source, ["provider", "path", "size", "mtimeMs", "processedAt", "eventIds", "active"])
    && isProvider(source.provider) && typeof source.path === "string" && path.isAbsolute(source.path)
    && isNonNegativeFinite(source.size) && isNonNegativeFinite(source.mtimeMs)
    && isTimestamp(source.processedAt) && isEventIds(source.eventIds) && typeof source.active === "boolean";
}

function isCurrentSourceRecord(source: Record<string, unknown>): boolean {
  return hasExactKeys(source, [
    "provider", "path", "size", "mtimeNs", "ctimeNs", "processedAt", "eventIds", "active",
  ]) && isProvider(source.provider) && typeof source.path === "string" && path.isAbsolute(source.path)
    && isDecimal(source.size) && isDecimal(source.mtimeNs) && isDecimal(source.ctimeNs)
    && isTimestamp(source.processedAt) && isEventIds(source.eventIds) && typeof source.active === "boolean";
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function isProvider(value: unknown): value is PortableProvider {
  return value === "claude" || value === "codex";
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isEventIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === "string" && /^[a-f0-9]{64}$/.test(id));
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function isDecimal(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function canonicalPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

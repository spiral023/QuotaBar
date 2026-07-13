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

export function isCurrentIngestSourceState(
  value: PortableIngestState["sources"][string] | undefined,
): value is CurrentIngestSourceState {
  return Boolean(value && isCurrentSourceRecord(value as unknown as Record<string, unknown>));
}

export function portableIngestSourceKey(provider: PortableProvider, sourcePath: string): string {
  return `${provider}:${canonicalPath(sourcePath)}`;
}

function parseState(value: unknown): ParsedPortableIngestState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid state");
  const fields = value as Record<string, unknown>;
  if (!hasExactKeys(fields, ["schemaVersion", "sources"])
    || fields.schemaVersion !== PORTABLE_STORE_VERSION
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
  return { state: { schemaVersion: PORTABLE_STORE_VERSION, sources }, migrated };
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

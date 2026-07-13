import { createHash } from "node:crypto";
import type AdmZip from "adm-zip";
import { defaultSettings, normalizeSettings, Settings } from "../config/settings";

export const ARCHIVE_FORMAT = "QuotaBar/archive" as const;
export const ARCHIVE_FORMAT_VERSION = 1 as const;
export const MAX_ARCHIVE_ENTRIES = 25_000;
export const MAX_ARCHIVE_FILE_SIZE = 64 * 1024 * 1024;
export const MAX_ARCHIVE_TOTAL_SIZE = 1024 * 1024 * 1024;

const MAX_COMPRESSION_RATIO = 1_000;
const COMMON_ZIP_FLAGS = 0x0008 | 0x0800;
const DEFLATE_OPTION_FLAGS = 0x0002 | 0x0004;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const WINDOWS_RESERVED_BASE = /^(?:con|prn|aux|nul|com(?:[1-9¹²³])|lpt(?:[1-9¹²³]))$/i;

export interface ArchiveManifestEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface ArchiveManifest {
  format: typeof ARCHIVE_FORMAT;
  formatVersion: typeof ARCHIVE_FORMAT_VERSION;
  quotaBarVersion: string;
  createdAt: string;
  entries: ArchiveManifestEntry[];
}

/** ZIP central-directory metadata that can be inspected without expanding an entry. */
export interface ArchiveEntryMetadata {
  entryName: string;
  isDirectory: boolean;
  size: number;
  compressedSize: number;
  flags: number;
  method: number;
  madeBy: number;
  attributes: number;
}

export interface ValidatedArchiveEntry extends ArchiveEntryMetadata {
  path: string;
}

export interface ArchiveFileBytes {
  path: string;
  data: Uint8Array;
}

export interface CreateArchiveManifestOptions {
  quotaBarVersion: string;
  createdAt?: string;
}

/** Copies only metadata from an AdmZip entry. This helper never calls getData(). */
export function metadataFromZipEntry(entry: AdmZip.IZipEntry): ArchiveEntryMetadata {
  try {
    assertNoZip64Metadata(entry);
  } catch {
    throw new Error("Unsupported ZIP64 archive entry");
  }
  return {
    entryName: entry.entryName,
    isDirectory: entry.isDirectory,
    size: entry.header.size,
    compressedSize: entry.header.compressedSize,
    flags: entry.header.flags,
    method: entry.header.method,
    madeBy: entry.header.made,
    attributes: entry.attr,
  };
}

function assertNoZip64Metadata(entry: AdmZip.IZipEntry): void {
  if (entry.header.size === 0xffff_ffff || entry.header.compressedSize === 0xffff_ffff) {
    throw new Error("Unsupported ZIP64 archive entry");
  }

  const runtimeEntry = entry as unknown as {
    extra?: unknown;
    rawEntry?: { extra?: unknown };
    header: { extra?: unknown };
  };
  const centralExtra = runtimeEntry.extra;
  if (!(centralExtra instanceof Uint8Array)) {
    throw new Error("Unsupported ZIP64 archive entry");
  }
  assertNoZip64Extra(centralExtra);
  for (const optionalExtra of [runtimeEntry.rawEntry?.extra, runtimeEntry.header.extra]) {
    if (optionalExtra !== undefined) {
      if (!(optionalExtra instanceof Uint8Array)) {
        throw new Error("Unsupported ZIP64 archive entry");
      }
      assertNoZip64Extra(optionalExtra);
    }
  }
}

function assertNoZip64Extra(extra: Uint8Array): void {
  const bytes = Buffer.from(extra.buffer, extra.byteOffset, extra.byteLength);
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 4) {
      throw new Error("Unsupported ZIP64 archive entry");
    }
    const fieldId = bytes.readUInt16LE(offset);
    const fieldSize = bytes.readUInt16LE(offset + 2);
    if (fieldId === 0x0001 || fieldSize > bytes.length - offset - 4) {
      throw new Error("Unsupported ZIP64 archive entry");
    }
    offset += 4 + fieldSize;
  }
}

export function normalizeArchivePath(rawPath: string): string {
  if (typeof rawPath !== "string" || rawPath.length === 0 || hasControlCharacter(rawPath)) {
    throw new Error("Invalid archive entry path");
  }

  const normalized = rawPath.replace(/\\/g, "/").normalize("NFC");
  if (normalized.startsWith("/") || /^[a-z]:/i.test(normalized) || normalized.includes(":")) {
    throw new Error("Invalid archive entry path");
  }

  const segments = normalized.split("/");
  if (segments.some((segment) =>
    segment.length === 0
    || segment === "."
    || segment === ".."
    || /[. ]$/.test(segment)
    || isInvalidWindowsSegment(segment)
  )) {
    throw new Error("Invalid archive entry path");
  }
  return segments.join("/");
}

export function isPortableArchivePath(rawPath: string): boolean {
  let archivePath: string;
  try {
    archivePath = normalizeArchivePath(rawPath);
  } catch {
    return false;
  }

  return archivePath === "manifest.json"
    || archivePath === "usage/store-metadata.json"
    || archivePath === "usage/migration-state.json"
    || archivePath === "settings.json"
    || archivePath === "window-history.json"
    || archivePath === "window-ratio.json"
    || archivePath === "bonus-state.json"
    || archivePath === "notification-state.json"
    || archivePath === "notifications.log"
    || archivePath.startsWith("usage/events/")
    || archivePath.startsWith("quota/");
}

export function validateZipEntryMetadata(entries: readonly ArchiveEntryMetadata[]): ValidatedArchiveEntry[] {
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error("Archive has too many entries");
  }

  const validated: ValidatedArchiveEntry[] = [];
  const canonicalPaths = new Set<string>();
  const directoryPrefixes = new Set<string>();
  let totalSize = 0;

  for (const entry of entries) {
    if (entry.isDirectory || isUnsupportedEntryType(entry)) {
      throw new Error("Unsupported archive entry type");
    }
    const archivePath = normalizeArchivePath(entry.entryName);
    if (!isPortableArchivePath(archivePath)) {
      throw new Error("Archive contains a disallowed entry");
    }
    validateEntrySizes(entry);

    const canonicalPath = archivePath.toLowerCase();
    if (canonicalPaths.has(canonicalPath)) {
      throw new Error("Archive contains a duplicate entry");
    }
    if (directoryPrefixes.has(canonicalPath)) {
      throw new Error("Archive contains a file/directory collision");
    }
    const segments = canonicalPath.split("/");
    let prefix = "";
    for (let index = 0; index < segments.length - 1; index += 1) {
      prefix = prefix ? `${prefix}/${segments[index]}` : segments[index];
      if (canonicalPaths.has(prefix)) {
        throw new Error("Archive contains a file/directory collision");
      }
      directoryPrefixes.add(prefix);
    }
    canonicalPaths.add(canonicalPath);

    if (totalSize > MAX_ARCHIVE_TOTAL_SIZE - entry.size) {
      throw new Error("Archive exceeds the expanded size limit");
    }
    totalSize += entry.size;
    validated.push({ ...entry, path: archivePath });
  }

  return validated;
}

export function createArchiveManifest(
  files: readonly ArchiveFileBytes[],
  options: CreateArchiveManifestOptions,
): ArchiveManifest {
  if (!isNonEmptyString(options.quotaBarVersion)) {
    throw new Error("Invalid archive manifest metadata");
  }
  const createdAt = options.createdAt ?? new Date().toISOString();
  if (!isIsoDate(createdAt)) {
    throw new Error("Invalid archive manifest metadata");
  }

  const paths = new Set<string>();
  const entries = files.map(({ path, data }) => {
    const normalizedPath = normalizeArchivePath(path);
    if (normalizedPath === "manifest.json" || !isPortableArchivePath(normalizedPath)) {
      throw new Error("Archive contains a disallowed entry");
    }
    const canonicalPath = normalizedPath.toLowerCase();
    if (paths.has(canonicalPath)) {
      throw new Error("Archive contains a duplicate entry");
    }
    paths.add(canonicalPath);
    if (data.byteLength > MAX_ARCHIVE_FILE_SIZE) {
      throw new Error("Archive entry exceeds the file size limit");
    }
    return {
      path: normalizedPath,
      size: data.byteLength,
      sha256: sha256(data),
    };
  }).sort((left, right) => left.path.localeCompare(right.path, "en"));

  if (entries.length + 1 > MAX_ARCHIVE_ENTRIES) {
    throw new Error("Archive has too many entries");
  }
  const totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (!Number.isSafeInteger(totalSize) || totalSize > MAX_ARCHIVE_TOTAL_SIZE) {
    throw new Error("Archive exceeds the expanded size limit");
  }

  return {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    quotaBarVersion: options.quotaBarVersion,
    createdAt,
    entries,
  };
}

export function parseArchiveManifest(input: string | Uint8Array): ArchiveManifest {
  try {
    const byteLength = typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.byteLength;
    if (byteLength > MAX_ARCHIVE_FILE_SIZE) {
      throw new Error("oversize");
    }
    const parsed: unknown = JSON.parse(typeof input === "string" ? input : Buffer.from(input).toString("utf8"));
    if (!isRecord(parsed)) {
      throw new Error("shape");
    }
    if (parsed.format !== ARCHIVE_FORMAT || parsed.formatVersion !== ARCHIVE_FORMAT_VERSION) {
      throw new UnsupportedManifestError();
    }
    if (!hasExactKeys(parsed, ["format", "formatVersion", "quotaBarVersion", "createdAt", "entries"])
      || !isNonEmptyString(parsed.quotaBarVersion)
      || !isIsoDate(parsed.createdAt)
      || !Array.isArray(parsed.entries)
      || parsed.entries.length > MAX_ARCHIVE_ENTRIES - 1) {
      throw new Error("shape");
    }

    const entries = parsed.entries.map(parseManifestEntry);
    return {
      format: ARCHIVE_FORMAT,
      formatVersion: ARCHIVE_FORMAT_VERSION,
      quotaBarVersion: parsed.quotaBarVersion,
      createdAt: parsed.createdAt,
      entries,
    };
  } catch (error) {
    if (error instanceof UnsupportedManifestError) {
      throw new Error("Unsupported archive manifest", { cause: error });
    }
    // Do not attach archive-controlled parser errors because callers may log error causes.
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Invalid archive manifest");
  }
}

export function validateArchiveStructure(
  archiveEntries: readonly ArchiveEntryMetadata[],
  archiveManifest: ArchiveManifest,
): ValidatedArchiveEntry[] {
  const validated = validateZipEntryMetadata(archiveEntries);
  const manifests = validated.filter((entry) => entry.path.toLowerCase() === "manifest.json");
  if (manifests.length !== 1) {
    throw new Error("Archive must contain exactly one manifest");
  }

  const archiveFiles = new Map<string, ValidatedArchiveEntry>();
  for (const entry of validated) {
    if (entry.path !== "manifest.json") archiveFiles.set(entry.path.toLowerCase(), entry);
  }

  const manifestFiles = new Set<string>();
  for (const entry of archiveManifest.entries) {
    validateManifestEntry(entry);
    const key = entry.path.toLowerCase();
    if (manifestFiles.has(key)) {
      throw new Error("Archive manifest contains a duplicate entry");
    }
    manifestFiles.add(key);
    const header = archiveFiles.get(key);
    if (!header || header.path !== entry.path || header.size !== entry.size) {
      throw new Error("Archive contents do not match manifest");
    }
  }
  if (archiveFiles.size !== manifestFiles.size) {
    throw new Error("Archive contents do not match manifest");
  }
  return validated;
}

export function verifyArchiveEntryBytes(entry: ArchiveManifestEntry, data: Uint8Array): void {
  validateManifestEntry(entry);
  if (data.byteLength !== entry.size) {
    throw new Error("Archive entry size does not match manifest");
  }
  if (sha256(data) !== entry.sha256) {
    throw new Error("Archive entry checksum does not match manifest");
  }
}

/** Removes all machine-bound and unknown settings while preserving normalized portable preferences. */
export function sanitizeImportedSettings(imported: unknown, _targetHome: string): Settings {
  const raw = isRecord(imported) ? imported : {};
  const normalized = normalizeSettings({
    ...defaultSettings,
    ...raw,
    claudeRoots: [],
    codexHomes: [],
  } as unknown as Settings);
  const rules = normalized.notifications.rules;
  return {
    pollIntervalSeconds: normalized.pollIntervalSeconds,
    providerTimeoutMs: normalized.providerTimeoutMs,
    providerOrder: [...normalized.providerOrder],
    claudeRoots: [],
    codexHomes: [],
    plans: normalized.plans.map((plan) => ({
      id: plan.id,
      provider: plan.provider,
      name: plan.name,
      amount: plan.amount,
      currency: plan.currency,
      startsAt: plan.startsAt,
      endsAt: plan.endsAt,
    })),
    pricingOfflineMode: normalized.pricingOfflineMode,
    anonymizeAccounts: normalized.anonymizeAccounts,
    costWindow: normalized.costWindow,
    viewMode: normalized.viewMode,
    insightsPanelOpen: normalized.insightsPanelOpen,
    pinned: normalized.pinned,
    minModelTokenSharePct: normalized.minModelTokenSharePct,
    debugLog: { enabled: normalized.debugLog.enabled },
    proxy: { mode: normalized.proxy.mode, url: normalized.proxy.url },
    notifications: {
      enabled: normalized.notifications.enabled,
      quietHours: {
        enabled: normalized.notifications.quietHours.enabled,
        start: normalized.notifications.quietHours.start,
        end: normalized.notifications.quietHours.end,
      },
      minimumGapMinutes: normalized.notifications.minimumGapMinutes,
      rules: {
        confirmedReset: copyRuleBase(rules.confirmedReset),
        unexpectedReset: {
          ...copyRuleBase(rules.unexpectedReset),
          minPreviousPercent: rules.unexpectedReset.minPreviousPercent,
          maxNextPercent: rules.unexpectedReset.maxNextPercent,
        },
        resetSoon: {
          ...copyRuleBase(rules.resetSoon),
          minutesBeforeReset: rules.resetSoon.minutesBeforeReset,
        },
        highUsage: {
          ...copyRuleBase(rules.highUsage),
          thresholdPercent: rules.highUsage.thresholdPercent,
        },
        criticalUsage: {
          ...copyRuleBase(rules.criticalUsage),
          thresholdPercent: rules.criticalUsage.thresholdPercent,
        },
        projectedDepletion: {
          ...copyRuleBase(rules.projectedDepletion),
          minEarlyMinutes: rules.projectedDepletion.minEarlyMinutes,
        },
        farAhead: {
          ...copyRuleBase(rules.farAhead),
          minDeltaPercent: rules.farAhead.minDeltaPercent,
        },
        farBehind: {
          ...copyRuleBase(rules.farBehind),
          minDeltaPercent: rules.farBehind.minDeltaPercent,
        },
        freshQuotaWorkWindow: {
          ...copyRuleBase(rules.freshQuotaWorkWindow),
          maxUsedPercent: rules.freshQuotaWorkWindow.maxUsedPercent,
        },
        quotaIdleAfterReset: {
          ...copyRuleBase(rules.quotaIdleAfterReset),
          minutesAfterReset: rules.quotaIdleAfterReset.minutesAfterReset,
          maxUsedPercent: rules.quotaIdleAfterReset.maxUsedPercent,
        },
        weeklyReserveOpportunity: {
          ...copyRuleBase(rules.weeklyReserveOpportunity),
          maxUsedPercent: rules.weeklyReserveOpportunity.maxUsedPercent,
          hoursBeforeReset: rules.weeklyReserveOpportunity.hoursBeforeReset,
        },
        rolling5hOutputSpike: {
          ...copyRuleBase(rules.rolling5hOutputSpike),
          baseline: rules.rolling5hOutputSpike.baseline,
        },
        rolling5hProxyLimit: {
          ...copyRuleBase(rules.rolling5hProxyLimit),
          thresholdPercent: rules.rolling5hProxyLimit.thresholdPercent,
          customOutputTokenLimit: rules.rolling5hProxyLimit.customOutputTokenLimit,
        },
        burnRateSpike: {
          ...copyRuleBase(rules.burnRateSpike),
          factor: rules.burnRateSpike.factor,
        },
        cacheHitDrop: {
          ...copyRuleBase(rules.cacheHitDrop),
          claudeThresholdPercent: rules.cacheHitDrop.claudeThresholdPercent,
          codexThresholdPercent: rules.cacheHitDrop.codexThresholdPercent,
        },
        expensiveModelShare: {
          ...copyRuleBase(rules.expensiveModelShare),
          thresholdPercent: rules.expensiveModelShare.thresholdPercent,
        },
        roiMilestone: {
          ...copyRuleBase(rules.roiMilestone),
          milestones: [...rules.roiMilestone.milestones],
        },
        providerDataHealth: {
          ...copyRuleBase(rules.providerDataHealth),
          staleMinutes: rules.providerDataHealth.staleMinutes,
          notifyRecovered: rules.providerDataHealth.notifyRecovered,
        },
        missingPlan: copyRuleBase(rules.missingPlan),
      },
    },
  };
}

function validateEntrySizes(entry: ArchiveEntryMetadata): void {
  if (!isValidSize(entry.size) || !isValidSize(entry.compressedSize)) {
    throw new Error("Invalid archive entry size");
  }
  if (entry.size > MAX_ARCHIVE_FILE_SIZE) {
    throw new Error("Archive entry exceeds the file size limit");
  }
  if (entry.compressedSize > MAX_ARCHIVE_FILE_SIZE || (entry.size > 0 && entry.compressedSize === 0)) {
    throw new Error("Invalid archive entry size");
  }
  if (entry.compressedSize > 0 && entry.size / entry.compressedSize > MAX_COMPRESSION_RATIO) {
    throw new Error("Archive entry exceeds the compression ratio limit");
  }
  if (!isUnsignedInteger(entry.flags, 0xffff)
    || !isUnsignedInteger(entry.method, 0xffff)
    || !isUnsignedInteger(entry.madeBy, 0xffff)
    || !isUnsignedInteger(entry.attributes, 0xffff_ffff)
    || ![0, 8].includes(entry.method)) {
    throw new Error("Unsupported archive entry metadata");
  }
  const supportedFlags = COMMON_ZIP_FLAGS | (entry.method === 8 ? DEFLATE_OPTION_FLAGS : 0);
  if ((entry.flags & ~supportedFlags) !== 0) {
    throw new Error("Unsupported archive entry metadata");
  }
}

function isUnsupportedEntryType(entry: ArchiveEntryMetadata): boolean {
  if ((entry.attributes & 0x400) !== 0) return true;
  const unixMode = entry.attributes >>> 16;
  const fileType = unixMode & 0o170000;
  return fileType !== 0 && fileType !== 0o100000;
}

function parseManifestEntry(value: unknown): ArchiveManifestEntry {
  if (!isRecord(value)) throw new Error("shape");
  const entry = value as unknown as ArchiveManifestEntry;
  validateManifestEntry(entry);
  if (!hasExactKeys(value, ["path", "size", "sha256"])) throw new Error("shape");
  return { path: entry.path, size: entry.size, sha256: entry.sha256 };
}

function validateManifestEntry(entry: ArchiveManifestEntry): void {
  if (!entry || typeof entry.path !== "string" || entry.path === "manifest.json") {
    throw new Error("Invalid archive manifest entry");
  }
  const normalizedPath = normalizeArchivePath(entry.path);
  if (normalizedPath !== entry.path || !isPortableArchivePath(normalizedPath)) {
    throw new Error("Invalid archive manifest entry");
  }
  if (!isValidSize(entry.size) || entry.size > MAX_ARCHIVE_FILE_SIZE || !SHA256_PATTERN.test(entry.sha256)) {
    throw new Error("Invalid archive manifest entry");
  }
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function isValidSize(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isUnsignedInteger(value: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= maximum;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) return true;
  }
  return false;
}

function isInvalidWindowsSegment(segment: string): boolean {
  if (/[<>:"|?*]/.test(segment)) return true;
  const basename = (segment.split(".", 1)[0] ?? "").replace(/[ .]+$/g, "");
  return WINDOWS_RESERVED_BASE.test(basename);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyRuleBase(rule: { enabled: boolean; cooldownMinutes: number }): {
  enabled: boolean;
  cooldownMinutes: number;
} {
  return { enabled: rule.enabled, cooldownMinutes: rule.cooldownMinutes };
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

class UnsupportedManifestError extends Error {}

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { defaultSettings } from "../src/config/settings";
import {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_FILE_SIZE,
  MAX_ARCHIVE_TOTAL_SIZE,
  ArchiveEntryMetadata,
  ArchiveManifest,
  createArchiveManifest,
  isPortableArchivePath,
  normalizeArchivePath,
  parseArchiveManifest,
  sanitizeImportedSettings,
  validateArchiveStructure,
  validateZipEntryMetadata,
  verifyArchiveEntryBytes,
} from "../src/portable/archiveManifest";

function entry(
  entryName: string,
  size = 1,
  overrides: Partial<ArchiveEntryMetadata> = {},
): ArchiveEntryMetadata {
  return {
    entryName,
    isDirectory: false,
    size,
    compressedSize: size,
    flags: 0,
    method: 0,
    madeBy: 0,
    attributes: 0,
    ...overrides,
  };
}

function manifest(entries: ArchiveManifest["entries"]): ArchiveManifest {
  return {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    quotaBarVersion: "1.5.0",
    createdAt: "2026-07-13T10:00:00.000Z",
    entries,
  };
}

const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

describe("portable archive allowlist", () => {
  it.each([
    "manifest.json",
    "usage/events/2026/07/events.jsonl",
    "usage/store-metadata.json",
    "usage/migration-state.json",
    "quota/2026/07/snapshots.jsonl",
    "settings.json",
    "window-history.json",
    "window-ratio.json",
    "bonus-state.json",
    "notification-state.json",
    "notifications.log",
  ])("allows %s", (path) => {
    expect(isPortableArchivePath(path)).toBe(true);
  });

  it.each([
    "usage/ingest-state.json",
    "auth/credentials.json",
    "credentials.json",
    "provider/session.log",
    "debug/session.jsonl",
    "cache/prices.json",
    "backups/archive.zip",
    "logs/quotabar.log",
    "install.marker",
    "usage/events",
    "quota",
  ])("excludes %s", (path) => {
    expect(isPortableArchivePath(path)).toBe(false);
  });
});

describe("ZIP path validation before content access", () => {
  it("normalizes backslash separators", () => {
    expect(normalizeArchivePath("usage\\events\\2026.jsonl")).toBe("usage/events/2026.jsonl");
  });

  it.each([
    "../settings.json",
    "usage/events/../../settings.json",
    "./settings.json",
    "/settings.json",
    "C:\\settings.json",
    "C:settings.json",
    "\\\\server\\share\\settings.json",
    "usage//events/x.jsonl",
    "usage/./events/x.jsonl",
    "usage/events/../x.jsonl",
    "usage/events/x.jsonl\0hidden",
    "usage/events/x\n.jsonl",
    "usage/events/x.jsonl ",
    "usage/events/x.jsonl.",
    "usage/events/x.jsonl:secret",
    "usage/events/CON.jsonl",
    "usage/events/aux",
  ])("rejects ambiguous or unsafe path %j", (path) => {
    expect(() => normalizeArchivePath(path)).toThrow("Invalid archive entry path");
  });

  it("rejects case-insensitive and canonical duplicates", () => {
    expect(() => validateZipEntryMetadata([
      entry("manifest.json"),
      entry("usage/events/A.jsonl"),
      entry("usage/events/a.jsonl"),
    ])).toThrow("duplicate");
  });

  it("rejects file and directory-prefix collisions", () => {
    expect(() => validateZipEntryMetadata([
      entry("manifest.json"),
      entry("usage/events/day"),
      entry("usage/events/day/events.jsonl"),
    ])).toThrow("collision");
  });

  it("rejects directory and symlink-like entries", () => {
    expect(() => validateZipEntryMetadata([
      entry("manifest.json"),
      entry("usage/events/", 0, { isDirectory: true }),
    ])).toThrow("Unsupported archive entry type");

    expect(() => validateZipEntryMetadata([
      entry("manifest.json"),
      entry("usage/events/link", 1, { madeBy: 3 << 8, attributes: (0o120777 << 16) >>> 0 }),
    ])).toThrow("Unsupported archive entry type");
  });

  it("rejects encrypted, unsupported, and malformed header metadata", () => {
    expect(() => validateZipEntryMetadata([entry("manifest.json", 1, { flags: 1 })]))
      .toThrow("Unsupported archive entry metadata");
    expect(() => validateZipEntryMetadata([entry("manifest.json", 1, { method: 99 })]))
      .toThrow("Unsupported archive entry metadata");
    expect(() => validateZipEntryMetadata([entry("manifest.json", 1, { attributes: Number.NaN })]))
      .toThrow("Unsupported archive entry metadata");
    expect(() => validateZipEntryMetadata([entry("manifest.json", 1, { madeBy: -1 })]))
      .toThrow("Unsupported archive entry metadata");
  });

  it("requires ZIP attributes to be unsigned safe 32-bit integers", () => {
    for (const attributes of [-0x8000_0000, 1.5, 0x1_0000_0000]) {
      expect(() => validateZipEntryMetadata([entry("manifest.json", 1, { attributes })]))
        .toThrow("Unsupported archive entry metadata");
    }
    expect(() => validateZipEntryMetadata([entry("manifest.json", 1, { attributes: 0x20 })]))
      .not.toThrow();
  });
});

describe("ZIP metadata limits", () => {
  it("rejects more than 25,000 entries", () => {
    const entries = Array.from({ length: MAX_ARCHIVE_ENTRIES + 1 }, (_, index) =>
      entry(`usage/events/${index}.jsonl`, 0),
    );
    expect(() => validateZipEntryMetadata(entries)).toThrow("too many entries");
  });

  it("rejects oversized, negative, non-integer, and suspiciously compressed files", () => {
    expect(() => validateZipEntryMetadata([entry("manifest.json", MAX_ARCHIVE_FILE_SIZE + 1)]))
      .toThrow("file size limit");
    expect(() => validateZipEntryMetadata([entry("manifest.json", -1)]))
      .toThrow("Invalid archive entry size");
    expect(() => validateZipEntryMetadata([entry("manifest.json", 1.5)]))
      .toThrow("Invalid archive entry size");
    expect(() => validateZipEntryMetadata([entry("manifest.json", 10_000, { compressedSize: 1 })]))
      .toThrow("compression ratio");
  });

  it("rejects an expanded total over 1 GiB without allocating file contents", () => {
    const entries = Array.from({ length: 17 }, (_, index) =>
      entry(`usage/events/${index}.jsonl`, MAX_ARCHIVE_FILE_SIZE),
    );
    expect(entries.reduce((sum, item) => sum + item.size, 0)).toBeGreaterThan(MAX_ARCHIVE_TOTAL_SIZE);
    expect(() => validateZipEntryMetadata(entries)).toThrow("expanded size limit");
  });
});

describe("portable archive manifest", () => {
  it("creates stable versioned entries with byte sizes and SHA-256 checksums", () => {
    const data = Buffer.from("portable statistics", "utf8");
    const result = createArchiveManifest(
      [{ path: "usage/events/2026.jsonl", data }],
      { quotaBarVersion: "1.5.0", createdAt: "2026-07-13T10:00:00.000Z" },
    );

    expect(result).toEqual(manifest([{
      path: "usage/events/2026.jsonl",
      size: data.byteLength,
      sha256: digest(data),
    }]));
  });

  it("rejects unsupported formats and versions without echoing archive contents", () => {
    for (const value of [
      { ...manifest([]), format: "Other/archive" },
      { ...manifest([]), formatVersion: 2 },
    ]) {
      expect(() => parseArchiveManifest(JSON.stringify(value))).toThrow("Unsupported archive manifest");
    }
    expect(() => parseArchiveManifest("secret archive contents")).toThrow("Invalid archive manifest");
    try {
      parseArchiveManifest("secret archive contents");
    } catch (error) {
      expect(String(error)).not.toContain("secret archive contents");
    }
  });

  it.each([
    "2026-02-30T10:00:00.000Z",
    "2026-07-13T10:00:00",
    "2026-07-13T12:00:00.000+02:00",
    "2026-07-13T10:00:00Z",
    "2026-07-13T10:00:00.0Z",
  ])("rejects noncanonical manifest creation time %s", (createdAt) => {
    expect(() => parseArchiveManifest(JSON.stringify({ ...manifest([]), createdAt })))
      .toThrow("Invalid archive manifest");
    expect(() => createArchiveManifest([], { quotaBarVersion: "1.5.0", createdAt }))
      .toThrow("Invalid archive manifest metadata");
  });

  it("emits an exact canonical UTC timestamp when creation time is omitted", () => {
    const createdAt = createArchiveManifest([], { quotaBarVersion: "1.5.0" }).createdAt;
    expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(Date.parse(createdAt)).toISOString()).toBe(createdAt);
  });

  it("requires manifest entries exactly once with no missing or unmanifested files", () => {
    const file = { path: "settings.json", size: 2, sha256: digest(Buffer.from("{}")) };
    expect(() => validateArchiveStructure(
      [entry("manifest.json", 1), entry("settings.json", 2), entry("bonus-state.json", 2)],
      manifest([file]),
    )).toThrow("do not match manifest");
    expect(() => validateArchiveStructure(
      [entry("manifest.json", 1)],
      manifest([file]),
    )).toThrow("do not match manifest");
    expect(() => validateArchiveStructure(
      [entry("manifest.json", 1), entry("settings.json", 2)],
      manifest([file, file]),
    )).toThrow("duplicate");
  });

  it("rejects a missing or repeated root manifest", () => {
    expect(() => validateArchiveStructure([entry("settings.json", 2)], manifest([])))
      .toThrow("exactly one manifest");
    expect(() => validateArchiveStructure(
      [entry("manifest.json", 1), entry("MANIFEST.JSON", 1)],
      manifest([]),
    )).toThrow();
  });

  it("verifies checksum and actual byte size", () => {
    const expected = { path: "settings.json", size: 2, sha256: digest(Buffer.from("{}")) };
    expect(() => verifyArchiveEntryBytes(expected, Buffer.from("{}"))).not.toThrow();
    expect(() => verifyArchiveEntryBytes(expected, Buffer.from("[]"))).toThrow("checksum");
    expect(() => verifyArchiveEntryBytes(expected, Buffer.from("{ }"))).toThrow("size");
  });
});

describe("cross-user settings sanitization", () => {
  it("clears Alice's roots for Bob and preserves machine-independent plans and preferences", () => {
    const plan = {
      id: "plan-1",
      provider: "claude" as const,
      name: "Pro",
      amount: 20,
      currency: "USD" as const,
      startsAt: "2026-01-01T00:00:00.000Z",
      endsAt: null,
    };
    const result = sanitizeImportedSettings({
      ...defaultSettings,
      claudeRoots: ["C:\\Users\\Alice\\.claude"],
      codexHomes: ["C:\\Users\\Alice\\.codex"],
      plans: [plan],
      pinned: false,
    }, "C:\\Users\\Bob");

    expect(result.claudeRoots).toEqual([]);
    expect(result.codexHomes).toEqual([]);
    expect(result.plans).toEqual([plan]);
    expect(result.pinned).toBe(false);
  });

  it("drops unknown nested source-machine paths instead of retaining private metadata", () => {
    const imported = {
      ...defaultSettings,
      unknown: { sourcePath: "C:\\Users\\Alice\\secret" },
      proxy: { ...defaultSettings.proxy, sourcePath: "C:\\Users\\Alice\\proxy" },
      notifications: {
        ...defaultSettings.notifications,
        rules: {
          ...defaultSettings.notifications.rules,
          confirmedReset: {
            ...defaultSettings.notifications.rules.confirmedReset,
            enabled: false,
            cooldownMinutes: 77,
            sourcePath: "C:\\Users\\Alice\\provider.log",
            authToken: "not-portable",
          },
          criticalUsage: {
            ...defaultSettings.notifications.rules.criticalUsage,
            thresholdPercent: 91,
            sourcePath: "C:\\Users\\Alice\\private",
          },
        },
      },
    };
    const result = sanitizeImportedSettings(imported, "C:\\Users\\Bob") as unknown as Record<string, unknown>;

    expect(result).not.toHaveProperty("unknown");
    expect(result.proxy).not.toHaveProperty("sourcePath");
    expect(result).not.toHaveProperty("notifications.rules.confirmedReset.sourcePath");
    expect(result).not.toHaveProperty("notifications.rules.confirmedReset.authToken");
    expect(result).not.toHaveProperty("notifications.rules.criticalUsage.sourcePath");
    expect(result).toHaveProperty("notifications.rules.confirmedReset", {
      enabled: false,
      cooldownMinutes: 77,
    });
    expect(result).toHaveProperty("notifications.rules.criticalUsage.thresholdPercent", 91);
  });
});

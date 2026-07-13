import AdmZip from "adm-zip";
import * as fsPromises from "node:fs/promises";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_FILE_SIZE,
  parseArchiveManifest,
  verifyArchiveEntryBytes,
} from "../src/portable/archiveManifest";
import { withPortableRootLock } from "../src/portable/rootLock";
import {
  applyPendingImport,
  createFullBackup,
  exportPortableData,
  stagePortableImport,
} from "../src/portable/archiveService";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "quotabar-archive-service-"));
  roots.push(root);
  return root;
}

async function put(root: string, relativePath: string, data: string): Promise<void> {
  const target = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, data, "utf8");
}

function fakeZipEntry(
  entryName: string,
  overrides: Partial<{ size: number; compressedSize: number; extra: Buffer }> = {},
  onGetData: () => void = () => undefined,
): AdmZip.IZipEntry {
  const extra = overrides.extra ?? Buffer.alloc(0);
  return {
    entryName,
    isDirectory: false,
    attr: 0,
    extra,
    header: {
      size: overrides.size ?? 1,
      compressedSize: overrides.compressedSize ?? 1,
      flags: 0,
      method: 0,
      made: 0,
      extra,
    },
    getData: () => { onGetData(); return Buffer.from("x"); },
    getDataAsync: () => { onGetData(); return Promise.resolve(Buffer.from("x")); },
    getCompressedData: () => Buffer.from("x"),
  } as unknown as AdmZip.IZipEntry;
}

describe("portable archive service", () => {
  it("exports only existing portable files with verified manifest checksums", async () => {
    const root = await tempRoot();
    const appDir = path.join(root, "Alice", ".quotabar-win");
    const archivePath = path.join(root, "portable.zip");
    await put(appDir, "usage/store-metadata.json", "{\"schemaVersion\":1}");
    await put(appDir, "usage/events/2026-07.jsonl", "portable-event\n");
    await put(appDir, "quota/2026-07.jsonl", "portable-quota\n");
    await put(appDir, "settings.json", "{\"claudeRoots\":[\"C:/Users/Alice/.claude\"]}");
    await put(appDir, "usage/ingest-state.json", "source-secret");
    await put(appDir, "debug/events.jsonl", "debug-secret");
    await put(appDir, "cache/prices.json", "cache-secret");
    await put(appDir, "auth.json", "auth-secret");
    await put(appDir, "quotabar.log", "log-secret");

    const result = await exportPortableData(appDir, archivePath);

    expect(result.path).toBe(archivePath);
    expect(result.fileCount).toBe(4);
    const zip = new AdmZip(archivePath);
    const names = zip.getEntries().map((entry) => entry.entryName).sort();
    expect(names).toEqual([
      "manifest.json",
      "quota/2026-07.jsonl",
      "settings.json",
      "usage/events/2026-07.jsonl",
      "usage/store-metadata.json",
    ]);
    const manifest = parseArchiveManifest(zip.getEntry("manifest.json")!.getData());
    for (const entry of manifest.entries) {
      verifyArchiveEntryBytes(entry, zip.getEntry(entry.path)!.getData());
    }
    await expect(readFile(`${archivePath}.partial`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates and verifies a private full backup without exposing file contents", async () => {
    const root = await tempRoot();
    const appDir = path.join(root, ".quotabar-win");
    const backupPath = path.join(root, "QuotaBar Backups", "backup.zip");
    await put(appDir, "settings.json", "settings-secret");
    await put(appDir, "debug/events.jsonl", "debug-secret");
    await put(appDir, "quotabar.log", "log-secret");

    const result = await createFullBackup(appDir, backupPath);

    expect(result).toEqual({ path: backupPath, fileCount: 3, totalBytes: 37 });
    const zip = new AdmZip(backupPath);
    expect(zip.getEntries().map((entry) => entry.entryName).sort()).toEqual([
      "debug/events.jsonl",
      "quotabar.log",
      "settings.json",
    ]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("rejects full-backup destinations equal to or below the app directory", async () => {
    const root = await tempRoot();
    const appDir = path.join(root, ".quotabar-win");
    await put(appDir, "quota/2026-07.jsonl", "quota-data\n");
    const destinations = [
      appDir,
      path.join(appDir, "backup.zip"),
      path.join(appDir, "quota", "backup.zip"),
    ];
    await put(appDir, "quota/backup.zip.partial", "keep-partial");

    for (const destination of destinations) {
      await expect(createFullBackup(appDir, destination)).rejects.toThrow("QuotaBar backup failed");
      if (destination !== appDir) await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readFile(path.join(appDir, "quota/backup.zip.partial"), "utf8")).toBe("keep-partial");
    const sibling = path.join(root, "QuotaBar Backups", "accepted.zip");
    await expect(createFullBackup(appDir, sibling)).resolves.toMatchObject({ path: sibling, fileCount: 2 });
  });

  it("rejects a full-backup destination below a junction parent", async () => {
    const root = await tempRoot();
    const appDir = path.join(root, ".quotabar-win");
    const outside = path.join(root, "outside");
    const linkedBackupDir = path.join(root, "QuotaBar Backups");
    await put(appDir, "settings.json", "{}");
    await mkdir(outside);
    await symlink(outside, linkedBackupDir, "junction");

    await expect(createFullBackup(appDir, path.join(linkedBackupDir, "backup.zip")))
      .rejects.toThrow("QuotaBar backup failed");
    await expect(access(path.join(outside, "backup.zip"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stages Alice data for Bob, sanitizes machine paths, and applies only managed files", async () => {
    const root = await tempRoot();
    const alice = path.join(root, "Alice", ".quotabar-win");
    const bobHome = path.join(root, "Bob");
    const bob = path.join(bobHome, ".quotabar-win");
    const portableZip = path.join(root, "alice.zip");
    await put(alice, "usage/events/2026-07.jsonl", "alice-event\n");
    await put(alice, "quota/2026-07.jsonl", "alice-quota\n");
    await put(alice, "settings.json", JSON.stringify({
      claudeRoots: ["C:/Users/Alice/.claude"],
      codexHomes: ["C:/Users/Alice/.codex"],
      costWindow: "7d",
    }));
    await exportPortableData(alice, portableZip);
    await put(bob, "usage/events/old.jsonl", "bob-old\n");
    await put(bob, "usage/ingest-state.json", "bob-ingest");
    await put(bob, "quotabar.log", "keep-log");
    await put(bob, "debug/events.jsonl", "keep-debug");
    await put(bob, "cache/prices.json", "keep-cache");

    const staged = await stagePortableImport(portableZip, bob, bobHome);

    expect(staged.pending).toBe(true);
    expect(path.dirname(staged.backupPath)).toBe(path.join(root, "Bob", "QuotaBar Backups"));
    expect(new AdmZip(staged.backupPath).getEntry("quotabar.log")!.getData().toString()).toBe("keep-log");
    expect(await readFile(path.join(bob, "usage/events/old.jsonl"), "utf8")).toBe("bob-old\n");

    const applied = await applyPendingImport(bob);

    expect(applied.applied).toBe(true);
    expect(await readFile(path.join(bob, "usage/events/2026-07.jsonl"), "utf8")).toBe("alice-event\n");
    await expect(readFile(path.join(bob, "usage/events/old.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(path.join(bob, "usage/ingest-state.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      sources: {},
    });
    const settings = JSON.parse(await readFile(path.join(bob, "settings.json"), "utf8"));
    expect(settings.claudeRoots).toEqual([]);
    expect(settings.codexHomes).toEqual([]);
    expect(settings.costWindow).toBe("7d");
    expect(JSON.stringify(settings)).not.toContain("Alice");
    expect(await readFile(path.join(bob, "quotabar.log"), "utf8")).toBe("keep-log");
    expect(await readFile(path.join(bob, "debug/events.jsonl"), "utf8")).toBe("keep-debug");
    expect(await readFile(path.join(bob, "cache/prices.json"), "utf8")).toBe("keep-cache");
    expect(await applyPendingImport(bob)).toEqual({ applied: false, fileCount: 0, totalBytes: 0 });
  });

  it("rejects a corrupt archive before staging and keeps errors free of archive contents", async () => {
    const root = await tempRoot();
    const source = path.join(root, "source", ".quotabar-win");
    const targetHome = path.join(root, "target");
    const target = path.join(targetHome, ".quotabar-win");
    const validZip = path.join(root, "valid.zip");
    const corruptZip = path.join(root, "contains-super-secret.zip");
    await put(source, "usage/events/events.jsonl", "super-secret-archive-content");
    await put(target, "settings.json", "{}");
    await exportPortableData(source, validZip);
    const zip = new AdmZip(validZip);
    zip.getEntry("usage/events/events.jsonl")!.setData(Buffer.from("tampered"));
    zip.writeZip(corruptZip);

    let message = "";
    try {
      await stagePortableImport(corruptZip, target, targetHome);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("Portable data import failed");
    expect(message).not.toContain("super-secret");
    await expect(access(path.join(target, ".portable-import.pending.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fsPromises.readdir(targetHome)).filter((name) => name.includes("portable-import"))).toEqual([]);
  });

  it("rejects unexpected entries and unsupported manifest versions without staging writes", async () => {
    const root = await tempRoot();
    const source = path.join(root, "source", ".quotabar-win");
    const targetHome = path.join(root, "target");
    const target = path.join(targetHome, ".quotabar-win");
    const validZip = path.join(root, "valid.zip");
    await put(source, "settings.json", "{}");
    await put(target, "settings.json", "{}");
    await exportPortableData(source, validZip);

    const unexpectedZip = path.join(root, "unexpected.zip");
    const unexpected = new AdmZip(validZip);
    unexpected.addFile("auth.json", Buffer.from("secret-token"));
    unexpected.writeZip(unexpectedZip);
    await expect(stagePortableImport(unexpectedZip, target, targetHome)).rejects.toThrow("Portable data import failed");

    const unsupportedZip = path.join(root, "unsupported.zip");
    const unsupported = new AdmZip(validZip);
    const manifestEntry = unsupported.getEntry("manifest.json")!;
    const manifest = JSON.parse(manifestEntry.getData().toString("utf8"));
    manifest.formatVersion = 999;
    manifestEntry.setData(Buffer.from(JSON.stringify(manifest)));
    unsupported.writeZip(unsupportedZip);
    await expect(stagePortableImport(unsupportedZip, target, targetHome)).rejects.toThrow("Portable data import failed");

    await expect(access(path.join(target, ".portable-import.pending.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fsPromises.readdir(targetHome)).filter((name) => name.includes("portable-import"))).toEqual([]);
  });

  it("rejects symlinked application data and removes the destination partial", async () => {
    const root = await tempRoot();
    const appDir = path.join(root, ".quotabar-win");
    const outside = path.join(root, "outside-secret");
    const archivePath = path.join(root, "portable.zip");
    await put(appDir, "settings.json", "{}");
    await put(outside, "events.jsonl", "outside-secret");
    await symlink(outside, path.join(appDir, "quota"), "junction");

    await expect(exportPortableData(appDir, archivePath)).rejects.toThrow("Portable data export failed");
    await expect(access(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(`${archivePath}.partial`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores originals byte-for-byte when a managed rename fails", async () => {
    const root = await tempRoot();
    const source = path.join(root, "source", ".quotabar-win");
    const targetHome = path.join(root, "target");
    const target = path.join(targetHome, ".quotabar-win");
    const archivePath = path.join(root, "portable.zip");
    await put(source, "usage/events/new.jsonl", "new-data\n");
    await put(source, "settings.json", "{\"costWindow\":\"7d\"}");
    await put(target, "usage/events/old.jsonl", "old-data\n");
    await put(target, "settings.json", "{\"costWindow\":\"30d\"}");
    await put(target, "quotabar.log", "keep-log");
    await exportPortableData(source, archivePath);
    await stagePortableImport(archivePath, target, targetHome);
    let injected = false;
    const rename = async (from: Parameters<typeof fsPromises.rename>[0], to: Parameters<typeof fsPromises.rename>[1]) => {
      if (String(from).endsWith(path.join("usage", "events", "old.jsonl")) && String(to).includes(".rollback")) {
        injected = true;
        throw new Error("rename-super-secret");
      }
      return fsPromises.rename(from, to);
    };

    await expect(applyPendingImport(target, { rename })).rejects.toThrow("Portable data apply failed");
    expect(injected).toBe(true);
    expect(await readFile(path.join(target, "usage/events/old.jsonl"), "utf8")).toBe("old-data\n");
    await expect(access(path.join(target, "usage/events/new.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(target, "settings.json"), "utf8")).toBe("{\"costWindow\":\"30d\"}");
    expect(await readFile(path.join(target, "quotabar.log"), "utf8")).toBe("keep-log");
  });

  it("resumes an interrupted pending import idempotently", async () => {
    const root = await tempRoot();
    const source = path.join(root, "source", ".quotabar-win");
    const targetHome = path.join(root, "target");
    const target = path.join(targetHome, ".quotabar-win");
    const archivePath = path.join(root, "portable.zip");
    await put(source, "usage/events/new.jsonl", "new-data\n");
    await put(target, "usage/events/old.jsonl", "old-data\n");
    await exportPortableData(source, archivePath);
    await stagePortableImport(archivePath, target, targetHome);
    const pending = JSON.parse(await readFile(path.join(target, ".portable-import.pending.json"), "utf8"));
    const staging = path.join(targetHome, pending.stagingDirectory);
    const rollback = path.join(targetHome, pending.rollbackDirectory);
    await mkdir(path.join(rollback, "usage/events"), { recursive: true });
    await fsPromises.rename(path.join(target, "usage/events/old.jsonl"), path.join(rollback, "usage/events/old.jsonl"));
    await fsPromises.rename(path.join(staging, "usage/events/new.jsonl"), path.join(target, "usage/events/new.jsonl"));

    await expect(applyPendingImport(target)).resolves.toMatchObject({ applied: true });
    expect(await readFile(path.join(target, "usage/events/new.jsonl"), "utf8")).toBe("new-data\n");
    await expect(access(path.join(target, "usage/events/old.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects missing or corrupt referenced backups before any apply rename", async () => {
    for (const corruption of ["missing", "corrupt"] as const) {
      const root = await tempRoot();
      const source = path.join(root, "source", ".quotabar-win");
      const targetHome = path.join(root, `target-${corruption}`);
      const target = path.join(targetHome, ".quotabar-win");
      const archivePath = path.join(root, `${corruption}.zip`);
      await put(source, "settings.json", "{}");
      await put(target, "settings.json", "{\"costWindow\":\"7d\"}");
      await exportPortableData(source, archivePath);
      const staged = await stagePortableImport(archivePath, target, targetHome);
      if (corruption === "missing") await rm(staged.backupPath);
      else {
        const replacement = await readFile(staged.backupPath);
        replacement[Math.floor(replacement.length / 2)] ^= 0xff;
        await writeFile(staged.backupPath, replacement);
      }
      let renames = 0;
      const rename: typeof fsPromises.rename = async (from, to) => {
        renames += 1;
        return fsPromises.rename(from, to);
      };

      await expect(applyPendingImport(target, { rename })).rejects.toThrow("Portable data apply failed");
      expect(renames).toBe(0);
      expect(await readFile(path.join(target, "settings.json"), "utf8")).toBe("{\"costWindow\":\"7d\"}");
    }
  });

  it("rejects oversized or extended pending metadata before managed renames", async () => {
    for (const variant of ["oversized", "extra", "reserved-name", "backup-total"] as const) {
      const root = await tempRoot();
      const source = path.join(root, "source", ".quotabar-win");
      const targetHome = path.join(root, `target-${variant}`);
      const target = path.join(targetHome, ".quotabar-win");
      const archivePath = path.join(root, `${variant}.zip`);
      await put(source, "settings.json", "{}");
      await put(target, "settings.json", "{\"costWindow\":\"7d\"}");
      await exportPortableData(source, archivePath);
      const staged = await stagePortableImport(archivePath, target, targetHome);
      const pendingPath = path.join(target, ".portable-import.pending.json");
      if (variant === "oversized") await writeFile(pendingPath, "x".repeat(64 * 1024 + 1), "utf8");
      else {
        const pending = JSON.parse(await readFile(pendingPath, "utf8"));
        if (variant === "extra") pending.extra = true;
        else if (variant === "reserved-name") {
          pending.backup.fileName = "CON.zip";
          await fsPromises.rename(staged.backupPath, path.join(path.dirname(staged.backupPath), "CON.zip"));
        } else pending.backup.expandedTotalBytes += 1;
        await writeFile(pendingPath, JSON.stringify(pending), "utf8");
      }
      let renames = 0;
      const rename: typeof fsPromises.rename = async (from, to) => {
        renames += 1;
        return fsPromises.rename(from, to);
      };

      await expect(applyPendingImport(target, { rename })).rejects.toThrow("Portable data apply failed");
      expect(renames).toBe(0);
      expect(await readFile(path.join(target, "settings.json"), "utf8")).toBe("{\"costWindow\":\"7d\"}");
    }
  });

  it("waits for both usage and quota store locks before taking an export snapshot", async () => {
    for (const managedRoot of ["usage", "quota"] as const) {
      const root = await tempRoot();
      const appDir = path.join(root, `.quotabar-${managedRoot}`);
      const archivePath = path.join(root, `${managedRoot}.zip`);
      const managedFile = managedRoot === "usage" ? "usage/events/2026-07.jsonl" : "quota/2026-07.jsonl";
      await put(appDir, managedFile, `${managedRoot}-data\n`);
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      let locked!: () => void;
      const acquired = new Promise<void>((resolve) => { locked = resolve; });
      const holder = withPortableRootLock(path.join(appDir, managedRoot), async () => {
        locked();
        await barrier;
      });
      await acquired;
      let completed = false;
      const exporting = exportPortableData(appDir, archivePath).then(() => { completed = true; });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(completed).toBe(false);
      release();
      await Promise.all([holder, exporting]);
      expect(new AdmZip(archivePath).getEntry(managedFile)!.getData().toString())
        .toBe(`${managedRoot}-data\n`);
    }
  });

  it("waits for both store locks before applying a pending import", async () => {
    for (const managedRoot of ["usage", "quota"] as const) {
      const root = await tempRoot();
      const source = path.join(root, "source", ".quotabar-win");
      const targetHome = path.join(root, `target-${managedRoot}`);
      const target = path.join(targetHome, ".quotabar-win");
      const archivePath = path.join(root, `${managedRoot}-apply.zip`);
      await put(source, "settings.json", "{\"costWindow\":\"7d\"}");
      await put(target, "settings.json", "{\"costWindow\":\"30d\"}");
      await exportPortableData(source, archivePath);
      await stagePortableImport(archivePath, target, targetHome);
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      let locked!: () => void;
      const acquired = new Promise<void>((resolve) => { locked = resolve; });
      const holder = withPortableRootLock(path.join(target, managedRoot), async () => {
        locked();
        await barrier;
      });
      await acquired;
      let completed = false;
      const applying = applyPendingImport(target).then(() => { completed = true; });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(completed).toBe(false);
      release();
      await Promise.all([holder, applying]);
      expect(JSON.parse(await readFile(path.join(target, "settings.json"), "utf8")).costWindow).toBe("7d");
    }
  });

  it("rejects adversarial entry metadata before getData or import artifacts", async () => {
    const cases: Array<{ name: string; entries: AdmZip.IZipEntry[] }> = [];
    let getDataCalls = 0;
    const tracked = (name: string, overrides?: Parameters<typeof fakeZipEntry>[1]) =>
      fakeZipEntry(name, overrides, () => { getDataCalls += 1; });
    cases.push(
      { name: "traversal", entries: [tracked("../auth.json")] },
      { name: "mixed path", entries: [tracked("usage\\events/x.jsonl")] },
      { name: "case duplicate", entries: [tracked("settings.json"), tracked("SETTINGS.json")] },
      { name: "file directory collision", entries: [tracked("usage/events"), tracked("usage/events/x.jsonl")] },
      { name: "oversized file", entries: [tracked("settings.json", { size: MAX_ARCHIVE_FILE_SIZE + 1 })] },
      { name: "ZIP64 sentinel", entries: [tracked("settings.json", { size: 0xffff_ffff })] },
      { name: "ZIP64 extra", entries: [tracked("settings.json", { extra: Buffer.from([1, 0, 0, 0]) })] },
      { name: "unexpected", entries: [tracked("auth.json")] },
    );
    cases.push({
      name: "expanded total",
      entries: Array.from({ length: 17 }, (_, index) => tracked(`usage/events/${index}.jsonl`, {
        size: MAX_ARCHIVE_FILE_SIZE,
        compressedSize: MAX_ARCHIVE_FILE_SIZE,
      })),
    });
    cases.push({
      name: "entry count",
      entries: Array.from({ length: MAX_ARCHIVE_ENTRIES + 1 }, (_, index) => tracked(`usage/events/${index}.jsonl`)),
    });

    for (const item of cases) {
      const root = await tempRoot();
      const targetHome = path.join(root, "target");
      const target = path.join(targetHome, ".quotabar-win");
      await put(target, "settings.json", "{}");
      getDataCalls = 0;
      let opened = false;
      await expect(stagePortableImport("unused.zip", target, targetHome, {
        openZip: () => { opened = true; return { getEntries: () => item.entries }; },
      }), item.name).rejects.toThrow("Portable data import failed");
      expect(opened, item.name).toBe(true);
      expect(getDataCalls, item.name).toBe(0);
      await expect(access(path.join(target, ".portable-import.pending.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(path.join(target, "usage"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(path.join(target, "quota"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(path.join(targetHome, "QuotaBar Backups"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fsPromises.readdir(targetHome)).filter((name) => name.includes("portable-import"))).toEqual([]);
    }
  });

  it("leaves a nonexistent target tree untouched when archive preflight fails", async () => {
    const root = await tempRoot();
    const targetHome = path.join(root, "empty-target");
    const target = path.join(targetHome, ".quotabar-win");
    let getDataCalls = 0;
    const malicious = fakeZipEntry("../escape.json", {}, () => { getDataCalls += 1; });

    await expect(stagePortableImport("unused.zip", target, targetHome, {
      openZip: () => ({ getEntries: () => [malicious] }),
    })).rejects.toThrow("Portable data import failed");
    expect(getDataCalls).toBe(0);
    expect(await fsPromises.readdir(root)).toEqual([]);
  });

  it("restores byte-exact originals for every managed apply rename failure position", async () => {
    for (let failurePosition = 1; failurePosition <= 6; failurePosition += 1) {
      const root = await tempRoot();
      const source = path.join(root, "source", ".quotabar-win");
      const targetHome = path.join(root, `target-${failurePosition}`);
      const target = path.join(targetHome, ".quotabar-win");
      const archivePath = path.join(root, `${failurePosition}.zip`);
      const originalSettings = "{\"costWindow\":\"30d\"}\n";
      const originalIngest = "{\"schemaVersion\":1,\"sources\":{\"original\":{\"size\":1,\"processedAt\":\"2026-01-01T00:00:00.000Z\"}}}\n";
      await put(source, "settings.json", "{\"costWindow\":\"7d\"}");
      await put(source, "usage/events/new.jsonl", "new-data\n");
      await put(target, "settings.json", originalSettings);
      await put(target, "usage/events/old.jsonl", "old-data\n");
      await put(target, "usage/ingest-state.json", originalIngest);
      await put(target, "quotabar.log", "keep-log");
      await put(target, "cache/prices.json", "keep-cache");
      await put(target, "debug/events.jsonl", "keep-debug");
      await exportPortableData(source, archivePath);
      await stagePortableImport(archivePath, target, targetHome);
      let position = 0;
      let injected = false;
      const rename: typeof fsPromises.rename = async (from, to) => {
        const managed = String(to).includes(".rollback") || String(from).includes("portable-import-");
        if (managed) position += 1;
        if (!injected && managed && position === failurePosition) {
          injected = true;
          throw new Error("injected apply rename failure");
        }
        return fsPromises.rename(from, to);
      };

      await expect(applyPendingImport(target, { rename })).rejects.toThrow("Portable data apply failed");
      expect(injected, `rename ${failurePosition}`).toBe(true);
      expect(await readFile(path.join(target, "settings.json"), "utf8")).toBe(originalSettings);
      expect(await readFile(path.join(target, "usage/events/old.jsonl"), "utf8")).toBe("old-data\n");
      expect(await readFile(path.join(target, "usage/ingest-state.json"), "utf8")).toBe(originalIngest);
      await expect(access(path.join(target, "usage/events/new.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path.join(target, "quotabar.log"), "utf8")).toBe("keep-log");
      expect(await readFile(path.join(target, "cache/prices.json"), "utf8")).toBe("keep-cache");
      expect(await readFile(path.join(target, "debug/events.jsonl"), "utf8")).toBe("keep-debug");
    }
  });

  it("retains pending recovery data and the sole original copy when rollback restoration fails", async () => {
    const root = await tempRoot();
    const source = path.join(root, "source", ".quotabar-win");
    const targetHome = path.join(root, "target-rollback-failure");
    const target = path.join(targetHome, ".quotabar-win");
    const archivePath = path.join(root, "rollback-failure.zip");
    await put(source, "settings.json", "{\"costWindow\":\"7d\"}");
    await put(source, "usage/events/new.jsonl", "new-data\n");
    await put(target, "settings.json", "original-settings\n");
    await put(target, "usage/events/old.jsonl", "old-data\n");
    await exportPortableData(source, archivePath);
    await stagePortableImport(archivePath, target, targetHome);
    const pendingPath = path.join(target, ".portable-import.pending.json");
    const pending = JSON.parse(await readFile(pendingPath, "utf8"));
    const rollbackDir = path.join(targetHome, pending.rollbackDirectory);
    const stagingDir = path.join(targetHome, pending.stagingDirectory);
    let managedPosition = 0;
    const rename: typeof fsPromises.rename = async (from, to) => {
      const managed = String(to).includes(".rollback") || String(from).includes("portable-import-");
      if (managed) managedPosition += 1;
      if (managedPosition === 4) throw new Error("primary failure");
      if (String(from).startsWith(rollbackDir) && String(from).endsWith("settings.json")) {
        throw new Error("rollback restoration failure");
      }
      return fsPromises.rename(from, to);
    };

    await expect(applyPendingImport(target, { rename })).rejects.toThrow("Portable data apply failed");
    await expect(access(pendingPath)).resolves.toBeUndefined();
    await expect(access(stagingDir)).resolves.toBeUndefined();
    expect(await readFile(path.join(rollbackDir, "settings.json"), "utf8")).toBe("original-settings\n");
  });

  it("stages, verifies, and applies with a private backup file larger than 64 MiB", async () => {
    const root = await tempRoot();
    const source = path.join(root, "source", ".quotabar-win");
    const targetHome = path.join(root, "target-large-backup");
    const target = path.join(targetHome, ".quotabar-win");
    const archivePath = path.join(root, "large-backup.zip");
    const largeLogPath = path.join(target, "debug", "large.log");
    const largeSize = MAX_ARCHIVE_FILE_SIZE + 1;
    await put(source, "settings.json", "{\"costWindow\":\"7d\"}");
    await put(target, "settings.json", "{\"costWindow\":\"30d\"}");
    await mkdir(path.dirname(largeLogPath), { recursive: true });
    await writeFile(largeLogPath, Buffer.alloc(largeSize, 0x61));
    await exportPortableData(source, archivePath);

    const staged = await stagePortableImport(archivePath, target, targetHome);
    expect(staged.backupPath).toContain("QuotaBar Backups");
    await expect(applyPendingImport(target)).resolves.toMatchObject({ applied: true });
    expect((await fsPromises.stat(largeLogPath)).size).toBe(largeSize);
  });
});

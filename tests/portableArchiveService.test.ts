import AdmZip from "adm-zip";
import * as fsPromises from "node:fs/promises";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArchiveManifest, verifyArchiveEntryBytes } from "../src/portable/archiveManifest";
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
});

import AdmZip from "adm-zip";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import {
  createArchiveManifest,
  isPortableArchivePath,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_FILE_SIZE,
  MAX_ARCHIVE_TOTAL_SIZE,
  metadataFromZipEntry,
  normalizeArchivePath,
  parseArchiveManifest,
  sanitizeImportedSettings,
  validateArchiveStructure,
  validateZipEntryMetadata,
  verifyArchiveEntryBytes,
  type ArchiveFileBytes,
  type ArchiveManifest,
} from "./archiveManifest";
import { withPortableRootLock } from "./rootLock";
import { PORTABLE_STORE_VERSION } from "./types";

const QUOTABAR_VERSION = "1.5.0";
const ARCHIVE_LOCK_DIR = ".portable-store.lock";
const TRANSIENT_LOCK_DIRS = new Set([ARCHIVE_LOCK_DIR, ".portable-ingestion.lock", ".portable-migration.lock"]);
const PENDING_FILE = ".portable-import.pending.json";
const PENDING_FORMAT = "QuotaBar/pending-import";
const PENDING_VERSION = 1;
const MAX_PENDING_SIZE = 64 * 1024;

export interface ArchiveOperationResult {
  path: string;
  fileCount: number;
  totalBytes: number;
}

export interface StagedImportResult extends ArchiveOperationResult {
  backupPath: string;
  pending: true;
}

export interface AppliedImportResult {
  applied: boolean;
  fileCount: number;
  totalBytes: number;
}

export interface ArchiveApplyDependencies {
  rename?: typeof fs.rename;
}

export interface ArchiveImportDependencies {
  openZip?: (zipPath: string) => Pick<AdmZip, "getEntries">;
}

interface SafeFile {
  path: string;
  data: Buffer;
}

interface PendingImport {
  format: typeof PENDING_FORMAT;
  formatVersion: typeof PENDING_VERSION;
  stagingDirectory: string;
  rollbackDirectory: string;
  backupFileName: string;
  manifest: ArchiveManifest;
  replacePaths: string[];
}

export async function exportPortableData(appDir: string, destinationZip: string): Promise<ArchiveOperationResult> {
  return genericFailure("Portable data export failed", () => withArchiveLocks(appDir, async () => {
    const partialPath = `${destinationZip}.partial`;
    await removeFileIfPresent(partialPath);
    try {
      await assertDestinationAvailable(destinationZip);
      const files = (await readAppFiles(appDir))
        .filter((file) => isPortableArchivePath(file.path) && file.path !== "manifest.json");
      const manifest = createArchiveManifest(files, { quotaBarVersion: QUOTABAR_VERSION });
      const zip = new AdmZip();
      for (const file of files) zip.addFile(file.path, file.data);
      zip.addFile("manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
      await fs.mkdir(path.dirname(destinationZip), { recursive: true });
      zip.writeZip(partialPath);
      await validatePortableZip(partialPath);
      await fs.rename(partialPath, destinationZip);
      return summarize(destinationZip, files);
    } catch {
      await removeFileIfPresent(partialPath);
      throw new Error("Portable data export failed");
    }
  }));
}

export async function createFullBackup(appDir: string, backupZip: string): Promise<ArchiveOperationResult> {
  return genericFailure("QuotaBar backup failed", () =>
    withArchiveLocks(appDir, async () => createFullBackupUnlocked(appDir, backupZip)));
}

export async function stagePortableImport(
  zipPath: string,
  appDir: string,
  targetHome: string,
  dependencies: ArchiveImportDependencies = {},
): Promise<StagedImportResult> {
  return genericFailure("Portable data import failed", () => withArchiveLocks(appDir, async () => {
    let stagingDir: string | undefined;
    try {
      await assertTargetHome(appDir, targetHome);
      await assertPendingMissing(appDir);
      const imported = await validatePortableZip(zipPath, dependencies.openZip);
      const stagedFiles = imported.map((file) => ({ ...file }));
      const settings = stagedFiles.find((file) => file.path === "settings.json");
      if (settings) {
        let parsed: unknown = {};
        try {
          parsed = JSON.parse(settings.data.toString("utf8"));
        } catch {
          parsed = {};
        }
        settings.data = Buffer.from(`${JSON.stringify(sanitizeImportedSettings(parsed, targetHome), null, 2)}\n`, "utf8");
      }
      const ingestState = Buffer.from(`${JSON.stringify({ schemaVersion: PORTABLE_STORE_VERSION, sources: {} }, null, 2)}\n`, "utf8");
      const stagedManifest = createArchiveManifest(stagedFiles, { quotaBarVersion: QUOTABAR_VERSION });
      const currentFiles = await readAppFiles(appDir);
      const replacePaths = new Set(
        currentFiles.filter((file) => isPortableArchivePath(file.path) && file.path !== "manifest.json").map((file) => file.path),
      );
      for (const file of stagedFiles) replacePaths.add(file.path);
      replacePaths.add("usage/ingest-state.json");

      const backupDirectory = path.join(path.dirname(appDir), "QuotaBar Backups");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupFileName = `QuotaBar-${stamp}-${randomUUID()}.zip`;
      const backupPath = path.join(backupDirectory, backupFileName);
      const backup = await createFullBackupUnlocked(appDir, backupPath);

      const stagingDirectory = `.${path.basename(appDir)}.portable-import-${randomUUID()}`;
      const rollbackDirectory = `${stagingDirectory}.rollback`;
      stagingDir = path.join(path.dirname(appDir), stagingDirectory);
      await fs.mkdir(stagingDir);
      for (const file of stagedFiles) await writeNewContainedFile(stagingDir, file.path, file.data);
      await writeNewContainedFile(stagingDir, "usage/ingest-state.json", ingestState);

      const pending: PendingImport = {
        format: PENDING_FORMAT,
        formatVersion: PENDING_VERSION,
        stagingDirectory,
        rollbackDirectory,
        backupFileName,
        manifest: stagedManifest,
        replacePaths: [...replacePaths].sort((left, right) => left.localeCompare(right, "en")),
      };
      await writePending(appDir, pending);
      return {
        path: zipPath,
        backupPath: backup.path,
        pending: true,
        fileCount: stagedFiles.length,
        totalBytes: stagedFiles.reduce((sum, file) => sum + file.data.byteLength, 0),
      };
    } catch {
      if (stagingDir) await removeOwnedTree(stagingDir);
      throw new Error("Portable data import failed");
    }
  }));
}

export async function applyPendingImport(
  appDir: string,
  dependencies: ArchiveApplyDependencies = {},
): Promise<AppliedImportResult> {
  const rename = dependencies.rename ?? fs.rename;
  return genericFailure("Portable data apply failed", () => withArchiveLocks(appDir, async () => {
    const pendingPath = path.join(appDir, PENDING_FILE);
    let raw: Buffer;
    try {
      const pendingInfo = await fs.lstat(pendingPath);
      if (!pendingInfo.isFile() || pendingInfo.isSymbolicLink() || pendingInfo.size > MAX_PENDING_SIZE) {
        throw new Error("Invalid pending import metadata");
      }
      raw = await readStableFile(pendingPath, pendingInfo.size);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { applied: false, fileCount: 0, totalBytes: 0 };
      // Pending metadata is local but can be tampered with; never attach parser or path details.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Portable data apply failed");
    }
    let pending: PendingImport;
    try {
      pending = parsePending(raw);
      const parent = path.dirname(appDir);
      await verifyReferencedBackup(appDir, pending);
      const stagingDir = safeSibling(parent, pending.stagingDirectory, `.${path.basename(appDir)}.portable-import-`);
      const rollbackDir = safeSibling(parent, pending.rollbackDirectory, `.${path.basename(appDir)}.portable-import-`);
      const staged = await validateStaging(stagingDir, appDir, pending.manifest);
      const stagedByPath = new Map(staged.map((file) => [file.path, file]));
      const ingestPath = "usage/ingest-state.json";
      const ingest = await readStagedOrAppliedFile(stagingDir, appDir, ingestPath);
      verifyFreshIngestState(ingest.data);
      stagedByPath.set(ingestPath, ingest);
      await ensureOwnedDirectory(rollbackDir);
      try {
        for (const relativePath of pending.replacePaths) {
          const imported = stagedByPath.get(relativePath);
          await applyOnePath(appDir, stagingDir, rollbackDir, relativePath, imported, rename);
        }
      } catch {
        await rollbackAll(appDir, stagingDir, rollbackDir, pending.replacePaths, stagedByPath, rename);
        throw new Error("apply");
      }
      await removeOwnedTree(rollbackDir);
      await removeOwnedTree(stagingDir);
      await fs.unlink(pendingPath);
      return {
        applied: true,
        fileCount: pending.manifest.entries.length,
        totalBytes: pending.manifest.entries.reduce((sum, entry) => sum + entry.size, 0),
      };
    } catch {
      throw new Error("Portable data apply failed");
    }
  }));
}

async function verifyReferencedBackup(appDir: string, pending: PendingImport): Promise<void> {
  const backupPath = path.join(path.dirname(appDir), "QuotaBar Backups", pending.backupFileName);
  await assertSafeBackupDestination(appDir, backupPath);
  const info = await fs.lstat(backupPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ARCHIVE_TOTAL_SIZE) {
    throw new Error("Invalid referenced backup");
  }
  const zip = new AdmZip(backupPath);
  const entries = zip.getEntries();
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error("Invalid referenced backup");
  const paths = new Set<string>();
  let totalSize = 0;
  for (const entry of entries) {
    const metadata = metadataFromZipEntry(entry);
    if (entry.isDirectory || metadata.size > MAX_ARCHIVE_FILE_SIZE || metadata.compressedSize > MAX_ARCHIVE_FILE_SIZE) {
      throw new Error("Invalid referenced backup");
    }
    const archivePath = normalizeArchivePath(entry.entryName);
    const canonical = archivePath.toLowerCase();
    if (paths.has(canonical)) throw new Error("Invalid referenced backup");
    paths.add(canonical);
    if (totalSize > MAX_ARCHIVE_TOTAL_SIZE - metadata.size) throw new Error("Invalid referenced backup");
    totalSize += metadata.size;
    const data = entry.getData();
    if (data.byteLength !== metadata.size) throw new Error("Invalid referenced backup");
  }
}

async function createFullBackupUnlocked(appDir: string, backupZip: string): Promise<ArchiveOperationResult> {
  const partialPath = `${backupZip}.partial`;
  let destinationApproved = false;
  try {
    await assertSafeBackupDestination(appDir, backupZip);
    destinationApproved = true;
    await removeFileIfPresent(partialPath);
    await assertDestinationAvailable(backupZip);
    const files = await readAppFiles(appDir);
    const zip = new AdmZip();
    for (const file of files) zip.addFile(file.path, file.data);
    await fs.mkdir(path.dirname(backupZip), { recursive: true });
    zip.writeZip(partialPath);
    verifyFullBackup(partialPath, files);
    await fs.rename(partialPath, backupZip);
    return summarize(backupZip, files);
  } catch {
    if (destinationApproved) await removeFileIfPresent(partialPath);
    throw new Error("QuotaBar backup failed");
  }
}

async function assertSafeBackupDestination(appDir: string, backupZip: string): Promise<void> {
  const appPath = canonicalFsPath(path.resolve(appDir));
  const destination = canonicalFsPath(path.resolve(backupZip));
  if (destination === appPath || destination.startsWith(`${appPath}${path.sep}`)) {
    throw new Error("Backup destination must be outside application data");
  }
  await assertNoReparseAncestors(path.dirname(path.resolve(backupZip)));
  try {
    const target = await fs.lstat(backupZip);
    if (target.isSymbolicLink()) throw new Error("Unsafe backup destination");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertNoReparseAncestors(directory: string): Promise<void> {
  let current = path.resolve(directory);
  while (true) {
    try {
      const info = await fs.lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe backup directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function canonicalFsPath(filePath: string): string {
  const normalized = path.normalize(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function validatePortableZip(
  zipPath: string,
  openZip: ArchiveImportDependencies["openZip"] = (archivePath) => new AdmZip(archivePath),
): Promise<SafeFile[]> {
  const zip = openZip(zipPath);
  const entries = zip.getEntries();
  const metadata = entries.map(metadataFromZipEntry);
  validateZipEntryMetadata(metadata);
  const manifestEntry = entries.find((entry) => entry.entryName === "manifest.json");
  if (!manifestEntry) throw new Error("Archive must contain exactly one manifest");
  const manifest = parseArchiveManifest(readValidatedCompressedEntry(manifestEntry));
  validateArchiveStructure(metadata, manifest);
  const manifestByPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const files: SafeFile[] = [];
  for (const entry of entries) {
    const data = entry.getData();
    if (entry.entryName === "manifest.json") continue;
    const expected = manifestByPath.get(entry.entryName);
    if (!expected) throw new Error("Archive contents do not match manifest");
    verifyArchiveEntryBytes(expected, data);
    files.push({ path: entry.entryName, data: Buffer.from(data) });
  }
  return files;
}

function readValidatedCompressedEntry(entry: AdmZip.IZipEntry): Buffer {
  const compressed = entry.getCompressedData();
  const data = entry.header.method === 0
    ? Buffer.from(compressed)
    : inflateRawSync(compressed, { maxOutputLength: entry.header.size });
  if (data.byteLength !== entry.header.size) throw new Error("Archive entry size does not match header");
  return data;
}

function parsePending(input: Uint8Array): PendingImport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(input).toString("utf8"));
  } catch {
    throw new Error("Invalid pending import");
  }
  if (!isRecord(parsed)
    || !hasExactKeys(parsed, [
      "format", "formatVersion", "stagingDirectory", "rollbackDirectory", "backupFileName", "manifest", "replacePaths",
    ])
    || parsed.format !== PENDING_FORMAT
    || parsed.formatVersion !== PENDING_VERSION
    || typeof parsed.stagingDirectory !== "string"
    || typeof parsed.rollbackDirectory !== "string"
    || typeof parsed.backupFileName !== "string"
    || !Array.isArray(parsed.replacePaths)) {
    throw new Error("Invalid pending import");
  }
  const manifest = parseArchiveManifest(Buffer.from(JSON.stringify(parsed.manifest), "utf8"));
  const replacePaths = parsed.replacePaths.map((value) => {
    if (typeof value !== "string") throw new Error("Invalid pending import");
    const normalized = normalizeArchivePath(value);
    if (normalized !== value || (value !== "usage/ingest-state.json" && !isPortableArchivePath(value))) {
      throw new Error("Invalid pending import");
    }
    return value;
  });
  const canonical = replacePaths.map((value) => value.toLowerCase());
  if (new Set(canonical).size !== canonical.length
    || replacePaths.some((value, index) => index > 0 && replacePaths[index - 1].localeCompare(value, "en") >= 0)) {
    throw new Error("Invalid pending import");
  }
  const replacePathSet = new Set(replacePaths);
  if (!replacePathSet.has("usage/ingest-state.json")
    || manifest.entries.some((entry) => !replacePathSet.has(entry.path))
    || parsed.rollbackDirectory !== `${parsed.stagingDirectory}.rollback`) {
    throw new Error("Invalid pending import");
  }
  if (!/^[A-Za-z0-9._-]+\.zip$/.test(parsed.backupFileName)
    || path.basename(parsed.backupFileName) !== parsed.backupFileName
    || normalizeArchivePath(parsed.backupFileName) !== parsed.backupFileName) {
    throw new Error("Invalid pending import");
  }
  return {
    format: PENDING_FORMAT,
    formatVersion: PENDING_VERSION,
    stagingDirectory: parsed.stagingDirectory,
    rollbackDirectory: parsed.rollbackDirectory,
    backupFileName: parsed.backupFileName,
    manifest,
    replacePaths,
  };
}

async function validateStaging(stagingDir: string, liveDir: string, manifest: ArchiveManifest): Promise<SafeFile[]> {
  await assertDirectory(stagingDir);
  const files = await readAppFiles(stagingDir);
  const expectedPaths = new Set([...manifest.entries.map((entry) => entry.path), "usage/ingest-state.json"]);
  if (files.some((file) => !expectedPaths.has(file.path))) {
    throw new Error("Invalid staged import");
  }
  const byPath = new Map(files.map((file) => [file.path, file]));
  const validated: SafeFile[] = [];
  for (const entry of manifest.entries) {
    const file = byPath.get(entry.path) ?? await readRequiredSafeFile(liveDir, entry.path);
    verifyArchiveEntryBytes(entry, file.data);
    validated.push(file);
  }
  return validated;
}

async function applyOnePath(
  appDir: string,
  stagingDir: string,
  rollbackDir: string,
  relativePath: string,
  imported: SafeFile | undefined,
  rename: typeof fs.rename,
): Promise<void> {
  const livePath = containedPath(appDir, relativePath);
  const stagedPath = containedPath(stagingDir, relativePath);
  const rollbackPath = containedPath(rollbackDir, relativePath);
  const liveExists = await safeRegularFileExists(livePath);
  const stagedExists = await safeRegularFileExists(stagedPath);
  const rollbackExists = await safeRegularFileExists(rollbackPath);

  if (imported && !stagedExists && liveExists) {
    const live = await readStableFile(livePath, (await fs.lstat(livePath)).size);
    if (live.equals(imported.data)) return;
    throw new Error("Invalid interrupted import state");
  }
  if (rollbackExists && !stagedExists && !imported) {
    if (liveExists) throw new Error("Invalid interrupted import state");
    return;
  }
  if (!rollbackExists && liveExists) {
    await ensureSafeParents(rollbackDir, relativePath);
    await rename(livePath, rollbackPath);
  } else if (rollbackExists && liveExists) {
    throw new Error("Invalid interrupted import state");
  }
  if (imported) {
    if (!stagedExists) throw new Error("Invalid interrupted import state");
    await ensureSafeParents(appDir, relativePath);
    await rename(stagedPath, livePath);
  }
}

async function rollbackAll(
  appDir: string,
  stagingDir: string,
  rollbackDir: string,
  paths: readonly string[],
  stagedByPath: ReadonlyMap<string, SafeFile>,
  rename: typeof fs.rename,
): Promise<void> {
  let rollbackError: unknown;
  for (const relativePath of [...paths].reverse()) {
    try {
      const livePath = containedPath(appDir, relativePath);
      const stagedPath = containedPath(stagingDir, relativePath);
      const rollbackPath = containedPath(rollbackDir, relativePath);
      const imported = stagedByPath.get(relativePath);
      const liveExists = await safeRegularFileExists(livePath);
      const stagedExists = await safeRegularFileExists(stagedPath);
      if (imported && liveExists && !stagedExists) {
        const live = await readStableFile(livePath, (await fs.lstat(livePath)).size);
        if (!live.equals(imported.data)) throw new Error("Unexpected live data during rollback");
        await ensureSafeParents(stagingDir, relativePath);
        await rename(livePath, stagedPath);
      }
      if (await safeRegularFileExists(rollbackPath)) {
        if (await safeRegularFileExists(livePath)) throw new Error("Live target occupied during rollback");
        await ensureSafeParents(appDir, relativePath);
        await rename(rollbackPath, livePath);
      }
    } catch (error) {
      rollbackError ??= error;
    }
  }
  if (rollbackError) throw new Error("Portable data rollback failed");
}

async function writePending(appDir: string, pending: PendingImport): Promise<void> {
  const pendingPath = path.join(appDir, PENDING_FILE);
  const temporaryPath = `${pendingPath}.${randomUUID()}.tmp`;
  const data = Buffer.from(`${JSON.stringify(pending, null, 2)}\n`, "utf8");
  const handle = await fs.open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporaryPath, pendingPath);
  } catch (error) {
    await removeFileIfPresent(temporaryPath);
    throw error;
  }
}

async function writeNewContainedFile(root: string, relativePath: string, data: Uint8Array): Promise<void> {
  await ensureSafeParents(root, relativePath);
  const target = containedPath(root, relativePath);
  const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureSafeParents(root: string, relativePath: string): Promise<void> {
  const normalized = normalizeArchivePath(relativePath);
  const segments = normalized.split("/").slice(0, -1);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const info = await fs.lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe archive target directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(current);
    }
  }
}

function containedPath(root: string, relativePath: string): string {
  const normalized = normalizeArchivePath(relativePath);
  if (normalized !== relativePath) throw new Error("Invalid archive path");
  const candidate = path.resolve(root, ...normalized.split("/"));
  assertContained(path.resolve(root), candidate);
  return candidate;
}

async function readRequiredSafeFile(root: string, relativePath: string): Promise<SafeFile> {
  const target = containedPath(root, relativePath);
  const info = await fs.lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid staged file");
  return { path: relativePath, data: await readStableFile(target, info.size) };
}

async function readStagedOrAppliedFile(stagingDir: string, liveDir: string, relativePath: string): Promise<SafeFile> {
  try {
    return await readRequiredSafeFile(stagingDir, relativePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return readRequiredSafeFile(liveDir, relativePath);
  }
}

function verifyFreshIngestState(data: Uint8Array): void {
  try {
    const parsed = JSON.parse(Buffer.from(data).toString("utf8"));
    if (!isRecord(parsed) || !hasExactKeys(parsed, ["schemaVersion", "sources"])
      || parsed.schemaVersion !== PORTABLE_STORE_VERSION || !isRecord(parsed.sources)
      || Object.keys(parsed.sources).length !== 0) {
      throw new Error("shape");
    }
  } catch {
    throw new Error("Invalid staged ingest state");
  }
}

async function assertTargetHome(appDir: string, targetHome: string): Promise<void> {
  const appReal = await fs.realpath(appDir);
  const homeReal = await fs.realpath(targetHome);
  assertContained(homeReal, appReal);
}

async function assertPendingMissing(appDir: string): Promise<void> {
  try {
    await fs.lstat(path.join(appDir, PENDING_FILE));
    throw new Error("Pending import already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function safeSibling(parent: string, name: string, prefix: string): string {
  if (path.basename(name) !== name || !name.startsWith(prefix) || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error("Invalid pending import path");
  }
  const result = path.resolve(parent, name);
  assertContained(path.resolve(parent), result);
  return result;
}

async function safeRegularFileExists(filePath: string): Promise<boolean> {
  try {
    const info = await fs.lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe managed import path");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function removeOwnedTree(directory: string): Promise<void> {
  try {
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe import work directory");
    await fs.rm(directory, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function ensureOwnedDirectory(directory: string): Promise<void> {
  try {
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe import work directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.mkdir(directory);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function verifyFullBackup(zipPath: string, expectedFiles: readonly SafeFile[]): void {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  if (entries.length !== expectedFiles.length) throw new Error("Backup verification failed");
  const expected = new Map(expectedFiles.map((file) => [file.path, file]));
  for (const entry of entries) {
    const archivePath = normalizeArchivePath(entry.entryName);
    if (archivePath !== entry.entryName || entry.isDirectory) throw new Error("Backup verification failed");
    const metadata = metadataFromZipEntry(entry);
    if (metadata.size < 0 || metadata.compressedSize < 0) throw new Error("Backup verification failed");
    const source = expected.get(archivePath);
    if (!source) throw new Error("Backup verification failed");
    const data = entry.getData();
    if (!data.equals(source.data)) throw new Error("Backup verification failed");
    expected.delete(archivePath);
  }
  if (expected.size !== 0) throw new Error("Backup verification failed");
}

async function readAppFiles(appDir: string): Promise<SafeFile[]> {
  await assertDirectory(appDir);
  const rootReal = await fs.realpath(appDir);
  const result: SafeFile[] = [];
  await walk(appDir, "", rootReal, result);
  result.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return result;
}

async function walk(directory: string, relativeDirectory: string, rootReal: string, output: SafeFile[]): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (TRANSIENT_LOCK_DIRS.has(entry.name)) continue;
    const relativePath = normalizeArchivePath(relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name);
    const absolutePath = path.join(directory, entry.name);
    const info = await fs.lstat(absolutePath);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
      throw new Error("Unsupported application data entry");
    }
    const resolved = await fs.realpath(absolutePath);
    assertContained(rootReal, resolved);
    if (info.isDirectory()) {
      await walk(absolutePath, relativePath, rootReal, output);
    } else {
      output.push({ path: relativePath, data: await readStableFile(absolutePath, info.size) });
    }
  }
}

async function readStableFile(filePath: string, expectedSize: number): Promise<Buffer> {
  const handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== expectedSize) throw new Error("Application data changed during archive operation");
    const data = await handle.readFile();
    const after = await handle.stat();
    if (data.byteLength !== before.size
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs) {
      throw new Error("Application data changed during archive operation");
    }
    return data;
  } finally {
    await handle.close();
  }
}

async function assertDirectory(directory: string): Promise<void> {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid application data directory");
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) return;
  throw new Error("Application data escapes its root");
}

async function assertDestinationAvailable(destination: string): Promise<void> {
  try {
    await fs.lstat(destination);
    throw new Error("Archive destination already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function removeFileIfPresent(filePath: string): Promise<void> {
  try {
    const info = await fs.lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe partial archive path");
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function withArchiveLocks<T>(appDir: string, operation: () => Promise<T>): Promise<T> {
  await assertDirectory(appDir);
  // Global order: app -> usage -> quota. Store writers acquire only their own leaf lock.
  return withPortableRootLock(appDir, () =>
    withPortableRootLock(path.join(appDir, "usage"), () =>
      withPortableRootLock(path.join(appDir, "quota"), operation)));
}

async function genericFailure<T>(message: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error(message);
  }
}

function summarize(outputPath: string, files: readonly ArchiveFileBytes[]): ArchiveOperationResult {
  return {
    path: outputPath,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.data.byteLength, 0),
  };
}

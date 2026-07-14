import AdmZip from "adm-zip";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { inflateRawSync } from "node:zlib";
import CRC32 from "crc-32";
import * as yauzl from "yauzl";
import { ZipFile as YazlZipFile } from "yazl";
import {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  createArchiveManifest,
  isPortableArchivePath,
  metadataFromZipEntry,
  normalizeArchivePath,
  parseArchiveManifest,
  sanitizeImportedSettings,
  validateArchiveStructure,
  validateZipEntryMetadata,
  verifyArchiveEntryBytes,
  type ArchiveManifest,
  type ArchiveManifestEntry,
} from "./archiveManifest";
import { withNamedPortableRootLock, withPortableRootLock } from "./rootLock";
import { PORTABLE_STORE_VERSION } from "./types";
import {
  MAX_COMPRESSED_PORTABLE_ARCHIVE_SIZE,
  preflightPortableZip,
  type StreamingPortablePreflight,
} from "./streamingZip";

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

export type PortableImportRollbackOutcome = "completed" | "pending-recovery" | "not-attempted";

export class PortableImportApplyError extends Error {
  constructor(public readonly rollbackOutcome: PortableImportRollbackOutcome) {
    super("Portable data apply failed");
    this.name = "PortableImportApplyError";
  }
}

export interface ArchiveApplyDependencies {
  rename?: typeof fs.rename;
  removeTree?: (directory: string) => Promise<void>;
  unlinkPending?: (filePath: string) => Promise<void>;
  pendingWriteCheckpoint?: (checkpoint: PendingWriteCheckpoint) => Promise<void>;
}

export type PendingWriteCheckpoint = "before-temp-write" | "after-temp-write" | "after-temp-fsync" | "after-rename";

export interface ArchiveImportDependencies {
  openZip?: (zipPath: string) => Pick<AdmZip, "getEntries">;
  skipSourceIdentity?: boolean;
  onStreamChunk?: (entryPath: string, bytes: number) => void;
}

export interface ArchiveExportDependencies {
  maximumArchiveBytes?: number;
}

export interface ArchiveBackupDependencies {
  afterSnapshot?: () => Promise<void>;
  beforeVerification?: () => Promise<void>;
  forceZip64Format?: boolean;
  onWriterPolicy?: (policy: BackupWriterPolicy) => void;
}

export interface BackupWriterPolicy {
  maximumArchiveBytes: number | undefined;
  forceZip64Format: boolean;
}

interface SafeFile {
  path: string;
  data: Buffer;
}

interface PreparedPortableFile {
  path: string;
  size: number;
  sha256: string;
  data?: Buffer;
  temporaryPath?: string;
}

interface SnapshotFile {
  path: string;
  absolutePath: string;
  size: number;
  sha256: string;
}

interface FileIdentity {
  size: number;
  sha256: string;
}

interface PendingImport {
  format: typeof PENDING_FORMAT;
  formatVersion: typeof PENDING_VERSION;
  phase: "prepared" | "applying" | "rolling-back" | "committed" | "aborted";
  stagingDirectory: string;
  rollbackDirectory: string;
  backup: PendingBackup;
  manifest: ArchiveManifest;
  stagedEntries: ArchiveManifestEntry[];
  replacePaths: string[];
}

interface PendingBackup {
  fileName: string;
  archiveSize: number;
  sha256: string;
  entryCount: number;
  expandedTotalBytes: number;
}

export async function exportPortableData(
  appDir: string,
  destinationZip: string,
  dependencies: ArchiveExportDependencies = {},
): Promise<ArchiveOperationResult> {
  return genericFailure("Portable data export failed", () => withArchiveLocks(appDir, async () => {
    const partialPath = `${destinationZip}.partial`;
    await removeFileIfPresent(partialPath);
    try {
      await assertDestinationAvailable(destinationZip);
      const files = (await snapshotAppFiles(appDir))
        .filter((file) => isPortableArchivePath(file.path) && file.path !== "manifest.json");
      const manifest = manifestFromSnapshots(files);
      await fs.mkdir(path.dirname(destinationZip), { recursive: true });
      await writeStreamingZip(
        partialPath,
        files,
        Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
        dependencies.maximumArchiveBytes ?? MAX_COMPRESSED_PORTABLE_ARCHIVE_SIZE,
        false,
        false,
      );
      await verifySnapshotFiles(files);
      const verified = await preflightPortableZip(partialPath);
      await verified.cleanup();
      await fs.rename(partialPath, destinationZip);
      return summarizeSnapshots(destinationZip, files);
    } catch {
      await removeFileIfPresent(partialPath);
      throw new Error("Portable data export failed");
    }
  }));
}

export async function createFullBackup(
  appDir: string,
  backupZip: string,
  dependencies: ArchiveBackupDependencies = {},
): Promise<ArchiveOperationResult> {
  return genericFailure("QuotaBar backup failed", () =>
    withArchiveLocks(appDir, async () => createFullBackupUnlocked(appDir, backupZip, dependencies)));
}

export async function stagePortableImport(
  zipPath: string,
  appDir: string,
  targetHome: string,
  dependencies: ArchiveImportDependencies = {},
): Promise<StagedImportResult> {
  return genericFailure("Portable data import failed", async () => {
    let streaming: StreamingPortablePreflight | undefined;
    const sourceIdentity = dependencies.openZip && !dependencies.skipSourceIdentity
      ? await fileIdentity(zipPath, MAX_COMPRESSED_PORTABLE_ARCHIVE_SIZE)
      : undefined;
    const stagedFiles: PreparedPortableFile[] = dependencies.openZip
      ? (await validatePortableZip(zipPath, dependencies.openZip)).map((file) => ({
        path: file.path,
        size: file.data.byteLength,
        sha256: sha256Bytes(file.data),
        data: file.data,
      }))
      : ((streaming = await preflightPortableZip(zipPath, { onStreamChunk: dependencies.onStreamChunk })), streaming.files.map((file) => ({
        path: file.path,
        size: file.size,
        sha256: file.sha256,
        temporaryPath: file.temporaryPath,
      })));
    if (sourceIdentity) await assertFileIdentity(zipPath, sourceIdentity);
    try {
      return await withArchiveLocks(appDir, async () => {
    let stagingDir: string | undefined;
    try {
      if (streaming) await streaming.verifySourceIdentity();
      else if (sourceIdentity) await assertFileIdentity(zipPath, sourceIdentity);
      await assertTargetHome(appDir, targetHome);
      await assertPendingMissing(appDir);
      const settings = stagedFiles.find((file) => file.path === "settings.json");
      if (settings) {
        let parsed: unknown = {};
        try {
          parsed = JSON.parse((await preparedFileData(settings)).toString("utf8"));
        } catch {
          parsed = {};
        }
        settings.data = Buffer.from(`${JSON.stringify(sanitizeImportedSettings(parsed, targetHome), null, 2)}\n`, "utf8");
        settings.temporaryPath = undefined;
        settings.size = settings.data.byteLength;
        settings.sha256 = sha256Bytes(settings.data);
      }
      const ingestState = Buffer.from(`${JSON.stringify({ schemaVersion: PORTABLE_STORE_VERSION, sources: {} }, null, 2)}\n`, "utf8");
      const stagedManifest = streaming
        ? { ...streaming.manifest, entries: stagedFiles.map(({ path: filePath, size, sha256 }) => ({ path: filePath, size, sha256 }))
          .sort((left, right) => left.path.localeCompare(right.path, "en")) }
        : createArchiveManifest(stagedFiles.map((file) => ({ path: file.path, data: file.data! })), {
          quotaBarVersion: QUOTABAR_VERSION,
        });
      const currentFiles = await snapshotAppFiles(appDir);
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
      const backupIdentity = await fileIdentity(backup.path);

      const stagingDirectory = `.${path.basename(appDir)}.portable-import-${randomUUID()}`;
      const rollbackDirectory = `${stagingDirectory}.rollback`;
      stagingDir = path.join(path.dirname(appDir), stagingDirectory);
      await fs.mkdir(stagingDir);
      for (const file of stagedFiles) await writePreparedFile(stagingDir, file);
      await writeNewContainedFile(stagingDir, "usage/ingest-state.json", ingestState);

      const pending: PendingImport = {
        format: PENDING_FORMAT,
        formatVersion: PENDING_VERSION,
        phase: "prepared",
        stagingDirectory,
        rollbackDirectory,
        backup: {
          fileName: backupFileName,
          archiveSize: backupIdentity.size,
          sha256: backupIdentity.sha256,
          entryCount: backup.fileCount,
          expandedTotalBytes: backup.totalBytes,
        },
        manifest: stagedManifest,
        stagedEntries: [
          ...stagedManifest.entries,
          { path: "usage/ingest-state.json", size: ingestState.byteLength, sha256: sha256Bytes(ingestState) },
        ].sort((left, right) => left.path.localeCompare(right.path, "en")),
        replacePaths: [...replacePaths].sort((left, right) => left.localeCompare(right, "en")),
      };
      await writePending(appDir, pending);
      return {
        path: zipPath,
        backupPath: backup.path,
        pending: true,
        fileCount: stagedFiles.length,
        totalBytes: stagedFiles.reduce((sum, file) => sum + file.size, 0),
      };
    } catch {
      if (stagingDir) await removeOwnedTree(stagingDir);
      throw new Error("Portable data import failed");
    }
      });
    } finally {
      await streaming?.cleanup();
    }
  });
}

export async function applyPendingImport(
  appDir: string,
  dependencies: ArchiveApplyDependencies = {},
): Promise<AppliedImportResult> {
  const rename = dependencies.rename ?? fs.rename;
  const removeTree = dependencies.removeTree ?? removeOwnedTree;
  const unlinkPending = dependencies.unlinkPending ?? fs.unlink;
  let applyStarted = false;
  try {
    return await withArchiveLocks(appDir, async () => {
    const pendingPath = path.join(appDir, PENDING_FILE);
    let raw: Buffer;
    try {
      await cleanupPendingTemps(appDir);
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
      if (pending.phase === "aborted") {
        applyStarted = true;
        await removeTree(rollbackDir);
        await removeTree(stagingDir);
        await unlinkPendingDurably(pendingPath, unlinkPending);
        return { applied: false, fileCount: 0, totalBytes: 0 };
      }
      if (pending.phase === "rolling-back") {
        applyStarted = true;
        const stagedByPath = new Map(pending.stagedEntries.map((entry) => [entry.path, entry]));
        const aborted = await finishPendingRollback(
          appDir, stagingDir, rollbackDir, pendingPath, pending, stagedByPath,
          rename, removeTree, unlinkPending, dependencies.pendingWriteCheckpoint,
        );
        if (aborted) return { applied: false, fileCount: 0, totalBytes: 0 };
      }
      if (pending.phase === "committed") {
        applyStarted = true;
        await verifyCommittedLive(appDir, pending.stagedEntries);
        await removeTree(rollbackDir);
        await removeTree(stagingDir);
        await unlinkPendingDurably(pendingPath, unlinkPending);
        return {
          applied: true,
          fileCount: pending.manifest.entries.length,
          totalBytes: pending.manifest.entries.reduce((sum, entry) => sum + entry.size, 0),
        };
      }
      const staged = await validateStaging(stagingDir, appDir, pending.stagedEntries);
      const stagedByPath = new Map(staged.map((entry) => [entry.path, entry]));
      const ingestPath = "usage/ingest-state.json";
      const ingest = await readStagedOrAppliedFile(stagingDir, appDir, ingestPath);
      verifyFreshIngestState(ingest.data);
      await ensureOwnedDirectory(rollbackDir);
      await updatePendingPhase(appDir, pendingPath, pending, "applying", dependencies.pendingWriteCheckpoint);
      applyStarted = true;
      try {
        for (const relativePath of pending.replacePaths) {
          const imported = stagedByPath.get(relativePath);
          await applyOnePath(appDir, stagingDir, rollbackDir, relativePath, imported, rename);
        }
        await verifyCommittedLive(appDir, pending.stagedEntries);
      } catch {
        try {
          await updatePendingPhase(appDir, pendingPath, pending, "rolling-back", dependencies.pendingWriteCheckpoint);
          await finishPendingRollback(
            appDir, stagingDir, rollbackDir, pendingPath, pending, stagedByPath,
            rename, removeTree, unlinkPending, dependencies.pendingWriteCheckpoint,
          );
        } catch {
          throw new PortableImportApplyError("pending-recovery");
        }
        throw new PortableImportApplyError("completed");
      }
      await updatePendingPhase(appDir, pendingPath, pending, "committed", dependencies.pendingWriteCheckpoint);
      await removeTree(rollbackDir);
      await removeTree(stagingDir);
      await unlinkPendingDurably(pendingPath, unlinkPending);
      return {
        applied: true,
        fileCount: pending.manifest.entries.length,
        totalBytes: pending.manifest.entries.reduce((sum, entry) => sum + entry.size, 0),
      };
    } catch (error) {
      if (error instanceof PortableImportApplyError) throw error;
      throw new PortableImportApplyError(applyStarted ? "pending-recovery" : "not-attempted");
    }
    });
  } catch (error) {
    if (error instanceof PortableImportApplyError) throw error;
    throw new PortableImportApplyError(applyStarted ? "pending-recovery" : "not-attempted");
  }
}

async function verifyReferencedBackup(appDir: string, pending: PendingImport): Promise<void> {
  const backupPath = path.join(path.dirname(appDir), "QuotaBar Backups", pending.backup.fileName);
  await assertSafeBackupDestination(appDir, backupPath);
  await verifyBackupArchive(backupPath, pending.backup);
}

async function verifyBackupArchive(
  backupPath: string,
  expected: PendingBackup,
  expectedFiles?: readonly SnapshotFile[],
): Promise<void> {
  const info = await fs.lstat(backupPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== expected.archiveSize) {
    throw new Error("Invalid referenced backup");
  }
  const handle = await fs.open(backupPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await fileIdentityFromHandle(handle);
    assertIdentityMatches(before, expected);
    await verifyBackupEntriesFromFd(handle.fd, expected, expectedFiles);
    const after = await fileIdentityFromHandle(handle);
    assertIdentityMatches(after, expected);
  } finally {
    await handle.close();
  }
}

function verifyBackupEntriesFromFd(
  fd: number,
  expected: PendingBackup,
  expectedFiles?: readonly SnapshotFile[],
): Promise<void> {
  const expectedByPath = expectedFiles ? new Map(expectedFiles.map((file) => [file.path, file])) : undefined;
  return new Promise((resolve, reject) => {
    yauzl.fromFd(fd, {
      autoClose: false,
      decodeStrings: true,
      lazyEntries: true,
      strictFileNames: true,
      validateEntrySizes: true,
    }, (openError, zip) => {
      if (openError) return reject(openError);
      if (zip.entryCount !== expected.entryCount) {
        return reject(new Error("Invalid referenced backup"));
      }
      const paths = new Set<string>();
      let totalSize = 0;
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      zip.on("error", fail);
      zip.on("entry", (entry: yauzl.Entry) => {
        try {
          if (entry.fileName.endsWith("/")
            || entry.isEncrypted()
            || !isSafeNonNegativeInteger(entry.uncompressedSize)
            || !isSafeNonNegativeInteger(entry.compressedSize)) {
            throw new Error("Invalid referenced backup");
          }
          const archivePath = normalizeArchivePath(entry.fileName);
          const canonical = archivePath.toLowerCase();
          if (paths.has(canonical)) throw new Error("Invalid referenced backup");
          paths.add(canonical);
          if (totalSize > Number.MAX_SAFE_INTEGER - entry.uncompressedSize) throw new Error("Invalid referenced backup");
          totalSize += entry.uncompressedSize;
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) return fail(streamError);
            let expanded = 0;
            let crc = 0;
            const hash = createHash("sha256");
            stream.on("data", (chunk: Buffer) => {
              expanded += chunk.byteLength;
              crc = CRC32.buf(chunk, crc);
              hash.update(chunk);
              if (expanded > entry.uncompressedSize) stream.destroy(new Error("Invalid referenced backup"));
            });
            stream.once("error", fail);
            stream.once("end", () => {
              if (expanded !== entry.uncompressedSize || (crc >>> 0) !== (entry.crc32 >>> 0)) {
                return fail(new Error("Invalid referenced backup"));
              }
              const expectedFile = expectedByPath?.get(archivePath);
              if (expectedByPath && (!expectedFile || expectedFile.size !== expanded || expectedFile.sha256 !== hash.digest("hex"))) {
                return fail(new Error("Invalid referenced backup"));
              }
              zip.readEntry();
            });
          });
        } catch (error) {
          fail(error);
        }
      });
      zip.on("end", () => {
        if (settled) return;
        if (totalSize !== expected.expandedTotalBytes || paths.size !== expected.entryCount) {
          return fail(new Error("Invalid referenced backup"));
        }
        settled = true;
        resolve();
      });
      zip.readEntry();
    });
  });
}

function assertIdentityMatches(actual: FileIdentity, expected: Pick<PendingBackup, "archiveSize" | "sha256">): void {
  if (actual.size !== expected.archiveSize || actual.sha256 !== expected.sha256) {
    throw new Error("Invalid referenced backup");
  }
}

async function createFullBackupUnlocked(
  appDir: string,
  backupZip: string,
  dependencies: ArchiveBackupDependencies = {},
): Promise<ArchiveOperationResult> {
  const partialPath = `${backupZip}.partial`;
  let destinationApproved = false;
  try {
    await assertSafeBackupDestination(appDir, backupZip);
    destinationApproved = true;
    await removeFileIfPresent(partialPath);
    await assertDestinationAvailable(backupZip);
    const files = await snapshotAppFiles(appDir);
    await dependencies.afterSnapshot?.();
    await fs.mkdir(path.dirname(backupZip), { recursive: true });
    const selectedPolicy = privateBackupWriterPolicy(files);
    const writerPolicy = {
      ...selectedPolicy,
      forceZip64Format: dependencies.forceZip64Format ?? selectedPolicy.forceZip64Format,
    };
    dependencies.onWriterPolicy?.(writerPolicy);
    await writeStreamingZip(
      partialPath,
      files,
      undefined,
      writerPolicy.maximumArchiveBytes,
      writerPolicy.forceZip64Format,
    );
    await dependencies.beforeVerification?.();
    await verifySnapshotFiles(files);
    const identity = await fileIdentity(partialPath);
    await verifyBackupArchive(partialPath, {
      fileName: path.basename(backupZip),
      archiveSize: identity.size,
      sha256: identity.sha256,
      entryCount: files.length,
      expandedTotalBytes: files.reduce((sum, file) => sum + file.size, 0),
    }, files);
    await fs.rename(partialPath, backupZip);
    return summarizeSnapshots(backupZip, files);
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
      "format", "formatVersion", "phase", "stagingDirectory", "rollbackDirectory", "backup", "manifest", "stagedEntries", "replacePaths",
    ])
    || parsed.format !== PENDING_FORMAT
    || parsed.formatVersion !== PENDING_VERSION
    || !["prepared", "applying", "rolling-back", "committed", "aborted"].includes(String(parsed.phase))
    || typeof parsed.stagingDirectory !== "string"
    || typeof parsed.rollbackDirectory !== "string"
    || !isRecord(parsed.backup)
    || !Array.isArray(parsed.stagedEntries)
    || !Array.isArray(parsed.replacePaths)) {
    throw new Error("Invalid pending import");
  }
  const manifest = parseArchiveManifest(Buffer.from(JSON.stringify(parsed.manifest), "utf8"));
  const backup = parsePendingBackup(parsed.backup);
  const stagedEntries = parseStagedEntries(parsed.stagedEntries, manifest);
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
  return {
    format: PENDING_FORMAT,
    formatVersion: PENDING_VERSION,
    phase: parsed.phase as PendingImport["phase"],
    stagingDirectory: parsed.stagingDirectory,
    rollbackDirectory: parsed.rollbackDirectory,
    backup,
    manifest,
    stagedEntries,
    replacePaths,
  };
}

function parseStagedEntries(values: unknown[], manifest: ArchiveManifest): ArchiveManifestEntry[] {
  const entries = values.map((value) => {
    if (!isRecord(value) || !hasExactKeys(value, ["path", "size", "sha256"])
      || typeof value.path !== "string"
      || (value.path !== "usage/ingest-state.json" && !isPortableArchivePath(value.path))
      || normalizeArchivePath(value.path) !== value.path
      || !isSafeNonNegativeInteger(value.size)
      || typeof value.sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(value.sha256)) {
      throw new Error("Invalid pending import");
    }
    return { path: value.path, size: value.size, sha256: value.sha256 };
  });
  const expected = new Set([...manifest.entries.map((entry) => entry.path), "usage/ingest-state.json"]);
  if (entries.length !== expected.size
    || entries.some((entry) => !expected.delete(entry.path))
    || manifest.entries.some((manifestEntry) => {
      const staged = entries.find((entry) => entry.path === manifestEntry.path);
      return !staged || staged.size !== manifestEntry.size || staged.sha256 !== manifestEntry.sha256;
    })
    || entries.some((entry, index) => index > 0 && entries[index - 1].path.localeCompare(entry.path, "en") >= 0)) {
    throw new Error("Invalid pending import");
  }
  return entries;
}

async function updatePendingPhase(
  appDir: string,
  pendingPath: string,
  pending: PendingImport,
  phase: PendingImport["phase"],
  checkpoint?: (checkpoint: PendingWriteCheckpoint) => Promise<void>,
): Promise<void> {
  const updated = { ...pending, phase };
  const data = Buffer.from(`${JSON.stringify(updated, null, 2)}\n`, "utf8");
  if (data.byteLength > MAX_PENDING_SIZE) throw new Error("Invalid pending import metadata");
  await atomicWritePending(appDir, pendingPath, data, true, checkpoint);
  pending.phase = phase;
}

async function verifyCommittedLive(appDir: string, entries: readonly ArchiveManifestEntry[]): Promise<void> {
  for (const entry of entries) {
    if (entry.path === "usage/ingest-state.json") {
      const file = await readRequiredSafeFile(appDir, entry.path);
      if (file.data.byteLength !== entry.size || sha256Bytes(file.data) !== entry.sha256) {
        throw new Error("Invalid committed ingest state");
      }
      verifyFreshIngestState(file.data);
    } else {
      await verifyManagedEntry(appDir, entry);
    }
  }
}

function parsePendingBackup(value: Record<string, unknown>): PendingBackup {
  if (!hasExactKeys(value, ["fileName", "archiveSize", "sha256", "entryCount", "expandedTotalBytes"])
    || typeof value.fileName !== "string"
    || !/^[A-Za-z0-9._-]+\.zip$/.test(value.fileName)
    || path.basename(value.fileName) !== value.fileName
    || normalizeArchivePath(value.fileName) !== value.fileName
    || !isSafeNonNegativeInteger(value.archiveSize)
    || typeof value.sha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(value.sha256)
    || !isSafeNonNegativeInteger(value.entryCount)
    || !isSafeNonNegativeInteger(value.expandedTotalBytes)) {
    throw new Error("Invalid pending import");
  }
  return {
    fileName: value.fileName,
    archiveSize: value.archiveSize,
    sha256: value.sha256,
    entryCount: value.entryCount,
    expandedTotalBytes: value.expandedTotalBytes,
  };
}

async function validateStaging(
  stagingDir: string,
  liveDir: string,
  expectedEntries: readonly ArchiveManifestEntry[],
): Promise<ArchiveManifestEntry[]> {
  await assertDirectory(stagingDir);
  const files = await snapshotAppFiles(stagingDir);
  const expectedPaths = new Set(expectedEntries.map((entry) => entry.path));
  if (files.some((file) => !expectedPaths.has(file.path))) {
    throw new Error("Invalid staged import");
  }
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const entry of expectedEntries) {
    const staged = byPath.get(entry.path);
    if (staged) {
      if (staged.size !== entry.size || staged.sha256 !== entry.sha256) throw new Error("Invalid staged import");
    } else {
      await verifyManagedEntry(liveDir, entry);
    }
  }
  return [...expectedEntries];
}

async function applyOnePath(
  appDir: string,
  stagingDir: string,
  rollbackDir: string,
  relativePath: string,
  imported: ArchiveManifestEntry | undefined,
  rename: typeof fs.rename,
): Promise<void> {
  const livePath = containedPath(appDir, relativePath);
  const stagedPath = containedPath(stagingDir, relativePath);
  const rollbackPath = containedPath(rollbackDir, relativePath);
  const liveExists = await safeRegularFileExists(livePath);
  const stagedExists = await safeRegularFileExists(stagedPath);
  const rollbackExists = await safeRegularFileExists(rollbackPath);

  if (imported && !stagedExists && liveExists) {
    await verifyManagedEntry(appDir, imported);
    return;
  }
  if (rollbackExists && !stagedExists && !imported) {
    if (liveExists) throw new Error("Invalid interrupted import state");
    return;
  }
  if (!rollbackExists && liveExists) {
    const original = await readRequiredSafeFile(appDir, relativePath);
    await ensureSafeParents(rollbackDir, relativePath);
    try {
      await renameWithBoundParents(livePath, rollbackPath, rename);
    } catch (error) {
      if (!await safeRegularFileExists(livePath)) {
        await ensureSafeParents(appDir, relativePath);
        await writeNewContainedFile(appDir, relativePath, original.data);
      }
      throw error;
    }
  } else if (rollbackExists && liveExists) {
    throw new Error("Invalid interrupted import state");
  }
  if (imported) {
    if (!stagedExists) throw new Error("Invalid interrupted import state");
    await verifyManagedEntry(stagingDir, imported);
    await ensureSafeParents(appDir, relativePath);
    await renameWithBoundParents(stagedPath, livePath, rename);
    await verifyManagedEntry(appDir, imported);
  }
}

async function finishPendingRollback(
  appDir: string,
  stagingDir: string,
  rollbackDir: string,
  pendingPath: string,
  pending: PendingImport,
  stagedByPath: ReadonlyMap<string, ArchiveManifestEntry>,
  rename: typeof fs.rename,
  removeTree: (directory: string) => Promise<void>,
  unlinkPending: (filePath: string) => Promise<void>,
  checkpoint?: (checkpoint: PendingWriteCheckpoint) => Promise<void>,
): Promise<boolean> {
  const rollback = await rollbackAll(appDir, stagingDir, rollbackDir, pending.replacePaths, stagedByPath, rename);
  if (rollback.retryable) {
    await updatePendingPhase(appDir, pendingPath, pending, "prepared", checkpoint);
    return false;
  }
  await updatePendingPhase(appDir, pendingPath, pending, "aborted", checkpoint);
  await removeTree(rollbackDir);
  await removeTree(stagingDir);
  await unlinkPendingDurably(pendingPath, unlinkPending);
  return true;
}

async function rollbackAll(
  appDir: string,
  stagingDir: string,
  rollbackDir: string,
  paths: readonly string[],
  stagedByPath: ReadonlyMap<string, ArchiveManifestEntry>,
  rename: typeof fs.rename,
): Promise<{ retryable: boolean }> {
  let rollbackError: unknown;
  let retryable = true;
  for (const relativePath of [...paths].reverse()) {
    try {
      const livePath = containedPath(appDir, relativePath);
      const stagedPath = containedPath(stagingDir, relativePath);
      const rollbackPath = containedPath(rollbackDir, relativePath);
      const imported = stagedByPath.get(relativePath);
      const liveExists = await safeRegularFileExists(livePath);
      const stagedExists = await safeRegularFileExists(stagedPath);
      const rollbackExists = await safeRegularFileExists(rollbackPath);
      if (imported && liveExists && !stagedExists) {
        if (!rollbackExists && await hasCorruptStagedMarker(stagingDir, relativePath)) {
          retryable = false;
          continue;
        }
        await ensureSafeParents(stagingDir, relativePath);
        let importedMatches = false;
        try {
          await verifyManagedEntry(appDir, imported);
          importedMatches = true;
        } catch {
          // A replaced post-rename live file is quarantined before restoring the rollback copy.
        }
        if (importedMatches) {
          await renameWithBoundParents(livePath, stagedPath, rename);
        } else {
          retryable = false;
          await renameWithBoundParents(livePath, `${stagedPath}.corrupt-${randomUUID()}`, rename);
        }
      }
      if (rollbackExists) {
        if (await safeRegularFileExists(livePath)) throw new Error("Live target occupied during rollback");
        await ensureSafeParents(appDir, relativePath);
        await renameWithBoundParents(rollbackPath, livePath, rename);
      }
    } catch (error) {
      rollbackError ??= error;
    }
  }
  if (rollbackError) throw new Error("Portable data rollback failed");
  return { retryable };
}

async function hasCorruptStagedMarker(stagingDir: string, relativePath: string): Promise<boolean> {
  const stagedPath = containedPath(stagingDir, relativePath);
  const parent = path.dirname(stagedPath);
  const prefix = `${path.basename(stagedPath)}.corrupt-`;
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.startsWith(prefix));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function unlinkPendingDurably(
  pendingPath: string,
  unlinkPending: (filePath: string) => Promise<void>,
): Promise<void> {
  try {
    await unlinkPending(pendingPath);
  } catch (error) {
    if (!await safeRegularFileExists(pendingPath)) return;
    throw error;
  }
}

async function verifyManagedEntry(root: string, entry: ArchiveManifestEntry): Promise<void> {
  const identity = await fileIdentity(containedPath(root, entry.path), entry.size);
  if (identity.size !== entry.size || identity.sha256 !== entry.sha256) {
    throw new Error("Managed import file failed verification");
  }
}

async function renameWithBoundParents(from: string, to: string, rename: typeof fs.rename): Promise<void> {
  const sourceParent = path.dirname(from);
  const targetParent = path.dirname(to);
  const sourceBinding = await bindDirectory(sourceParent);
  const targetBinding = sourceParent === targetParent ? sourceBinding : await bindDirectory(targetParent);
  try {
    await assertDirectoryBinding(sourceBinding);
    await assertDirectoryBinding(targetBinding);
    await rename(from, to);
    await assertDirectoryBinding(sourceBinding);
    await assertDirectoryBinding(targetBinding);
  } finally {
    if (targetBinding !== sourceBinding) await targetBinding.handle.close();
    await sourceBinding.handle.close();
  }
}

async function writePending(appDir: string, pending: PendingImport): Promise<void> {
  const pendingPath = path.join(appDir, PENDING_FILE);
  const data = Buffer.from(`${JSON.stringify(pending, null, 2)}\n`, "utf8");
  if (data.byteLength > MAX_PENDING_SIZE) throw new Error("Invalid pending import metadata");
  await atomicWritePending(appDir, pendingPath, data, false);
}

async function atomicWritePending(
  appDir: string,
  pendingPath: string,
  data: Buffer,
  replace: boolean,
  checkpoint?: (checkpoint: PendingWriteCheckpoint) => Promise<void>,
): Promise<void> {
  const parentBinding = await bindDirectory(appDir);
  const temporaryPath = `${pendingPath}.${randomUUID()}.tmp`;
  let temporaryExists = false;
  try {
    await checkpoint?.("before-temp-write");
    const handle = await fs.open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    temporaryExists = true;
    try {
      await handle.writeFile(data);
      await checkpoint?.("after-temp-write");
      await handle.sync();
      await checkpoint?.("after-temp-fsync");
    } finally {
      await handle.close();
    }
    await assertDirectoryBinding(parentBinding);
    if (replace) await assertRegularPending(pendingPath);
    else await assertPathMissing(pendingPath);
    await fs.rename(temporaryPath, pendingPath);
    temporaryExists = false;
    await checkpoint?.("after-rename");
    await assertDirectoryBinding(parentBinding);
    await assertRegularPending(pendingPath);
    await syncDirectoryIfSupported(appDir);
  } catch (error) {
    if (temporaryExists) await removeFileIfPresent(temporaryPath).catch(() => undefined);
    throw error;
  } finally {
    await parentBinding.handle.close();
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

async function preparedFileData(file: PreparedPortableFile): Promise<Buffer> {
  if (file.data) return file.data;
  if (!file.temporaryPath) throw new Error("Invalid prepared portable file");
  const info = await fs.lstat(file.temporaryPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size) throw new Error("Invalid prepared portable file");
  const data = await readStableFile(file.temporaryPath, info.size);
  if (sha256Bytes(data) !== file.sha256) throw new Error("Prepared portable file changed");
  return data;
}

async function writePreparedFile(root: string, file: PreparedPortableFile): Promise<void> {
  if (file.data) return writeNewContainedFile(root, file.path, file.data);
  if (!file.temporaryPath) throw new Error("Invalid prepared portable file");
  await ensureSafeParents(root, file.path);
  const target = containedPath(root, file.path);
  await fs.copyFile(file.temporaryPath, target, constants.COPYFILE_EXCL);
  const copied = await fileIdentity(target);
  if (copied.size !== file.size || copied.sha256 !== file.sha256) throw new Error("Prepared portable file copy failed verification");
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
  await cleanupPendingTemps(appDir);
  await assertPathMissing(path.join(appDir, PENDING_FILE));
}

async function assertPathMissing(filePath: string): Promise<void> {
  try {
    await fs.lstat(filePath);
    throw new Error("Pending import already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertRegularPending(filePath: string): Promise<void> {
  const info = await fs.lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe pending import path");
}

interface DirectoryIdentity {
  device: number;
  inode: number;
  realPath: string;
}

interface DirectoryBinding extends DirectoryIdentity {
  directory: string;
  handle: FileHandle;
}

async function directoryIdentity(directory: string): Promise<DirectoryIdentity> {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe pending import parent");
  return { device: info.dev, inode: info.ino, realPath: await fs.realpath(directory) };
}

async function assertDirectoryIdentity(directory: string, expected: DirectoryIdentity): Promise<void> {
  const actual = await directoryIdentity(directory);
  if (actual.device !== expected.device || actual.inode !== expected.inode || actual.realPath !== expected.realPath) {
    throw new Error("Pending import parent changed");
  }
}

async function bindDirectory(directory: string): Promise<DirectoryBinding> {
  const identity = await directoryIdentity(directory);
  const handle = await fs.open(directory, constants.O_RDONLY);
  try {
    const info = await handle.stat();
    if (!info.isDirectory() || info.dev !== identity.device || info.ino !== identity.inode) {
      throw new Error("Managed rename parent changed");
    }
    return { ...identity, directory, handle };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertDirectoryBinding(binding: DirectoryBinding): Promise<void> {
  await assertDirectoryIdentity(binding.directory, binding);
  const info = await binding.handle.stat();
  if (!info.isDirectory() || info.dev !== binding.device || info.ino !== binding.inode) {
    throw new Error("Managed rename parent changed");
  }
}

async function syncDirectoryIfSupported(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!["EINVAL", "EISDIR", "ENOTSUP", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

async function cleanupPendingTemps(appDir: string): Promise<void> {
  const prefix = `${PENDING_FILE}.`;
  for (const entry of await fs.readdir(appDir, { withFileTypes: true })) {
    if (!entry.name.startsWith(prefix) || !entry.name.endsWith(".tmp")) continue;
    const token = entry.name.slice(prefix.length, -4);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) continue;
    const candidate = path.join(appDir, entry.name);
    const info = await fs.lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe pending import temporary path");
    await fs.unlink(candidate);
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
  const name = path.basename(directory);
  if (!/^\.\.?[A-Za-z0-9._-]*portable-import-[0-9a-f-]+(?:\.rollback)?$/i.test(name)) {
    throw new Error("Unsafe import work directory");
  }
  const parent = path.dirname(directory);
  const tombstonePrefix = `${name}.delete-`;
  for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
    if (entry.name.startsWith(tombstonePrefix)
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry.name.slice(tombstonePrefix.length))) {
      await removeOwnedTombstone(parent, entry.name);
    }
  }
  try {
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe import work directory");
    const tombstoneName = `${name}.delete-${randomUUID()}`;
    const tombstone = path.join(parent, tombstoneName);
    await fs.rename(directory, tombstone);
    await removeOwnedTombstone(parent, tombstoneName);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function removeOwnedTombstone(parent: string, name: string): Promise<void> {
  const tombstone = path.join(parent, name);
  const moved = await fs.lstat(tombstone);
  if (!moved.isDirectory() || moved.isSymbolicLink()) throw new Error("Unsafe import cleanup target");
  const parentReal = await fs.realpath(parent);
  const tombstoneReal = await fs.realpath(tombstone);
  assertContained(parentReal, tombstoneReal);
  await fs.rm(tombstone, { recursive: true });
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

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function sha256Bytes(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function manifestFromSnapshots(files: readonly SnapshotFile[]): ArchiveManifest {
  return parseArchiveManifest(Buffer.from(JSON.stringify({
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    quotaBarVersion: QUOTABAR_VERSION,
    createdAt: new Date().toISOString(),
    entries: files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 }))
      .sort((left, right) => left.path.localeCompare(right.path, "en")),
  }), "utf8"));
}

async function writeStreamingZip(
  destination: string,
  files: readonly SnapshotFile[],
  manifest?: Buffer,
  maximumArchiveBytes: number | undefined = MAX_COMPRESSED_PORTABLE_ARCHIVE_SIZE,
  forceZip64Format = false,
  compressFiles = true,
): Promise<void> {
  const zip = new YazlZipFile();
  for (const file of files) {
    zip.addFile(file.absolutePath, file.path, { compress: compressFiles, forceZip64Format: forceZip64Format || file.size > 0xffff_ffff });
  }
  if (manifest) zip.addBuffer(manifest, "manifest.json", { compress: true });
  let outputBytes = 0;
  const destinationStream = createWriteStream(destination, { flags: "wx", mode: 0o600 });
  const writing = maximumArchiveBytes === undefined
    ? pipeline(zip.outputStream, destinationStream)
    : pipeline(zip.outputStream, new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        outputBytes += chunk.byteLength;
        callback(outputBytes > maximumArchiveBytes ? new Error("Archive output exceeds the size limit") : undefined, chunk);
      },
    }), destinationStream);
  zip.end({ forceZip64Format, comment: "" });
  await writing;
}

export function privateBackupWriterPolicy(
  files: readonly Pick<SnapshotFile, "size">[],
): BackupWriterPolicy {
  let totalSize = 0;
  let forceZip64Format = files.length >= 0xffff;
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error("Invalid private backup source size");
    if (file.size >= 0xffff_ffff) forceZip64Format = true;
    if (totalSize > Number.MAX_SAFE_INTEGER - file.size) throw new Error("Invalid private backup total size");
    totalSize += file.size;
  }
  if (totalSize >= 0xffff_ffff) forceZip64Format = true;
  return { maximumArchiveBytes: undefined, forceZip64Format };
}

async function snapshotAppFiles(appDir: string): Promise<SnapshotFile[]> {
  await assertDirectory(appDir);
  const rootReal = await fs.realpath(appDir);
  const result: SnapshotFile[] = [];
  await walkSnapshots(appDir, "", rootReal, result);
  result.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return result;
}

async function walkSnapshots(
  directory: string,
  relativeDirectory: string,
  rootReal: string,
  output: SnapshotFile[],
): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (TRANSIENT_LOCK_DIRS.has(entry.name)) continue;
    const relativePath = normalizeArchivePath(relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name);
    const absolutePath = path.join(directory, entry.name);
    const info = await fs.lstat(absolutePath);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error("Unsupported application data entry");
    const resolved = await fs.realpath(absolutePath);
    assertContained(rootReal, resolved);
    if (info.isDirectory()) {
      await walkSnapshots(absolutePath, relativePath, rootReal, output);
    } else {
      const identity = await fileIdentity(absolutePath);
      output.push({ path: relativePath, absolutePath, size: identity.size, sha256: identity.sha256 });
    }
  }
}

async function verifySnapshotFiles(files: readonly SnapshotFile[]): Promise<void> {
  for (const file of files) {
    const identity = await fileIdentity(file.absolutePath);
    if (identity.size !== file.size || identity.sha256 !== file.sha256) {
      throw new Error("Application data changed during archive operation");
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

async function fileIdentity(filePath: string, maximumSize = Number.MAX_SAFE_INTEGER): Promise<FileIdentity> {
  const info = await fs.lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || !Number.isSafeInteger(info.size) || info.size > maximumSize) {
    throw new Error("Invalid archive source");
  }
  const handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    return await fileIdentityFromHandle(handle);
  } finally {
    await handle.close();
  }
}

async function fileIdentityFromHandle(handle: FileHandle): Promise<FileIdentity> {
  const before = await handle.stat();
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < before.size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
    if (bytesRead === 0) throw new Error("Archive source changed during validation");
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  const after = await handle.stat();
  if (position !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
    throw new Error("Archive source changed during validation");
  }
  return { size: before.size, sha256: hash.digest("hex") };
}

async function assertFileIdentity(filePath: string, expected: FileIdentity): Promise<void> {
  const actual = await fileIdentity(filePath);
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
    throw new Error("Archive source changed during validation");
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
  // Global order mirrors writers: app -> migration -> ingestion -> usage store -> quota store.
  const usageDir = path.join(appDir, "usage");
  return withPortableRootLock(appDir, () =>
    withNamedPortableRootLock(usageDir, ".portable-migration.lock", () =>
      withNamedPortableRootLock(usageDir, ".portable-ingestion.lock", () =>
        withPortableRootLock(usageDir, () =>
          withPortableRootLock(path.join(appDir, "quota"), operation)))));
}

async function genericFailure<T>(message: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error(message);
  }
}

function summarizeSnapshots(outputPath: string, files: readonly SnapshotFile[]): ArchiveOperationResult {
  return {
    path: outputPath,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
  };
}

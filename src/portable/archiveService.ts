import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { ArchiveBackupDependencies, ArchiveOperationResult, assertSafeBackupDestination, createFullBackupUnlocked, isSafeNonNegativeInteger, manifestFromSnapshots, PendingBackup, sanitizePortableExportFiles, sha256Bytes, snapshotAppFiles, summarizeSnapshots, verifyBackupArchive, verifySnapshotFiles, writeStreamingZip } from "./archiveBackup";
import { PortableArchiveContentValidator } from "./archiveContentValidator";
import {
  assertContained,
  assertDestinationAvailable,
  assertDirectory,
  assertDirectoryBinding,
  bindDirectory,
  containedPath,
  ensureOwnedDirectory,
  ensureSafeParents,
  fileIdentity,
  readRequiredSafeFile,
  readStableFile,
  removeFileIfPresent,
  removeOwnedTree,
  renameWithBoundParents,
  SafeFile,
  safeRegularFileExists,
  safeSibling,
  syncDirectoryIfSupported,
  writeNewContainedFile
} from "./archiveFileSystem";
import {
  isPortableArchivePath,
  normalizeArchivePath,
  parseArchiveManifest,
  sanitizeImportedSettings,
  type ArchiveManifest,
  type ArchiveManifestEntry
} from "./archiveManifest";
import { withNamedPortableRootLock, withPortableRootLock } from "./rootLock";
import {
  MAX_COMPRESSED_PORTABLE_ARCHIVE_SIZE,
  preflightPortableZip,
  type StreamingPortablePreflight,
} from "./streamingZip";
import { PORTABLE_STORE_VERSION } from "./types";
export { ArchiveBackupDependencies, ArchiveOperationResult, BackupWriterPolicy, privateBackupWriterPolicy } from "./archiveBackup";

import { renameWithRetry } from "../shared/atomicFile";
import { boundaryError, errnoCode } from "../shared/errors";
const PENDING_FILE = ".portable-import.pending.json";
const PENDING_FORMAT = "QuotaBar/pending-import";
const PENDING_VERSION = 1;
const MAX_PENDING_SIZE = 64 * 1024;

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
  /** errno code of the underlying failure, if any; the message stays fixed and path-free. */
  readonly code?: string;

  constructor(public readonly rollbackOutcome: PortableImportRollbackOutcome, failure?: unknown) {
    super("Portable data apply failed");
    this.name = "PortableImportApplyError";
    const code = errnoCode(failure);
    if (code) this.code = code;
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
  onStreamChunk?: (entryPath: string, bytes: number) => void;
  onContentValidation?: (entryPath: string, phase: "start" | "end") => void;
}

export interface ArchiveExportDependencies {
  maximumArchiveBytes?: number;
}

interface PreparedPortableFile {
  path: string;
  size: number;
  sha256: string;
  data?: Buffer;
  temporaryPath?: string;
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
      const sourceFiles = (await snapshotAppFiles(appDir))
        .filter((file) => isPortableArchivePath(file.path) && file.path !== "manifest.json");
      const files = await sanitizePortableExportFiles(sourceFiles);
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
      await verifySnapshotFiles(sourceFiles);
      const verified = await preflightPortableZip(partialPath);
      await verified.cleanup();
      await renameWithRetry(partialPath, destinationZip);
      return summarizeSnapshots(destinationZip, files);
    } catch (error) {
      await removeFileIfPresent(partialPath);
      throw boundaryError("Portable data export failed", error);
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
    const streaming: StreamingPortablePreflight = await preflightPortableZip(zipPath, { onStreamChunk: dependencies.onStreamChunk });
    const stagedFiles: PreparedPortableFile[] = streaming.files.map((file) => ({
      path: file.path,
      size: file.size,
      sha256: file.sha256,
      temporaryPath: file.temporaryPath,
    }));
    try {
      await validatePreparedPortableContents(stagedFiles, dependencies.onContentValidation);
      return await withArchiveLocks(appDir, async () => {
    let stagingDir: string | undefined;
    try {
      await streaming.verifySourceIdentity();
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
      const stagedManifest = {
        ...streaming.manifest,
        entries: stagedFiles.map(({ path: filePath, size, sha256 }) => ({ path: filePath, size, sha256 }))
          .sort((left, right) => left.path.localeCompare(right.path, "en")),
      };
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
    } catch (error) {
      if (stagingDir) await removeOwnedTree(stagingDir);
      throw boundaryError("Portable data import failed", error);
    }
      });
    } finally {
      await streaming.cleanup();
    }
  });
}

async function validatePreparedPortableContents(
  files: readonly PreparedPortableFile[],
  onValidation?: (entryPath: string, phase: "start" | "end") => void,
): Promise<void> {
  const validator = new PortableArchiveContentValidator();
  for (const file of files) {
    onValidation?.(file.path, "start");
    try {
      const data = await preparedFileData(file);
      validator.add({ path: file.path, data });
    } finally {
      onValidation?.(file.path, "end");
    }
  }
  validator.finish();
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
      throw boundaryError("Portable data apply failed", error);
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
      } catch (applyError) {
        try {
          await updatePendingPhase(appDir, pendingPath, pending, "rolling-back", dependencies.pendingWriteCheckpoint);
          await finishPendingRollback(
            appDir, stagingDir, rollbackDir, pendingPath, pending, stagedByPath,
            rename, removeTree, unlinkPending, dependencies.pendingWriteCheckpoint,
          );
        } catch (rollbackError) {
          throw new PortableImportApplyError("pending-recovery", rollbackError);
        }
        throw new PortableImportApplyError("completed", applyError);
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
      throw new PortableImportApplyError(applyStarted ? "pending-recovery" : "not-attempted", error);
    }
    });
  } catch (error) {
    if (error instanceof PortableImportApplyError) throw error;
    throw new PortableImportApplyError(applyStarted ? "pending-recovery" : "not-attempted", error);
  }
}

async function verifyReferencedBackup(appDir: string, pending: PendingImport): Promise<void> {
  const backupPath = path.join(path.dirname(appDir), "QuotaBar Backups", pending.backup.fileName);
  await assertSafeBackupDestination(appDir, backupPath);
  await verifyBackupArchive(backupPath, pending.backup);
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
      const corruptMarkerExists = Boolean(imported && !stagedExists
        && await hasCorruptStagedMarker(stagingDir, relativePath));
      if (corruptMarkerExists) retryable = false;
      if (imported && liveExists && !stagedExists) {
        if (!rollbackExists && corruptMarkerExists) continue;
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
  if (rollbackError) throw boundaryError("Portable data rollback failed", rollbackError);
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
    await renameWithRetry(temporaryPath, pendingPath);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
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
  } catch (error) {
    // Archive diagnostics can contain host paths; keep only the errno code.
    throw boundaryError(message, error);
  }
}

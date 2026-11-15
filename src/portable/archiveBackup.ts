import CRC32 from "crc-32";
import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";
import { ZipFile as YazlZipFile } from "yazl";
import { appVersion as QUOTABAR_VERSION } from "../shared/appVersion";
import {
  assertContained,
  assertDestinationAvailable,
  assertDirectory,
  assertNoReparseAncestors,
  canonicalFsPath,
  fileIdentity,
  FileIdentity,
  fileIdentityFromHandle,
  readStableFile,
  removeFileIfPresent
} from "./archiveFileSystem";
import {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  normalizeArchivePath,
  parseArchiveManifest,
  sanitizeImportedSettings,
  type ArchiveManifest
} from "./archiveManifest";
import {
  MAX_COMPRESSED_PORTABLE_ARCHIVE_SIZE
} from "./streamingZip";

export const ARCHIVE_LOCK_DIR = ".portable-store.lock";

export const TRANSIENT_LOCK_DIRS = new Set([ARCHIVE_LOCK_DIR, ".portable-ingestion.lock", ".portable-migration.lock"]);

export interface ArchiveOperationResult {
  path: string;
  fileCount: number;
  totalBytes: number;
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

export interface SnapshotFile {
  path: string;
  absolutePath?: string;
  data?: Buffer;
  size: number;
  sha256: string;
}

export interface PendingBackup {
  fileName: string;
  archiveSize: number;
  sha256: string;
  entryCount: number;
  expandedTotalBytes: number;
}

export async function verifyBackupArchive(
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

export function verifyBackupEntriesFromFd(
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

export function assertIdentityMatches(actual: FileIdentity, expected: Pick<PendingBackup, "archiveSize" | "sha256">): void {
  if (actual.size !== expected.archiveSize || actual.sha256 !== expected.sha256) {
    throw new Error("Invalid referenced backup");
  }
}

export async function createFullBackupUnlocked(
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

export async function assertSafeBackupDestination(appDir: string, backupZip: string): Promise<void> {
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

export function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function sha256Bytes(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function manifestFromSnapshots(files: readonly SnapshotFile[]): ArchiveManifest {
  return parseArchiveManifest(Buffer.from(JSON.stringify({
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    quotaBarVersion: QUOTABAR_VERSION,
    createdAt: new Date().toISOString(),
    entries: files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 }))
      .sort((left, right) => left.path.localeCompare(right.path, "en")),
  }), "utf8"));
}

export async function writeStreamingZip(
  destination: string,
  files: readonly SnapshotFile[],
  manifest?: Buffer,
  maximumArchiveBytes: number | undefined = MAX_COMPRESSED_PORTABLE_ARCHIVE_SIZE,
  forceZip64Format = false,
  compressFiles = true,
): Promise<void> {
  const zip = new YazlZipFile();
  for (const file of files) {
    if (file.data) zip.addBuffer(file.data, file.path, { compress: compressFiles, forceZip64Format: forceZip64Format || file.size > 0xffff_ffff });
    else if (file.absolutePath) zip.addFile(file.absolutePath, file.path, { compress: compressFiles, forceZip64Format: forceZip64Format || file.size > 0xffff_ffff });
    else throw new Error("Invalid archive source");
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

export async function snapshotAppFiles(appDir: string): Promise<SnapshotFile[]> {
  await assertDirectory(appDir);
  const rootReal = await fs.realpath(appDir);
  const result: SnapshotFile[] = [];
  await walkSnapshots(appDir, "", rootReal, result);
  result.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return result;
}

export async function walkSnapshots(
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

export async function verifySnapshotFiles(files: readonly SnapshotFile[]): Promise<void> {
  for (const file of files) {
    if (!file.absolutePath) continue;
    const identity = await fileIdentity(file.absolutePath);
    if (identity.size !== file.size || identity.sha256 !== file.sha256) {
      throw new Error("Application data changed during archive operation");
    }
  }
}

export async function sanitizePortableExportFiles(files: readonly SnapshotFile[]): Promise<SnapshotFile[]> {
  const result: SnapshotFile[] = [];
  for (const file of files) {
    if (file.path !== "settings.json") {
      result.push(file);
      continue;
    }
    if (!file.absolutePath) throw new Error("Invalid settings source");
    const raw = await readStableFile(file.absolutePath, file.size);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new Error("Invalid settings source");
    }
    const data = Buffer.from(`${JSON.stringify(sanitizeImportedSettings(parsed, ""), null, 2)}\n`, "utf8");
    result.push({ path: file.path, data, size: data.byteLength, sha256: sha256Bytes(data) });
  }
  return result;
}

export function summarizeSnapshots(outputPath: string, files: readonly SnapshotFile[]): ArchiveOperationResult {
  return {
    path: outputPath,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
  };
}

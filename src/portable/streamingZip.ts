import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import CRC32 from "crc-32";
import * as yauzl from "yauzl";
import {
  MAX_ARCHIVE_FILE_SIZE,
  parseArchiveManifest,
  validateArchiveStructure,
  validateZipEntryMetadata,
  type ArchiveEntryMetadata,
  type ArchiveManifest,
} from "./archiveManifest";

export const MAX_COMPRESSED_PORTABLE_ARCHIVE_SIZE = 256 * 1024 * 1024;

export interface SpooledPortableFile {
  path: string;
  temporaryPath: string;
  size: number;
  sha256: string;
}

export interface StreamingPortablePreflight {
  files: SpooledPortableFile[];
  manifest: ArchiveManifest;
  verifySourceIdentity(): Promise<void>;
  cleanup(): Promise<void>;
}

export interface StreamingPreflightOptions {
  onStreamChunk?: (entryPath: string, bytes: number) => void;
}

interface Identity {
  size: number;
  sha256: string;
}

export async function preflightPortableZip(
  zipPath: string,
  options: StreamingPreflightOptions = {},
): Promise<StreamingPortablePreflight> {
  const info = await fs.lstat(zipPath);
  if (!info.isFile() || info.isSymbolicLink() || !Number.isSafeInteger(info.size)
    || info.size > MAX_COMPRESSED_PORTABLE_ARCHIVE_SIZE) {
    throw new Error("Invalid portable archive source");
  }
  const handle = await fs.open(zipPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let spoolRoot: string | undefined;
  try {
    const identity = await identityFromHandle(handle);
    const zip = await openZipFromHandle(handle);
    const entries = await enumerateEntries(zip);
    const metadata = entries.map(entryMetadata);
    validateZipEntryMetadata(metadata);
    const manifestEntry = entries.find((entry) => entry.fileName === "manifest.json");
    if (!manifestEntry) throw new Error("Archive must contain exactly one manifest");
    const manifestBytes = await readEntryBuffer(zip, manifestEntry, MAX_ARCHIVE_FILE_SIZE);
    const manifest = parseArchiveManifest(manifestBytes);
    validateArchiveStructure(metadata, manifest);
    spoolRoot = await fs.mkdtemp(path.join(os.tmpdir(), "quotabar-import-spool-"));
    const expected = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    const files: SpooledPortableFile[] = [];
    for (const entry of entries) {
      if (entry.fileName === "manifest.json") continue;
      const manifestFile = expected.get(entry.fileName);
      if (!manifestFile) throw new Error("Archive contents do not match manifest");
      const temporaryPath = path.join(spoolRoot, `${files.length}.entry`);
      const actual = await streamEntryToFile(zip, entry, temporaryPath, options.onStreamChunk);
      if (actual.size !== manifestFile.size || actual.sha256 !== manifestFile.sha256) {
        throw new Error("Archive entry checksum does not match manifest");
      }
      files.push({ path: entry.fileName, temporaryPath, ...actual });
    }
    await assertIdentity(handle, identity);
    let closed = false;
    return {
      files,
      manifest,
      verifySourceIdentity: async () => {
        if (closed) throw new Error("Portable archive source is closed");
        await assertIdentity(handle, identity);
      },
      cleanup: async () => {
        if (closed) return;
        closed = true;
        await handle.close();
        if (spoolRoot) await fs.rm(spoolRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (spoolRoot) await fs.rm(spoolRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function openZipFromHandle(handle: FileHandle): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromFd(handle.fd, {
      autoClose: false,
      decodeStrings: true,
      lazyEntries: true,
      strictFileNames: true,
      validateEntrySizes: true,
    }, (error, zip) => error ? reject(error) : resolve(zip));
  });
}

function enumerateEntries(zip: yauzl.ZipFile): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: yauzl.Entry[] = [];
    zip.on("error", reject);
    zip.on("entry", (entry: yauzl.Entry) => {
      entries.push(entry);
      zip.readEntry();
    });
    zip.on("end", () => resolve(entries));
    zip.readEntry();
  });
}

function entryMetadata(entry: yauzl.Entry): ArchiveEntryMetadata {
  if (entry.extraFields.some((field) => field.id === 0x0001)) throw new Error("Unsupported ZIP64 archive entry");
  return {
    entryName: entry.fileName,
    isDirectory: entry.fileName.endsWith("/"),
    size: entry.uncompressedSize,
    compressedSize: entry.compressedSize,
    flags: entry.generalPurposeBitFlag,
    method: entry.compressionMethod,
    madeBy: entry.versionMadeBy,
    attributes: entry.externalFileAttributes,
  };
}

function openEntryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream));
  });
}

async function readEntryBuffer(zip: yauzl.ZipFile, entry: yauzl.Entry, maximum: number): Promise<Buffer> {
  if (entry.uncompressedSize > maximum) throw new Error("Archive entry exceeds the file size limit");
  const chunks: Buffer[] = [];
  let size = 0;
  let crc = 0;
  const stream = await openEntryStream(zip, entry);
  for await (const rawChunk of stream) {
    const chunk = Buffer.from(rawChunk as Uint8Array);
    size += chunk.byteLength;
    if (size > maximum || size > entry.uncompressedSize) throw new Error("Archive entry exceeds the file size limit");
    crc = CRC32.buf(chunk, crc);
    chunks.push(chunk);
  }
  if (size !== entry.uncompressedSize || (crc >>> 0) !== (entry.crc32 >>> 0)) {
    throw new Error("Archive entry failed CRC validation");
  }
  return Buffer.concat(chunks, size);
}

async function streamEntryToFile(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  target: string,
  onChunk?: (entryPath: string, bytes: number) => void,
): Promise<{ size: number; sha256: string }> {
  const source = await openEntryStream(zip, entry);
  const output = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  const hash = createHash("sha256");
  let crc = 0;
  let size = 0;
  try {
    for await (const rawChunk of source) {
      const chunk = Buffer.from(rawChunk as Uint8Array);
      onChunk?.(entry.fileName, chunk.byteLength);
      size += chunk.byteLength;
      if (size > entry.uncompressedSize || size > MAX_ARCHIVE_FILE_SIZE) throw new Error("Archive entry exceeds the file size limit");
      hash.update(chunk);
      crc = CRC32.buf(chunk, crc);
      await output.write(chunk);
    }
    await output.sync();
  } finally {
    await output.close();
  }
  if (size !== entry.uncompressedSize || (crc >>> 0) !== (entry.crc32 >>> 0)) {
    throw new Error("Archive entry failed CRC validation");
  }
  return { size, sha256: hash.digest("hex") };
}

async function identityFromHandle(handle: FileHandle): Promise<Identity> {
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
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
    throw new Error("Archive source changed during validation");
  }
  return { size: before.size, sha256: hash.digest("hex") };
}

async function assertIdentity(handle: FileHandle, expected: Identity): Promise<void> {
  const actual = await identityFromHandle(handle);
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
    throw new Error("Archive source changed during validation");
  }
}

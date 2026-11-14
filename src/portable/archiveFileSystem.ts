import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  normalizeArchivePath
} from "./archiveManifest";

export interface SafeFile {
  path: string;
  data: Buffer;
}

export interface FileIdentity {
  size: number;
  sha256: string;
}

export async function assertNoReparseAncestors(directory: string): Promise<void> {
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

export function canonicalFsPath(filePath: string): string {
  const normalized = path.normalize(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export async function renameWithBoundParents(from: string, to: string, rename: typeof fs.rename): Promise<void> {
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

export async function writeNewContainedFile(root: string, relativePath: string, data: Uint8Array): Promise<void> {
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

export async function ensureSafeParents(root: string, relativePath: string): Promise<void> {
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

export function containedPath(root: string, relativePath: string): string {
  const normalized = normalizeArchivePath(relativePath);
  if (normalized !== relativePath) throw new Error("Invalid archive path");
  const candidate = path.resolve(root, ...normalized.split("/"));
  assertContained(path.resolve(root), candidate);
  return candidate;
}

export async function readRequiredSafeFile(root: string, relativePath: string): Promise<SafeFile> {
  const target = containedPath(root, relativePath);
  const info = await fs.lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid staged file");
  return { path: relativePath, data: await readStableFile(target, info.size) };
}

export interface DirectoryIdentity {
  device: number;
  inode: number;
  realPath: string;
}

export interface DirectoryBinding extends DirectoryIdentity {
  directory: string;
  handle: FileHandle;
}

export async function directoryIdentity(directory: string): Promise<DirectoryIdentity> {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe pending import parent");
  return { device: info.dev, inode: info.ino, realPath: await fs.realpath(directory) };
}

export async function assertDirectoryIdentity(directory: string, expected: DirectoryIdentity): Promise<void> {
  const actual = await directoryIdentity(directory);
  if (actual.device !== expected.device || actual.inode !== expected.inode || actual.realPath !== expected.realPath) {
    throw new Error("Pending import parent changed");
  }
}

export async function bindDirectory(directory: string): Promise<DirectoryBinding> {
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

export async function assertDirectoryBinding(binding: DirectoryBinding): Promise<void> {
  await assertDirectoryIdentity(binding.directory, binding);
  const info = await binding.handle.stat();
  if (!info.isDirectory() || info.dev !== binding.device || info.ino !== binding.inode) {
    throw new Error("Managed rename parent changed");
  }
}

export async function syncDirectoryIfSupported(directory: string): Promise<void> {
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

export function safeSibling(parent: string, name: string, prefix: string): string {
  if (path.basename(name) !== name || !name.startsWith(prefix) || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error("Invalid pending import path");
  }
  const result = path.resolve(parent, name);
  assertContained(path.resolve(parent), result);
  return result;
}

export async function safeRegularFileExists(filePath: string): Promise<boolean> {
  try {
    const info = await fs.lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe managed import path");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function removeOwnedTree(directory: string): Promise<void> {
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

export async function removeOwnedTombstone(parent: string, name: string): Promise<void> {
  const tombstone = path.join(parent, name);
  const moved = await fs.lstat(tombstone);
  if (!moved.isDirectory() || moved.isSymbolicLink()) throw new Error("Unsafe import cleanup target");
  const parentReal = await fs.realpath(parent);
  const tombstoneReal = await fs.realpath(tombstone);
  assertContained(parentReal, tombstoneReal);
  await fs.rm(tombstone, { recursive: true });
}

export async function ensureOwnedDirectory(directory: string): Promise<void> {
  try {
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe import work directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.mkdir(directory);
  }
}

export async function readStableFile(filePath: string, expectedSize: number): Promise<Buffer> {
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

export async function fileIdentity(filePath: string, maximumSize = Number.MAX_SAFE_INTEGER): Promise<FileIdentity> {
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

export async function fileIdentityFromHandle(handle: FileHandle): Promise<FileIdentity> {
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

export async function assertFileIdentity(filePath: string, expected: FileIdentity): Promise<void> {
  const actual = await fileIdentity(filePath);
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
    throw new Error("Archive source changed during validation");
  }
}

export async function assertDirectory(directory: string): Promise<void> {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid application data directory");
}

export function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) return;
  throw new Error("Application data escapes its root");
}

export async function assertDestinationAvailable(destination: string): Promise<void> {
  try {
    await fs.lstat(destination);
    throw new Error("Archive destination already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function removeFileIfPresent(filePath: string): Promise<void> {
  try {
    const info = await fs.lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe partial archive path");
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

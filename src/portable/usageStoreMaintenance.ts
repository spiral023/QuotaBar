import type { Dirent } from "node:fs";
import type * as nodeFs from "node:fs/promises";
import path from "node:path";
import { TEMP_FILE, isMissingFile } from "./usageStoreFormat";
export type StoreFileSystem = Pick<typeof nodeFs, "lstat" | "mkdir" | "readFile" | "readdir" | "rename" | "unlink" | "writeFile">;
const STALE_TEMP_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function readMetadataPartitions(fileSystem: StoreFileSystem, metadataPath: string): Promise<Map<string, string> | undefined> {
    let contents: string;
    try {
      contents = await fileSystem.readFile(metadataPath, "utf8");
    } catch {
      return undefined;
    }
    try {
      const parsed = JSON.parse(contents) as { partitions?: Record<string, unknown> };
      const partitions = parsed?.partitions;
      if (!partitions || typeof partitions !== "object") return undefined;
      const result = new Map<string, string>();
      for (const [month, value] of Object.entries(partitions)) {
        const item = value as { eventCount?: unknown; firstAt?: unknown; lastAt?: unknown };
        result.set(month, `${String(item?.eventCount)}:${String(item?.firstAt)}:${String(item?.lastAt)}`);
      }
      return result;
    } catch {
      return undefined;
    }
  }

export async function readMetadataIdentity(fileSystem: StoreFileSystem, metadataPath: string): Promise<string> {
    try {
      const info = await fileSystem.lstat(metadataPath, { bigint: true });
      return info.isFile() ? `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.dev}:${info.ino}` : "non-file";
    } catch (error) {
      if (isMissingFile(error)) return "missing";
      throw error;
    }
  }

export async function cleanupStaleTemps(fileSystem: StoreFileSystem, rootDir: string): Promise<void> {
    const cutoff = Date.now() - STALE_TEMP_AGE_MS;
    for (const directory of [rootDir, path.join(rootDir, "events")]) {
      let entries: Dirent[];
      try {
        entries = await fileSystem.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (isMissingFile(error)) continue;
        throw error;
      }
      for (const entry of entries) {
        if (typeof entry === "string" || !entry.isFile() || !TEMP_FILE.test(entry.name)) continue;
        const filePath = path.join(directory, entry.name);
        const info = await fileSystem.lstat(filePath);
        if (info.isFile() && info.mtimeMs < cutoff) await fileSystem.unlink(filePath);
      }
    }
  }

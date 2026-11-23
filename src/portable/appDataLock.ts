import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { retryTransient, writeFileAtomic } from "../shared/atomicFile";
import { withPortableRootLock } from "./rootLock";

export async function withAppDataLock<T>(appDir: string, operation: () => Promise<T>): Promise<T> {
  await fs.mkdir(appDir, { recursive: true });
  return withPortableRootLock(appDir, operation);
}

export async function writeAppDataFile(filePath: string, contents: string): Promise<void> {
  const appDir = path.dirname(filePath);
  const before = await fileFingerprint(filePath);
  await withAppDataLock(appDir, async () => {
    if (await fileFingerprint(filePath) !== before) {
      throw new Error("App data changed while waiting for the write lock");
    }
    await writeUnlocked(filePath, contents);
  });
}

/**
 * Read-modify-write under the app-data lock. `update` receives the current
 * contents (`null` when the file is missing) and returns the new contents, or
 * `null` to leave the file untouched. A read failure other than ENOENT - or an
 * exception from `update` - aborts without writing.
 */
export async function updateAppDataFile(
  filePath: string,
  update: (current: string | null) => string | null,
): Promise<void> {
  await withAppDataLock(path.dirname(filePath), async () => {
    let current: string | null = null;
    try {
      current = await retryTransient(() => fs.readFile(filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const next = update(current);
    if (next !== null) await writeUnlocked(filePath, next);
  });
}

function writeUnlocked(filePath: string, contents: string): Promise<void> {
  return writeFileAtomic(filePath, contents, { fsync: true, mode: 0o600 });
}

async function fileFingerprint(filePath: string): Promise<string | null> {
  try {
    const info = await fs.lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe app data path");
    const data = await fs.readFile(filePath);
    return `${data.byteLength}:${createHash("sha256").update(data).digest("hex")}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

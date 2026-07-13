import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
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

export async function updateAppDataFile(
  filePath: string,
  update: (current: string | null) => string,
): Promise<void> {
  await withAppDataLock(path.dirname(filePath), async () => {
    let current: string | null = null;
    try {
      current = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeUnlocked(filePath, update(current));
  });
}

async function writeUnlocked(filePath: string, contents: string): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  const handle = await fs.open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
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

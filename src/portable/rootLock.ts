import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

const LOCK_DIRECTORY = ".portable-store.lock";
const OWNER_FILE = "owner.json";
const HEARTBEAT_INTERVAL_MS = 1_000;
const STALE_HEARTBEAT_MS = 2 * 60 * 1_000;
const LOCK_WAIT_MS = 30_000;
const RETRY_MS = 25;

interface LockOwner {
  token: string;
  pid: number;
  createdAt: string;
  heartbeatAt: string;
}

interface HeldLock {
  directory: string;
  ownerPath: string;
  owner: LockOwner;
  heartbeat: ReturnType<typeof setInterval>;
  heartbeatWork: Promise<void>;
}

/**
 * Coordinates QuotaBar store operations across processes on one machine and one local filesystem.
 * The app-owned root directory is trusted. This is API-level crash recovery, not power-loss durability.
 */
export async function withPortableRootLock<T>(rootDir: string, operation: () => Promise<T>): Promise<T> {
  const held = await acquire(rootDir);
  let result!: T;
  let operationFailed = false;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    await release(held);
  } catch (error) {
    if (!operationFailed) throw error;
  }
  if (operationFailed) throw operationError;
  return result;
}

async function acquire(rootDir: string): Promise<HeldLock> {
  await fs.mkdir(rootDir, { recursive: true });
  const directory = path.join(rootDir, LOCK_DIRECTORY);
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    const owner = newOwner();
    try {
      await fs.mkdir(directory);
      const ownerPath = path.join(directory, OWNER_FILE);
      try {
        await writeOwner(ownerPath, owner);
      } catch (error) {
        await removeOwnedDirectory(directory, owner.token);
        throw error;
      }
      const held: HeldLock = {
        directory,
        ownerPath,
        owner,
        heartbeat: undefined as unknown as ReturnType<typeof setInterval>,
        heartbeatWork: Promise.resolve(),
      };
      held.heartbeat = setInterval(() => {
        held.heartbeatWork = held.heartbeatWork.then(async () => {
          const current = await readOwner(held.ownerPath);
          if (!current || current.token !== held.owner.token) return;
          held.owner = { ...held.owner, heartbeatAt: new Date().toISOString() };
          await writeOwner(held.ownerPath, held.owner);
        }).catch(() => undefined);
      }, HEARTBEAT_INTERVAL_MS);
      held.heartbeat.unref();
      return held;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      await reclaimIfAbandoned(directory);
      if (Date.now() >= deadline) throw new Error("Timed out waiting for portable store lock", { cause: error });
      await delay(RETRY_MS);
    }
  }
}

async function release(held: HeldLock): Promise<void> {
  clearInterval(held.heartbeat);
  await held.heartbeatWork.catch(() => undefined);
  const current = await readOwner(held.ownerPath);
  if (!current || current.token !== held.owner.token) return;
  const released = `${held.directory}.released.${held.owner.token}`;
  try {
    await replaceWithRetry(held.directory, released);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  await removeKnownLockDirectory(released).catch(() => undefined);
}

async function reclaimIfAbandoned(directory: string): Promise<void> {
  const ownerPath = path.join(directory, OWNER_FILE);
  const owner = await readOwner(ownerPath);
  if (owner) {
    const heartbeat = Date.parse(owner.heartbeatAt);
    if (isPidAlive(owner.pid) && Number.isFinite(heartbeat) && Date.now() - heartbeat <= STALE_HEARTBEAT_MS) return;
    const confirmed = await readOwner(ownerPath);
    if (!confirmed || confirmed.token !== owner.token || confirmed.heartbeatAt !== owner.heartbeatAt) return;
  } else {
    let info;
    try {
      try {
        info = await fs.lstat(ownerPath);
      } catch (error) {
        if (!isMissing(error)) throw error;
        info = await fs.lstat(directory);
      }
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (Date.now() - info.mtimeMs <= STALE_HEARTBEAT_MS) return;
    if (await readOwner(ownerPath)) return;
  }

  const abandoned = `${directory}.abandoned.${randomUUID()}`;
  try {
    await fs.rename(directory, abandoned);
  } catch (error) {
    if (isMissing(error) || (error as NodeJS.ErrnoException)?.code === "EACCES"
      || (error as NodeJS.ErrnoException)?.code === "EPERM") return;
    throw error;
  }
  await removeKnownLockDirectory(abandoned);
}

async function writeOwner(ownerPath: string, owner: LockOwner): Promise<void> {
  const temporary = path.join(path.dirname(ownerPath), `owner.${owner.token}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx" });
    await replaceWithRetry(temporary, ownerPath);
  } catch (error) {
    try {
      await fs.unlink(temporary);
    } catch {
      // Preserve the primary lock write failure.
    }
    throw error;
  }
}

async function replaceWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if ((code !== "EPERM" && code !== "EACCES") || attempt >= 2) throw error;
      await delay(10 * (attempt + 1));
    }
  }
}

async function readOwner(ownerPath: string): Promise<LockOwner | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(ownerPath, "utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    const owner = parsed as Record<string, unknown>;
    if (typeof owner.token !== "string" || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0
      || typeof owner.createdAt !== "string" || !Number.isFinite(Date.parse(owner.createdAt))
      || typeof owner.heartbeatAt !== "string" || !Number.isFinite(Date.parse(owner.heartbeatAt))) return undefined;
    return {
      token: owner.token,
      pid: owner.pid as number,
      createdAt: owner.createdAt,
      heartbeatAt: owner.heartbeatAt,
    };
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function removeOwnedDirectory(directory: string, token: string): Promise<void> {
  const ownerPath = path.join(directory, OWNER_FILE);
  const owner = await readOwner(ownerPath);
  if (owner && owner.token !== token) return;
  await removeKnownLockDirectory(directory);
}

async function removeKnownLockDirectory(directory: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || (entry.name !== OWNER_FILE && !/^owner\.[0-9a-f-]+\.tmp$/i.test(entry.name))) return;
  }
  for (const entry of entries) await fs.unlink(path.join(directory, entry.name));
  await fs.rmdir(directory);
}

function newOwner(): LockOwner {
  const now = new Date().toISOString();
  return { token: randomUUID(), pid: process.pid, createdAt: now, heartbeatAt: now };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

const LOCK_DIRECTORY = ".portable-store.lock";
const INGESTION_LOCK_DIRECTORY = ".portable-ingestion.lock";
const MIGRATION_LOCK_DIRECTORY = ".portable-migration.lock";
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
  firstHeartbeatError?: unknown;
  runtime: RootLockRuntime;
}

export type RootLockFileSystem = Pick<
  typeof fs,
  "lstat" | "mkdir" | "readFile" | "readdir" | "rename" | "rmdir" | "unlink" | "writeFile"
>;

export interface PortableRootLockDependencies {
  fileSystem?: RootLockFileSystem;
  isPidAlive?: (pid: number) => boolean;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

interface RootLockRuntime {
  fileSystem: RootLockFileSystem;
  isPidAlive: (pid: number) => boolean;
  now: () => number;
  wait: (milliseconds: number) => Promise<void>;
}

/**
 * Coordinates QuotaBar store operations across processes on one machine and one local filesystem.
 * The app-owned root directory is trusted. This is API-level crash recovery, not power-loss durability.
 */
export async function withPortableRootLock<T>(
  rootDir: string,
  operation: () => Promise<T>,
  dependencies: PortableRootLockDependencies = {},
): Promise<T> {
  return withNamedPortableRootLock(rootDir, LOCK_DIRECTORY, operation, dependencies);
}

export async function withNamedPortableRootLock<T>(
  rootDir: string,
  lockDirectory: ".portable-store.lock" | ".portable-ingestion.lock" | ".portable-migration.lock",
  operation: () => Promise<T>,
  dependencies: PortableRootLockDependencies = {},
): Promise<T> {
  if (lockDirectory !== LOCK_DIRECTORY
    && lockDirectory !== INGESTION_LOCK_DIRECTORY
    && lockDirectory !== MIGRATION_LOCK_DIRECTORY) {
    throw new Error("Unsupported portable lock name");
  }
  const held = await acquire(rootDir, lockDirectory, createRuntime(dependencies));
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
    const releaseError = attachDiagnosticCause(error, held.firstHeartbeatError);
    if (!operationFailed) {
      throw new Error("Portable store operation committed but lock cleanup failed", { cause: error });
    }
    operationError = attachDiagnosticCause(operationError, releaseError);
  }
  if (operationFailed) throw attachDiagnosticCause(operationError, held.firstHeartbeatError);
  return result;
}

async function acquire(rootDir: string, lockDirectory: string, runtime: RootLockRuntime): Promise<HeldLock> {
  await runtime.fileSystem.mkdir(rootDir, { recursive: true });
  const directory = path.join(rootDir, lockDirectory);
  const deadline = runtime.now() + LOCK_WAIT_MS;
  while (true) {
    const owner = newOwner(runtime);
    try {
      await runtime.fileSystem.mkdir(directory);
      const ownerPath = path.join(directory, OWNER_FILE);
      try {
        await writeOwner(ownerPath, owner, runtime);
      } catch (error) {
        await removeOwnedDirectory(directory, owner.token, runtime);
        throw error;
      }
      const held: HeldLock = {
        directory,
        ownerPath,
        owner,
        heartbeat: undefined as unknown as ReturnType<typeof setInterval>,
        heartbeatWork: Promise.resolve(),
        runtime,
      };
      held.heartbeat = setInterval(() => {
        held.heartbeatWork = held.heartbeatWork.then(async () => {
          const current = await readOwner(held.ownerPath, runtime);
          if (!current || current.token !== held.owner.token) return;
          held.owner = { ...held.owner, heartbeatAt: new Date(runtime.now()).toISOString() };
          await writeOwner(held.ownerPath, held.owner, runtime);
        }).catch((error: unknown) => {
          held.firstHeartbeatError ??= error;
        });
      }, HEARTBEAT_INTERVAL_MS);
      held.heartbeat.unref();
      return held;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      await reclaimIfAbandoned(directory, runtime);
      if (runtime.now() >= deadline) throw new Error("Timed out waiting for portable store lock", { cause: error });
      await runtime.wait(RETRY_MS);
    }
  }
}

async function release(held: HeldLock): Promise<void> {
  const { runtime } = held;
  clearInterval(held.heartbeat);
  await held.heartbeatWork.catch(() => undefined);
  const current = await readOwner(held.ownerPath, runtime);
  if (!current || current.token !== held.owner.token) {
    throw new Error("Portable store lock ownership changed before release");
  }
  const released = `${held.directory}.released.${held.owner.token}`;
  try {
    await replaceWithRetry(held.directory, released, runtime);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  await removeKnownLockDirectory(released, runtime).catch(() => undefined);
}

async function reclaimIfAbandoned(directory: string, runtime: RootLockRuntime): Promise<void> {
  const ownerPath = path.join(directory, OWNER_FILE);
  const owner = await readOwner(ownerPath, runtime);
  if (owner) {
    if (runtime.isPidAlive(owner.pid)) return;
    const confirmed = await readOwner(ownerPath, runtime);
    if (!confirmed || confirmed.token !== owner.token || confirmed.heartbeatAt !== owner.heartbeatAt) return;
  } else {
    let info;
    try {
      try {
        info = await runtime.fileSystem.lstat(ownerPath);
      } catch (error) {
        if (!isMissing(error)) throw error;
        info = await runtime.fileSystem.lstat(directory);
      }
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (runtime.now() - info.mtimeMs <= STALE_HEARTBEAT_MS) return;
    if (await readOwner(ownerPath, runtime)) return;
  }

  const abandoned = `${directory}.abandoned.${randomUUID()}`;
  try {
    await runtime.fileSystem.rename(directory, abandoned);
  } catch (error) {
    if (isMissing(error) || (error as NodeJS.ErrnoException)?.code === "EACCES"
      || (error as NodeJS.ErrnoException)?.code === "EPERM") return;
    throw error;
  }
  await removeKnownLockDirectory(abandoned, runtime);
}

async function writeOwner(ownerPath: string, owner: LockOwner, runtime: RootLockRuntime): Promise<void> {
  const temporary = path.join(path.dirname(ownerPath), `owner.${owner.token}.tmp`);
  try {
    await runtime.fileSystem.writeFile(temporary, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx" });
    await replaceWithRetry(temporary, ownerPath, runtime);
  } catch (error) {
    try {
      await runtime.fileSystem.unlink(temporary);
    } catch {
      // Preserve the primary lock write failure.
    }
    throw error;
  }
}

async function replaceWithRetry(from: string, to: string, runtime: RootLockRuntime): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await runtime.fileSystem.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if ((code !== "EPERM" && code !== "EACCES") || attempt >= 2) throw error;
      await runtime.wait(10 * (attempt + 1));
    }
  }
}

async function readOwner(ownerPath: string, runtime: RootLockRuntime): Promise<LockOwner | undefined> {
  try {
    const parsed: unknown = JSON.parse(await runtime.fileSystem.readFile(ownerPath, "utf8"));
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

async function removeOwnedDirectory(directory: string, token: string, runtime: RootLockRuntime): Promise<void> {
  const ownerPath = path.join(directory, OWNER_FILE);
  const owner = await readOwner(ownerPath, runtime);
  if (owner && owner.token !== token) return;
  await removeKnownLockDirectory(directory, runtime);
}

async function removeKnownLockDirectory(directory: string, runtime: RootLockRuntime): Promise<void> {
  let entries;
  try {
    entries = await runtime.fileSystem.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || (entry.name !== OWNER_FILE && !/^owner\.[0-9a-f-]+\.tmp$/i.test(entry.name))) return;
  }
  for (const entry of entries) await runtime.fileSystem.unlink(path.join(directory, entry.name));
  await runtime.fileSystem.rmdir(directory);
}

function newOwner(runtime: RootLockRuntime): LockOwner {
  const now = new Date(runtime.now()).toISOString();
  return { token: randomUUID(), pid: process.pid, createdAt: now, heartbeatAt: now };
}

function checkPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

function createRuntime(dependencies: PortableRootLockDependencies): RootLockRuntime {
  return {
    fileSystem: dependencies.fileSystem ?? fs,
    isPidAlive: dependencies.isPidAlive ?? checkPidAlive,
    now: dependencies.now ?? (() => Date.now()),
    wait: dependencies.wait ?? delay,
  };
}

function attachDiagnosticCause(error: unknown, diagnostic: unknown): unknown {
  if (diagnostic === undefined || !(error instanceof Error)) return error;
  if (error.cause === undefined) {
    Object.defineProperty(error, "cause", { configurable: true, value: diagnostic });
  }
  return error;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

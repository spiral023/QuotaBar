import * as nodeFs from "node:fs/promises";
import type { PathLike } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withNamedPortableRootLock, withPortableRootLock } from "../src/portable/rootLock";

const OWNER_TOKEN = "00000000-0000-4000-8000-000000000001";
const OWNER_PID = 4242;

describe("portable root lock", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "quotabar-root-lock-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("supports an independent allowlisted ingestion lock", async () => {
    let ran = false;
    await withNamedPortableRootLock(rootDir, ".portable-ingestion.lock", async () => { ran = true; });
    expect(ran).toBe(true);
    await expect(nodeFs.access(path.join(rootDir, ".portable-ingestion.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never reclaims a stale lock whose owner PID is alive", async () => {
    const now = Date.parse("2026-07-13T12:00:00.000Z");
    await createOwner(rootDir, {
      token: OWNER_TOKEN,
      pid: OWNER_PID,
      createdAt: "2026-07-01T00:00:00.000Z",
      heartbeatAt: "2026-07-01T00:00:00.000Z",
    });
    const clock = fastClock(now);

    await expect(withPortableRootLock(rootDir, async () => undefined, {
      ...clock,
      isPidAlive: () => true,
    })).rejects.toThrow("Timed out waiting for portable store lock");

    expect(JSON.parse(await readFile(ownerPath(rootDir), "utf8"))).toMatchObject({ token: OWNER_TOKEN });
  });

  it("reclaims a valid lock when its owner PID is dead", async () => {
    const now = Date.parse("2026-07-13T12:00:00.000Z");
    await createOwner(rootDir, {
      token: OWNER_TOKEN,
      pid: OWNER_PID,
      createdAt: new Date(now).toISOString(),
      heartbeatAt: new Date(now).toISOString(),
    });
    let ran = false;

    await withPortableRootLock(rootDir, async () => { ran = true; }, {
      ...fastClock(now),
      isPidAlive: () => false,
    });

    expect(ran).toBe(true);
    await expect(nodeFs.access(lockDir(rootDir))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims a corrupt lock only after it is stale", async () => {
    const now = Date.parse("2026-07-13T12:00:00.000Z");
    await mkdir(lockDir(rootDir));
    await writeFile(ownerPath(rootDir), "not-json", "utf8");
    const old = new Date("2026-07-01T00:00:00.000Z");
    await utimes(ownerPath(rootDir), old, old);

    await withPortableRootLock(rootDir, async () => undefined, fastClock(now));

    await expect(nodeFs.access(lockDir(rootDir))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not reclaim a fresh corrupt lock", async () => {
    const now = Date.now();
    await mkdir(lockDir(rootDir));
    await writeFile(ownerPath(rootDir), "not-json", "utf8");

    await expect(withPortableRootLock(rootDir, async () => undefined, fastClock(now)))
      .rejects.toThrow("Timed out waiting for portable store lock");

    await expect(readFile(ownerPath(rootDir), "utf8")).resolves.toBe("not-json");
  });

  it("retries bounded access errors while releasing the lock directory", async () => {
    let releaseAttempts = 0;
    const retryingFs = {
      ...nodeFs,
      async rename(from: PathLike, to: PathLike) {
        if (String(from).endsWith(".portable-store.lock") && releaseAttempts++ < 2) {
          throw Object.assign(new Error("injected release contention"), { code: "EPERM" });
        }
        return nodeFs.rename(from, to);
      },
    };

    await withPortableRootLock(rootDir, async () => undefined, {
      fileSystem: retryingFs,
      wait: async () => undefined,
    });

    expect(releaseAttempts).toBe(3);
  });

  it("reports committed-operation ambiguity when final lock cleanup fails", async () => {
    let committed = false;
    const failingFs = {
      ...nodeFs,
      async rename(from: PathLike, to: PathLike) {
        if (String(from).endsWith(".portable-store.lock")) {
          throw Object.assign(new Error("injected release failure"), { code: "EPERM" });
        }
        return nodeFs.rename(from, to);
      },
    };

    let caught: unknown;
    try {
      await withPortableRootLock(rootDir, async () => { committed = true; }, {
        fileSystem: failingFs,
        wait: async () => undefined,
      });
    } catch (error) {
      caught = error;
    }

    expect(committed).toBe(true);
    expect(caught).toMatchObject({
      message: "Portable store operation committed but lock cleanup failed",
      cause: { code: "EPERM" },
    });
  });
});

async function createOwner(rootDir: string, owner: Record<string, unknown>): Promise<void> {
  await mkdir(lockDir(rootDir));
  await writeFile(ownerPath(rootDir), `${JSON.stringify(owner)}\n`, "utf8");
}

function lockDir(rootDir: string): string {
  return path.join(rootDir, ".portable-store.lock");
}

function ownerPath(rootDir: string): string {
  return path.join(lockDir(rootDir), "owner.json");
}

function fastClock(start: number): { now: () => number; wait: (milliseconds: number) => Promise<void> } {
  let current = start;
  return {
    now: () => current,
    wait: async (milliseconds) => { current += milliseconds; },
  };
}

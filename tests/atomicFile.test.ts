import * as nodeFs from "node:fs/promises";
import type { PathLike } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RENAME_RETRY_ATTEMPTS,
  renameRetryDelay,
  renameWithRetry,
  siblingTemporaryPath,
  writeFileAtomic,
} from "../src/shared/atomicFile";
import { boundaryError, errnoCode, errnoSuffix, isBoundaryError } from "../src/shared/errors";
import { TEMP_FILE } from "../src/portable/usageStoreFormat";

function errno(code: string, message = `injected ${code} at C:\\Users\\someone\\secret.json`): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

describe("renameWithRetry", () => {
  it("retries transient Windows sharing errors with exponential backoff", async () => {
    const waits: number[] = [];
    let attempts = 0;
    await renameWithRetry("a", "b", {
      rename: async () => {
        attempts += 1;
        if (attempts < 4) throw errno(["EPERM", "EBUSY", "EACCES"][attempts - 1]);
      },
      wait: async (ms) => { waits.push(ms); },
    });
    expect(attempts).toBe(4);
    expect(waits).toEqual([16, 32, 64]);
  });

  it("gives up after the bounded number of attempts with the last error", async () => {
    const waits: number[] = [];
    let attempts = 0;
    await expect(renameWithRetry("a", "b", {
      rename: async () => { attempts += 1; throw errno("EBUSY"); },
      wait: async (ms) => { waits.push(ms); },
    })).rejects.toMatchObject({ code: "EBUSY" });
    expect(attempts).toBe(RENAME_RETRY_ATTEMPTS);
    expect(waits).toEqual([16, 32, 64, 128, 256]);
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(600);
  });

  it("does not retry non-transient errors", async () => {
    let attempts = 0;
    await expect(renameWithRetry("a", "b", {
      rename: async () => { attempts += 1; throw errno("ENOENT"); },
      wait: async () => { throw new Error("must not wait"); },
    })).rejects.toMatchObject({ code: "ENOENT" });
    expect(attempts).toBe(1);
  });

  it("caps the backoff delay", () => {
    expect(renameRetryDelay(1)).toBe(16);
    expect(renameRetryDelay(20)).toBe(500);
  });
});

describe("writeFileAtomic", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "quotabar-atomic-file-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("replaces the target and leaves no temporary file behind", async () => {
    const target = path.join(dir, "nested", "settings.json");
    await writeFileAtomic(target, "one", { createParent: true });
    await writeFileAtomic(target, "two");
    expect(await readFile(target, "utf8")).toBe("two");
    expect(await readdir(path.dirname(target))).toEqual(["settings.json"]);
  });

  it("writes binary contents unchanged", async () => {
    const target = path.join(dir, "blob.bin");
    await writeFileAtomic(target, Uint8Array.from([0, 255, 10, 13]));
    expect([...await readFile(target)]).toEqual([0, 255, 10, 13]);
  });

  it("requests a flush only when fsync is set", async () => {
    const flags: unknown[] = [];
    const spyFs = {
      ...nodeFs,
      async writeFile(file: PathLike, data: string | Uint8Array, options?: unknown) {
        flags.push((options as { flush?: boolean }).flush);
        return nodeFs.writeFile(file, data, options as Parameters<typeof nodeFs.writeFile>[2]);
      },
    };
    await writeFileAtomic(path.join(dir, "a.json"), "{}", { fileSystem: spyFs });
    await writeFileAtomic(path.join(dir, "b.json"), "{}", { fileSystem: spyFs, fsync: true });
    expect(flags).toEqual([undefined, true]);
  });

  it("retries a locked target and then succeeds", async () => {
    const target = path.join(dir, "state.json");
    await writeFile(target, "old", "utf8");
    let failures = 2;
    const lockedFs = {
      ...nodeFs,
      async rename(from: PathLike, to: PathLike) {
        if (failures-- > 0) throw errno("EBUSY");
        return nodeFs.rename(from, to);
      },
    };
    await writeFileAtomic(target, "new", { fileSystem: lockedFs, wait: async () => undefined });
    expect(await readFile(target, "utf8")).toBe("new");
    expect(await readdir(dir)).toEqual(["state.json"]);
  });

  it("removes the temporary file and keeps the old target when the rename fails", async () => {
    const target = path.join(dir, "state.json");
    await writeFile(target, "old", "utf8");
    const failingFs = {
      ...nodeFs,
      async rename() { throw errno("EPERM"); },
    };
    await expect(writeFileAtomic(target, "new", { fileSystem: failingFs, wait: async () => undefined }))
      .rejects.toMatchObject({ code: "EPERM" });
    expect(await readFile(target, "utf8")).toBe("old");
    expect(await readdir(dir)).toEqual(["state.json"]);
  });

  it("refuses to reuse an existing temporary path", async () => {
    const target = path.join(dir, "owner.json");
    const temporary = path.join(dir, "owner.planted.tmp");
    await writeFile(temporary, "planted", "utf8");
    await expect(writeFileAtomic(target, "mine", { temporaryPath: temporary })).rejects.toMatchObject({ code: "EEXIST" });
    await expect(nodeFs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses temporary names the portable store cleanup recognizes", () => {
    for (const name of ["store-metadata.json", "ingest-state.json", "pending-store-transaction.json", "2026-07.jsonl"]) {
      expect(TEMP_FILE.test(path.basename(siblingTemporaryPath(path.join(dir, name))))).toBe(true);
    }
  });
});

describe("boundary errors", () => {
  it("keeps the errno code but never the path-bearing message", () => {
    const error = boundaryError("Portable usage reconciliation failed", errno("EBUSY"));
    expect(error.message).toBe("Portable usage reconciliation failed (EBUSY)");
    expect(error.code).toBe("EBUSY");
    expect(error.message).not.toContain("secret");
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("finds a code on the cause chain and ignores non-errno codes", () => {
    const nested = new Error("outer", { cause: new Error("middle", { cause: errno("EACCES") }) });
    expect(errnoCode(nested)).toBe("EACCES");
    expect(errnoCode(Object.assign(new Error("x"), { code: "ERR_INVALID_ARG_TYPE" }))).toBeUndefined();
    expect(errnoCode(Object.assign(new Error("x"), { code: "C:\\path" }))).toBeUndefined();
    expect(errnoSuffix(new Error("plain"))).toBe("");
    expect(boundaryError("Portable ingest state read failed", new Error("plain")).message)
      .toBe("Portable ingest state read failed");
  });

  it("recognizes boundary messages with and without an errno suffix", () => {
    expect(isBoundaryError(new Error("Portable migration state write failed"), "Portable migration state write failed")).toBe(true);
    expect(isBoundaryError(boundaryError("Portable migration state write failed", errno("EPERM")), "Portable migration state write failed")).toBe(true);
    expect(isBoundaryError(new Error("Portable migration state write failed later"), "Portable migration state write failed")).toBe(false);
  });
});

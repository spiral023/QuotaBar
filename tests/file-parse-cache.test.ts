import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileParseCache } from "../src/pricing/file-parse-cache";

const tmpRoot = path.join(os.tmpdir(), `quotabar-file-cache-${process.pid}`);

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("FileParseCache", () => {
  it("evicts the least recently used file while retaining hot entries", async () => {
    await fs.mkdir(tmpRoot, { recursive: true });
    const files = ["a", "b", "c"].map(name => path.join(tmpRoot, name));
    for (const file of files) await fs.writeFile(file, "fixture");
    const cache = new FileParseCache<string[]>(2);
    await cache.get(files[0], async () => ["a"]);
    await cache.get(files[1], async () => ["b"]);
    expect(await cache.get(files[0], async () => ["unexpected"])).toEqual(["a"]);
    await cache.get(files[2], async () => ["c"]);
    expect(await cache.get(files[0], async () => ["unexpected"])).toEqual(["a"]);
    expect(await cache.get(files[1], async () => ["reparsed"])).toEqual(["reparsed"]);
  });

  it("bounds retained array items and skips a single oversized parse", async () => {
    await fs.mkdir(tmpRoot, { recursive: true });
    const files = ["a", "b", "large"].map(name => path.join(tmpRoot, name));
    for (const file of files) await fs.writeFile(file, "fixture");
    const cache = new FileParseCache<number[]>(10, 3);
    await cache.get(files[0], async () => [1, 2]);
    await cache.get(files[1], async () => [3, 4]);
    expect(await cache.get(files[0], async () => [5])).toEqual([5]);
    await cache.get(files[2], async () => [1, 2, 3, 4]);
    expect(await cache.get(files[2], async () => [6])).toEqual([6]);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("drops a disappeared file even when its fallback parser fails", async () => {
    await fs.mkdir(tmpRoot, { recursive: true });
    const file = path.join(tmpRoot, "removed"); await fs.writeFile(file, "fixture");
    const cache = new FileParseCache<string[]>();
    await cache.get(file, async () => ["held"]);
    await fs.unlink(file);
    await expect(cache.get(file, async () => { throw new Error("missing"); })).rejects.toThrow("missing");
    expect(cache.size).toBe(0);
  });

  it("reuses parsed output while path, mtime, and size stay unchanged", async () => {
    const filePath = path.join(tmpRoot, "session.jsonl");
    await fs.mkdir(tmpRoot, { recursive: true });
    await fs.writeFile(filePath, "one\n", "utf8");

    const cache = new FileParseCache<string[]>();
    let parseCount = 0;

    const first = await cache.get(filePath, async () => {
      parseCount++;
      return ["parsed"];
    });
    const second = await cache.get(filePath, async () => {
      parseCount++;
      return ["parsed-again"];
    });

    expect(first).toEqual(["parsed"]);
    expect(second).toBe(first);
    expect(parseCount).toBe(1);
  });

  it("invalidates cached output when the file changes", async () => {
    const filePath = path.join(tmpRoot, "session.jsonl");
    await fs.mkdir(tmpRoot, { recursive: true });
    await fs.writeFile(filePath, "one\n", "utf8");

    const cache = new FileParseCache<string[]>();
    await cache.get(filePath, async () => ["old"]);
    await fs.writeFile(filePath, "one\ntwo\n", "utf8");

    const updated = await cache.get(filePath, async () => ["new"]);

    expect(updated).toEqual(["new"]);
  });

  it("falls back to parsing when file metadata cannot be read", async () => {
    const filePath = path.join(tmpRoot, "missing.jsonl");
    const cache = new FileParseCache<string[]>();

    const result = await cache.get(filePath, async () => []);

    expect(result).toEqual([]);
  });
});

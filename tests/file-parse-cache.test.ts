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

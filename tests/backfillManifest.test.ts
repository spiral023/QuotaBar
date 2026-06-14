import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadManifest, saveManifest, fileSignature, diffSources, getRepairedVersion, setRepairedVersion } from "../src/main/backfillManifest";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "qb-manifest-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("backfillManifest", () => {
  it("returns an empty manifest when none exists", async () => {
    const m = await loadManifest(tmp);
    expect(m.version).toBe(1);
    expect(m.sources).toEqual({});
  });

  it("returns an empty manifest when the file is corrupt", async () => {
    await fs.writeFile(path.join(tmp, "backfill-manifest.json"), "{ not json", "utf8");
    const m = await loadManifest(tmp);
    expect(m.sources).toEqual({});
  });

  it("round-trips a saved manifest", async () => {
    await saveManifest(tmp, { version: 1, sources: { "/a.jsonl": "10:123" }, lastRunAt: "2026-06-09T00:00:00.000Z" });
    const m = await loadManifest(tmp);
    expect(m.sources["/a.jsonl"]).toBe("10:123");
  });

  it("computes a size:mtime signature for an existing file", async () => {
    const f = path.join(tmp, "x.jsonl");
    await fs.writeFile(f, "hello", "utf8");
    const sig = await fileSignature(f);
    expect(sig).toMatch(/^\d+:\d+$/);
  });

  it("returns null signature for a missing file", async () => {
    expect(await fileSignature(path.join(tmp, "nope.jsonl"))).toBeNull();
  });

  it("diffSources reports changed and unchanged files", async () => {
    const prev = { "/a.jsonl": "1:100", "/b.jsonl": "2:200" };
    const current = { "/a.jsonl": "1:100", "/b.jsonl": "9:999", "/c.jsonl": "3:300" };
    const { changed, unchanged } = diffSources(prev, current);
    expect(changed.sort()).toEqual(["/b.jsonl", "/c.jsonl"]);
    expect(unchanged).toEqual(["/a.jsonl"]);
  });

  it("reports repaired version 0 when no marker exists", async () => {
    expect(await getRepairedVersion(tmp)).toBe(0);
  });

  it("reports repaired version 0 when the marker is corrupt", async () => {
    await fs.writeFile(path.join(tmp, "backfill-repair.json"), "{ not json", "utf8");
    expect(await getRepairedVersion(tmp)).toBe(0);
  });

  it("round-trips the repaired version marker", async () => {
    await setRepairedVersion(tmp, 1);
    expect(await getRepairedVersion(tmp)).toBe(1);
  });
});

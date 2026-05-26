import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UsageSnapshot } from "../src/providers/types";
import { loadCachedSnapshots, markSnapshotsFromCache, saveCachedSnapshots } from "../src/usage/snapshotCache";

const tmpRoot = path.join(os.tmpdir(), `quotabar-snapshot-cache-${process.pid}`);

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function snapshot(provider: string, status: UsageSnapshot["status"] = "ok"): UsageSnapshot {
  return {
    provider,
    status,
    windows: [{ name: "fiveHour", usedPercent: 42 }],
    updatedAt: "2026-05-26T10:00:00.000Z",
  };
}

describe("snapshot cache", () => {
  it("round-trips usage snapshots through a JSON cache file", async () => {
    const cachePath = path.join(tmpRoot, "usage-snapshots.json");
    const snapshots = [snapshot("claude"), snapshot("codex", "not_authenticated")];

    await saveCachedSnapshots(cachePath, snapshots);

    expect(await loadCachedSnapshots(cachePath)).toEqual(snapshots);
  });

  it("returns an empty list for missing or invalid cache files", async () => {
    const missingPath = path.join(tmpRoot, "missing.json");
    const invalidPath = path.join(tmpRoot, "invalid.json");
    await fs.mkdir(tmpRoot, { recursive: true });
    await fs.writeFile(invalidPath, "{not-json", "utf8");

    expect(await loadCachedSnapshots(missingPath)).toEqual([]);
    expect(await loadCachedSnapshots(invalidPath)).toEqual([]);
  });

  it("marks cached ok snapshots as stale without changing auth failures", () => {
    const result = markSnapshotsFromCache([
      snapshot("claude", "ok"),
      snapshot("codex", "not_authenticated"),
    ], "2026-05-26T11:00:00.000Z");

    expect(result[0]).toMatchObject({
      provider: "claude",
      status: "stale",
      updatedAt: "2026-05-26T11:00:00.000Z",
      errorMessage: "Showing cached data while refreshing",
    });
    expect(result[1]).toMatchObject({
      provider: "codex",
      status: "not_authenticated",
      updatedAt: "2026-05-26T10:00:00.000Z",
    });
  });
});

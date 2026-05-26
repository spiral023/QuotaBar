import fs from "node:fs/promises";
import path from "node:path";
import type { UsageSnapshot } from "../providers/types";

export async function loadCachedSnapshots(cachePath: string): Promise<UsageSnapshot[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isUsageSnapshot);
  } catch {
    return [];
  }
}

export async function saveCachedSnapshots(cachePath: string, snapshots: UsageSnapshot[]): Promise<void> {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, `${JSON.stringify(snapshots, null, 2)}\n`, "utf8");
}

export function markSnapshotsFromCache(snapshots: UsageSnapshot[], nowIso = new Date().toISOString()): UsageSnapshot[] {
  return snapshots.map((snapshot) => {
    if (snapshot.status !== "ok") return snapshot;
    return {
      ...snapshot,
      status: "stale",
      updatedAt: nowIso,
      errorMessage: "Showing cached data while refreshing",
    };
  });
}

function isUsageSnapshot(value: unknown): value is UsageSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.provider === "string"
    && typeof record.status === "string"
    && Array.isArray(record.windows)
    && typeof record.updatedAt === "string";
}

import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SnapshotEvent } from "../../src/main/debugEvents";
import { appendQuotaSnapshots } from "../../src/portable/quotaStore";

const root = process.env.QUOTABAR_QUOTA_CHILD_ROOT;
const childId = process.env.QUOTABAR_QUOTA_CHILD_ID;
const childDescribe = root && (childId === "a" || childId === "b") ? describe : describe.skip;

childDescribe("portable quota store child", () => {
  it("appends its snapshots after both children are ready", async () => {
    await writeFile(path.join(root!, `ready-${childId}`), "ready", "utf8");
    await waitFor(path.join(root!, "children-go"));
    const snapshots = childId === "a"
      ? [snapshot("claude", "2026-06-01T00:00:00.000Z"), snapshot("claude", "2026-07-02T00:00:00.000Z")]
      : [snapshot("codex", "2026-07-01T00:00:00.000Z"), snapshot("codex", "2026-08-01T00:00:00.000Z")];

    await appendQuotaSnapshots(root!, snapshots);

    expect(snapshots).toHaveLength(2);
  });
});

function snapshot(provider: "claude" | "codex", fetchedAt: string): SnapshotEvent {
  return { kind: "snapshot", provider, status: "ok", windows: [{ name: "weekly", usedPercent: 1 }], fetchedAt };
}

async function waitFor(filePath: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("Timed out waiting for child barrier");
}

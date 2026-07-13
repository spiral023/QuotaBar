import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PortableUsageStore } from "../../src/portable/usageStore";
import type { PortableUsageEvent } from "../../src/portable/types";

const rootDir = process.env.QUOTABAR_PORTABLE_CHILD_ROOT;
const childId = process.env.QUOTABAR_PORTABLE_CHILD_ID;

describe.runIf(Boolean(rootDir && childId))("portable usage store child fixture", () => {
  it("upserts one event after the parent barrier", async () => {
    const root = rootDir as string;
    const id = childId as string;
    await writeFile(path.join(root, `ready-${id}`), "ready", "utf8");
    const startAt = await waitForStart(path.join(root, "child-go"));
    while (Date.now() < startAt) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await expect(new PortableUsageStore(root).upsert([event(id)])).resolves.toEqual({
      inserted: 1,
      existing: 0,
    });
  });
});

function event(id: string): PortableUsageEvent {
  return {
    schemaVersion: 1,
    id,
    provider: "claude",
    occurredAt: id === "process-a" ? "2026-07-01T00:00:00.000Z" : "2026-07-02T00:00:00.000Z",
    model: "claude-sonnet-4",
    sessionKey: `session-${id}`,
    source: "claude-log",
    synthetic: false,
    inputTokens: 1,
    outputTokens: 2,
    cacheCreationTokens: 3,
    cacheReadTokens: 4,
    reasoningOutputTokens: 0,
  };
}

async function waitForStart(filePath: string): Promise<number> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      return Number(await readFile(filePath, "utf8"));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("Timed out waiting for parent barrier");
}

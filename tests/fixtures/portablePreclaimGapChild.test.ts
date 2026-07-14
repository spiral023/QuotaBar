import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  beginMigrationRefresh,
  markMigrationComplete,
  markMigrationFailed,
  migrateLegacyData,
} from "../../src/portable/migration";
import { PortableUsageStore } from "../../src/portable/usageStore";

const root = process.env.QUOTABAR_PRECLAIM_ROOT;
const role = process.env.QUOTABAR_PRECLAIM_ROLE;

describe.runIf(Boolean(root && role))("portable preclaim gap child", () => {
  it("coordinates ingestion between complete and a refresh claim", async () => {
    const usageRoot = root as string;
    const statePath = path.join(usageRoot, "migration-state.json");
    const store = new PortableUsageStore(usageRoot);
    const completeState = JSON.parse(await readFile(statePath, "utf8")) as { storeRevision: string };

    if (role === "a") {
      await writeFile(path.join(usageRoot, "preclaim-a-ready"), "ready", "utf8");
      await waitFor(path.join(usageRoot, "preclaim-b-ingested"));
      const result = await markMigrationFailed(
        statePath,
        "consumer_prewarm_failed",
        { status: "complete", storeRevision: completeState.storeRevision },
        store,
      );
      await writeFile(path.join(usageRoot, "preclaim-a-result.json"), JSON.stringify(result), "utf8");
      expect(result.status).toBe("stale_revision");
    } else {
      await waitFor(path.join(usageRoot, "preclaim-a-ready"));
      await store.upsert([{
        schemaVersion: 1,
        id: "preclaim-child-newer",
        provider: "claude",
        occurredAt: "2026-07-13T12:00:00.000Z",
        model: "model",
        sessionKey: "preclaim-child-session",
        source: "claude-log",
        synthetic: false,
        inputTokens: 1,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        reasoningOutputTokens: 0,
      }]);
      await writeFile(path.join(usageRoot, "preclaim-b-ingested"), "ready", "utf8");
      await waitFor(path.join(usageRoot, "preclaim-a-result.json"));
      const begun = await beginMigrationRefresh(statePath, completeState.storeRevision);
      if (begun.status !== "applied") throw new Error("Preclaim owner B did not start");
      const migrated = await migrateLegacyData({
        store,
        records: [],
        statePath,
        finalizeState: false,
        expectedOwner: begun.owner,
      });
      const result = await markMigrationComplete(statePath, migrated.storeRevision, store, begun.owner);
      await writeFile(path.join(usageRoot, "preclaim-b-result.json"), JSON.stringify(result), "utf8");
      expect(result.status).toBe("applied");
    }
  });
});

async function waitFor(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("Timed out waiting for portable preclaim barrier");
}

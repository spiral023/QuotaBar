import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { markMigrationComplete, markMigrationRunning, migrateLegacyData } from "../../src/portable/migration";
import { PortableUsageStore } from "../../src/portable/usageStore";

const root = process.env.QUOTABAR_FINALIZE_ROOT;
const role = process.env.QUOTABAR_FINALIZE_ROLE;

describe.runIf(Boolean(root && role))("portable revision finalization child", () => {
  it("coordinates a cross-process stale-revision barrier", async () => {
    const usageRoot = root as string;
    const statePath = path.join(usageRoot, "migration-state.json");
    const store = new PortableUsageStore(usageRoot);
    if (role === "a") {
      await markMigrationRunning(statePath);
      const migration = await migrateLegacyData({ store, records: [], statePath, finalizeState: false });
      await writeFile(path.join(usageRoot, "a-ready.json"), JSON.stringify({ revision: migration.storeRevision }), "utf8");
      await waitFor(path.join(usageRoot, "b-ready"));
      const result = await markMigrationComplete(statePath, migration.storeRevision, store);
      await writeFile(path.join(usageRoot, "a-result.json"), JSON.stringify(result), "utf8");
      expect(result.status).toBe("stale_revision");
    } else {
      await waitFor(path.join(usageRoot, "a-ready.json"));
      await store.upsert([{
        schemaVersion: 1, id: "cross-process-newer", provider: "claude",
        occurredAt: "2026-07-13T12:00:00.000Z", model: "model", sessionKey: "session",
        source: "claude-log", synthetic: false, inputTokens: 1, outputTokens: 0,
        cacheCreationTokens: 0, cacheReadTokens: 0, reasoningOutputTokens: 0,
      }]);
      await writeFile(path.join(usageRoot, "b-ready"), "ready", "utf8");
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
  throw new Error("Timed out waiting for portable finalization barrier");
}

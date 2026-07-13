import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  beginMigrationRefresh,
  markMigrationComplete,
  markMigrationRunning,
} from "../../src/portable/migration";
import { PortableUsageStore } from "../../src/portable/usageStore";

const root = process.env.QUOTABAR_REFRESH_OWNER_ROOT;
const role = process.env.QUOTABAR_REFRESH_OWNER_ROLE;

describe.runIf(Boolean(root && role))("portable refresh owner child", () => {
  it("prevents an older process from finalizing a newer running state", async () => {
    const usageRoot = root as string;
    const statePath = path.join(usageRoot, "migration-state.json");
    const store = new PortableUsageStore(usageRoot);
    const revision = await store.getRevision();

    if (role === "a") {
      const begun = await beginMigrationRefresh(
        statePath,
        revision,
        () => new Date("2026-07-13T12:00:00.000Z"),
      );
      if (begun.status !== "applied") throw new Error("Refresh owner A did not start");
      await writeFile(path.join(usageRoot, "refresh-a-ready.json"), JSON.stringify(begun.owner), "utf8");
      await waitFor(path.join(usageRoot, "refresh-b-ready"));
      const result = await markMigrationComplete(statePath, revision, store, begun.owner);
      await writeFile(path.join(usageRoot, "refresh-a-result.json"), JSON.stringify(result), "utf8");
      expect(result.status).toBe("not_running");
    } else {
      await waitFor(path.join(usageRoot, "refresh-a-ready.json"));
      await markMigrationRunning(statePath, () => new Date("2026-07-13T12:00:01.000Z"));
      await writeFile(path.join(usageRoot, "refresh-b-ready"), "ready", "utf8");
      await waitFor(path.join(usageRoot, "refresh-a-result.json"));
      const result = await markMigrationComplete(statePath, revision, store);
      await writeFile(path.join(usageRoot, "refresh-b-result.json"), JSON.stringify(result), "utf8");
      expect(result.status).toBe("applied");
      expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
        status: "complete",
        storeRevision: revision,
      });
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
  throw new Error("Timed out waiting for portable refresh owner barrier");
}

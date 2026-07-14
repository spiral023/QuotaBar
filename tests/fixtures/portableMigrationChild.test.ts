import { describe, expect, it } from "vitest";
import path from "node:path";
import { migrateLegacyData } from "../../src/portable/migration";
import type { LegacyDerivedPlan, LegacyDerivedResult } from "../../src/portable/usageStore";
import { PortableUsageStore } from "../../src/portable/usageStore";
import type { PortableUsageEvent } from "../../src/portable/types";
import type { BackfillDayRecord } from "../../src/reports/types";

const rootDir = process.env.QUOTABAR_MIGRATION_CHILD_ROOT;
const target = Number(process.env.QUOTABAR_MIGRATION_CHILD_TARGET);
const delayMs = Number(process.env.QUOTABAR_MIGRATION_CHILD_DELAY ?? 0);

class DelayedPortableUsageStore extends PortableUsageStore {
  override async reconcileLegacyDerived(
    builder: (currentEvents: readonly PortableUsageEvent[], revision: string) => LegacyDerivedPlan,
  ): Promise<LegacyDerivedResult> {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return super.reconcileLegacyDerived(builder);
  }
}

describe.runIf(Boolean(rootDir && Number.isFinite(target)))("portable migration child fixture", () => {
  it("migrates one legacy snapshot", async () => {
    const root = rootDir as string;
    const record: BackfillDayRecord = {
      date: "2026-05-20",
      provider: "claude",
      inputTokens: target,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: target,
      costUSD: 0,
      sessionCount: 1,
      models: ["model"],
      perModel: {
        model: {
          inputTokens: target,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: target,
          costUSD: 0,
        },
      },
    };
    await expect(migrateLegacyData({
      store: new DelayedPortableUsageStore(root),
      records: [record],
      statePath: path.join(root, "migration-state.json"),
    })).resolves.toMatchObject({ status: "complete" });
  });
});

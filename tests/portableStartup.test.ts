import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createPortableIngestionRunner,
  preparePortableData,
  readLegacyQuotaSnapshots,
} from "../src/main/debugBackfill";
import {
  markMigrationComplete,
  markMigrationFailed,
  markMigrationRunning,
  migrateLegacyData,
  parseMigrationState,
} from "../src/portable/migration";
import { appendQuotaSnapshots, readQuotaSnapshots } from "../src/portable/quotaStore";
import { PortableUsageStore } from "../src/portable/usageStore";

describe("portable startup preparation", () => {
  it("integrates preparation after runtime discovery and before analytics prewarm", async () => {
    const source = await readFile(path.resolve("src/main/main.ts"), "utf8");
    const discovery = source.indexOf("await refreshRuntimeWslAgentRoots()");
    const preparation = source.indexOf("await preparePortableData(");
    const prewarm = source.indexOf("prewarmAnalytics()", preparation);
    expect(discovery).toBeGreaterThan(-1);
    expect(preparation).toBeGreaterThan(discovery);
    expect(prewarm).toBeGreaterThan(preparation);
  });

  it("replaces the delayed Backfill job with startup, source-change and manual ingestion triggers", async () => {
    const source = await readFile(path.resolve("src/main/main.ts"), "utf8");
    expect(source).not.toContain("const backfillTimer");
    expect(source).toContain('trigger("startup")');
    expect(source).toContain('trigger("source-change")');
    expect(source).toContain('trigger("manual-recompute")');
    expect(source).toContain("setInterval");
  });

  it("orders ingestion, legacy reconciliation, quota migration, completion and prewarm", async () => {
    const calls: string[] = [];
    const result = await preparePortableData({
      beginMigration: async () => { calls.push("running"); },
      ingestProviderEvents: async () => {
        calls.push("ingest");
        return { scanned: 2, changed: 1, inserted: 3, updated: 0, existing: 0, errors: [], diagnostics: [] };
      },
      readLegacyRecords: async () => {
        calls.push("read-legacy");
        return [];
      },
      reconcileLegacy: async () => {
        calls.push("reconcile");
        return { storeRevision: "a".repeat(64), syntheticInserted: 1, syntheticUpdated: 0 };
      },
      readLegacyQuota: async () => {
        calls.push("read-quota");
        return [];
      },
      migrateQuota: async () => { calls.push("quota"); },
      completeMigration: async () => { calls.push("complete"); },
      failMigration: async () => { calls.push("failed"); },
      prewarmConsumers: () => { calls.push("prewarm"); },
    });

    expect(result).toMatchObject({ status: "complete", ingested: 3, legacyInserted: 1, quotaSnapshots: 0 });
    expect(calls).toEqual([
      "running", "ingest", "read-legacy", "reconcile", "read-quota", "quota", "complete", "prewarm",
    ]);
  });

  it.each([
    "ingestion",
    "legacy_reconciliation",
    "quota_migration",
    "migration_completion",
    "consumer_prewarm",
  ] as const)("writes a sanitized failed state and does not continue after %s fails", async (failedStage) => {
    const calls: string[] = [];
    const fail = (stage: typeof failedStage) => {
      if (stage === failedStage) throw new Error("raw-sensitive-detail C:\\Users\\Example\\private\\data.json");
    };
    const deps = {
      beginMigration: async () => { calls.push("running"); },
      ingestProviderEvents: async () => {
        calls.push("ingestion"); fail("ingestion");
        return { scanned: 0, changed: 0, inserted: 0, updated: 0, existing: 0, errors: [], diagnostics: [] };
      },
      readLegacyRecords: async () => [],
      reconcileLegacy: async () => {
        calls.push("legacy_reconciliation"); fail("legacy_reconciliation");
        return { storeRevision: "b".repeat(64), syntheticInserted: 0, syntheticUpdated: 0 };
      },
      readLegacyQuota: async () => [],
      migrateQuota: async () => { calls.push("quota_migration"); fail("quota_migration"); },
      completeMigration: async () => { calls.push("migration_completion"); fail("migration_completion"); },
      failMigration: vi.fn(async (code: string) => { calls.push(`failed:${code}`); }),
      prewarmConsumers: () => { calls.push("consumer_prewarm"); fail("consumer_prewarm"); },
    };

    await expect(preparePortableData(deps)).rejects.toThrow(`Portable data preparation failed at ${failedStage}`);
    expect(deps.failMigration).toHaveBeenCalledWith(`${failedStage}_failed`);
    expect(JSON.stringify(deps.failMigration.mock.calls)).not.toContain("raw-sensitive-detail");
    expect(JSON.stringify(deps.failMigration.mock.calls)).not.toContain("Example");
    if (failedStage !== "consumer_prewarm") expect(calls).not.toContain("consumer_prewarm");
  });

  it("resumes idempotently by delegating every startup to idempotent stages", async () => {
    let runs = 0;
    let stored = false;
    const deps = {
      beginMigration: async () => undefined,
      ingestProviderEvents: async () => ({
        scanned: 1, changed: stored ? 0 : 1, inserted: stored ? 0 : 1,
        updated: 0, existing: stored ? 1 : 0, errors: [], diagnostics: [],
      }),
      readLegacyRecords: async () => [],
      reconcileLegacy: async () => ({
        storeRevision: "c".repeat(64), syntheticInserted: stored ? 0 : 1, syntheticUpdated: 0,
      }),
      readLegacyQuota: async () => [],
      migrateQuota: async () => { stored = true; },
      completeMigration: async () => { runs += 1; },
      failMigration: async () => undefined,
      prewarmConsumers: () => undefined,
    };

    const first = await preparePortableData(deps);
    const second = await preparePortableData(deps);
    expect(first.ingested).toBe(1);
    expect(second.ingested).toBe(0);
    expect(second.legacyInserted).toBe(0);
    expect(runs).toBe(2);
  });
});

describe("ongoing portable ingestion", () => {
  it("never overlaps and coalesces concurrent triggers into one retry", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let maximum = 0;
    let runs = 0;
    const runner = createPortableIngestionRunner(async () => {
      runs += 1;
      active += 1;
      maximum = Math.max(maximum, active);
      if (runs === 1) await barrier;
      active -= 1;
    });

    const startup = runner.trigger("startup");
    await vi.waitFor(() => expect(runs).toBe(1));
    const timer = runner.trigger("source-change");
    const manual = runner.trigger("manual-recompute");
    release();
    await Promise.all([startup, timer, manual]);

    expect(maximum).toBe(1);
    expect(runs).toBe(2);
  });

  it("recovers after a failed run without leaking the raw error", async () => {
    const diagnostics: string[] = [];
    let runs = 0;
    const runner = createPortableIngestionRunner(async () => {
      runs += 1;
      if (runs === 1) throw new Error("raw-sensitive-detail");
    }, (diagnostic) => diagnostics.push(diagnostic));

    await runner.trigger("source-change");
    await runner.trigger("manual-recompute");

    expect(runs).toBe(2);
    expect(diagnostics).toEqual(["Portable ingestion failed"]);
  });

});

describe("legacy quota compatibility", () => {
  it("reads only known daily debug files, sanitizes snapshots and preserves files byte-exact", async () => {
    const logDir = await mkdtemp(path.join(os.tmpdir(), "quotabar-startup-"));
    const file = path.join(logDir, "2026-07-12.jsonl");
    const original = [
      JSON.stringify({
        kind: "snapshot", provider: "claude", status: "ok", fetchedAt: "2026-07-12T10:00:00.000Z",
        windows: [{ name: "weekly", usedPercent: 25 }], errorMessage: "must not migrate",
      }),
      JSON.stringify({ kind: "snapshot", provider: "claude", status: "ok", fetchedAt: "invalid", windows: [] }),
      JSON.stringify({ kind: "tokens.usage", input: 123 }),
      "not-json",
    ].join("\n") + "\n";
    await writeFile(file, original, "utf8");
    await writeFile(path.join(logDir, "ignore.txt"), JSON.stringify({ kind: "snapshot" }), "utf8");

    const snapshots = await readLegacyQuotaSnapshots(logDir);

    expect(snapshots).toEqual([{
      kind: "snapshot", provider: "claude", status: "ok",
      fetchedAt: "2026-07-12T10:00:00.000Z", windows: [{ name: "weekly", usedPercent: 25 }],
    }]);
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("keeps migration running through quota commit, then completes idempotently", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "quotabar-startup-state-"));
    const usageRoot = path.join(root, "usage");
    const quotaRoot = path.join(root, "quota");
    const statePath = path.join(usageRoot, "migration-state.json");
    const store = new PortableUsageStore(usageRoot);
    const snapshot = {
      kind: "snapshot" as const,
      provider: "claude",
      status: "ok" as const,
      fetchedAt: "2026-07-12T10:00:00.000Z",
      windows: [{ name: "weekly" as const, usedPercent: 25 }],
    };

    await markMigrationRunning(statePath);
    const usage = await migrateLegacyData({ store, records: [], statePath, finalizeState: false });
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ status: "running" });
    await appendQuotaSnapshots(quotaRoot, [snapshot]);
    await appendQuotaSnapshots(quotaRoot, [snapshot]);
    expect(await readQuotaSnapshots(quotaRoot)).toEqual([snapshot]);
    await markMigrationComplete(statePath, usage.storeRevision);

    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      status: "complete",
      storeRevision: usage.storeRevision,
    });
  });

  it("writes only strict allowlisted startup failure states", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "quotabar-startup-failed-"));
    const statePath = path.join(root, "migration-state.json");
    await markMigrationFailed(statePath, "quota_migration_failed");
    const raw = JSON.parse(await readFile(statePath, "utf8"));
    expect(parseMigrationState(raw).state).toEqual(raw);
    expect(raw).toMatchObject({ status: "failed", lastError: "quota_migration_failed" });
    expect(JSON.stringify(raw)).not.toContain(root);
  });

  it("does not overwrite a future migration state when startup begins", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "quotabar-startup-future-"));
    const statePath = path.join(root, "migration-state.json");
    const future = `${JSON.stringify({
      schemaVersion: 2,
      status: "complete",
      usageMigrationVersion: 2,
      storeRevision: "f".repeat(64),
      updatedAt: "2026-07-12T10:00:00.000Z",
    })}\n`;
    await writeFile(statePath, future, "utf8");
    await expect(markMigrationRunning(statePath)).rejects.toThrow("newer than this QuotaBar version");
    expect(await readFile(statePath, "utf8")).toBe(future);
  });
});

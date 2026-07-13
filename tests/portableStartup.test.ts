import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import * as nodeFs from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createPortableIngestionLifecycle,
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
    const lifecycleSource = await readFile(path.resolve("src/main/debugBackfill.ts"), "utf8");
    expect(source).not.toContain("const backfillTimer");
    expect(source).toContain("createPortableIngestionLifecycle");
    expect(source).toContain("portableIngestionLifecycle.start()");
    expect(source).toContain('trigger("manual-recompute")');
    expect(lifecycleSource).toContain('runner.trigger("startup")');
    expect(lifecycleSource).toContain('runner.trigger("source-change")');
    expect(lifecycleSource).toContain("setInterval");
  });

  it("owns the ingestion lifecycle outside startup and stops it before quit flushing", async () => {
    const source = await readFile(path.resolve("src/main/main.ts"), "utf8");
    const moduleLifecycle = source.indexOf("let portableIngestionLifecycle");
    const whenReady = source.indexOf("app.whenReady()");
    const beforeQuit = source.indexOf('app.on("before-quit"');
    const stop = source.indexOf("portableIngestionLifecycle?.stop()", beforeQuit);
    const flush = source.indexOf("recorder.flush()", beforeQuit);
    expect(moduleLifecycle).toBeGreaterThan(-1);
    expect(moduleLifecycle).toBeLessThan(whenReady);
    expect(stop).toBeGreaterThan(beforeQuit);
    expect(stop).toBeLessThan(flush);
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

  it("does not prewarm or claim failure when a future state appears before completion", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "quotabar-prepare-future-complete-"));
    const statePath = path.join(root, "migration-state.json");
    const revisionStore = new PortableUsageStore(root);
    const future = `${JSON.stringify({
      schemaVersion: 2, status: "complete", usageMigrationVersion: 2,
      storeRevision: "f".repeat(64), updatedAt: "2026-07-12T10:00:00.000Z",
    })}\n`;
    const prewarm = vi.fn();

    const result = await preparePortableData({
      beginMigration: () => markMigrationRunning(statePath),
      ingestProviderEvents: async () => ({ inserted: 0, updated: 0 }),
      readLegacyRecords: async () => [],
      reconcileLegacy: async () => ({
        storeRevision: "a".repeat(64), syntheticInserted: 0, syntheticUpdated: 0,
      }),
      readLegacyQuota: async () => [],
      migrateQuota: async () => undefined,
      completeMigration: async (revision) => {
        await writeFile(statePath, future, "utf8");
        return await markMigrationComplete(statePath, revision, revisionStore);
      },
      failMigration: (code) => markMigrationFailed(statePath, code),
      prewarmConsumers: prewarm,
    });
    expect(result).toEqual({ status: "superseded" });
    expect(prewarm).not.toHaveBeenCalled();
    expect(await readFile(statePath, "utf8")).toBe(future);
  });

  it("does not overwrite or falsely report failed when a future state appears before failure handling", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "quotabar-prepare-future-failed-"));
    const statePath = path.join(root, "migration-state.json");
    const revisionStore = new PortableUsageStore(root);
    const future = `${JSON.stringify({
      schemaVersion: 2, status: "complete", usageMigrationVersion: 2,
      storeRevision: "f".repeat(64), updatedAt: "2026-07-12T10:00:00.000Z",
    })}\n`;

    const result = await preparePortableData({
      beginMigration: () => markMigrationRunning(statePath),
      ingestProviderEvents: async () => { throw new Error("raw-sensitive-detail"); },
      readLegacyRecords: async () => [],
      reconcileLegacy: async () => ({
        storeRevision: "a".repeat(64), syntheticInserted: 0, syntheticUpdated: 0,
      }),
      readLegacyQuota: async () => [],
      migrateQuota: async () => undefined,
      completeMigration: (revision) => markMigrationComplete(statePath, revision, revisionStore),
      failMigration: async (code) => {
        await writeFile(statePath, future, "utf8");
        return await markMigrationFailed(statePath, code);
      },
      prewarmConsumers: () => undefined,
    });
    expect(result).toEqual({ status: "superseded" });
    expect(await readFile(statePath, "utf8")).toBe(future);
  });

  it("reports an inner supported migration failure instead of misclassifying it as superseded", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "quotabar-prepare-inner-failed-"));
    const usageRoot = path.join(root, "usage");
    const statePath = path.join(usageRoot, "migration-state.json");
    const store = new PortableUsageStore(usageRoot);
    const prewarm = vi.fn();
    let beforeOuter = "";
    let afterOuter = "";
    let outerResult: Awaited<ReturnType<typeof markMigrationFailed>> | undefined;

    await expect(preparePortableData({
      beginMigration: () => markMigrationRunning(statePath),
      ingestProviderEvents: async () => ({ inserted: 0, updated: 0 }),
      readLegacyRecords: async () => [{ date: "invalid" }] as never,
      reconcileLegacy: (records) => migrateLegacyData({
        store,
        records,
        statePath,
        finalizeState: false,
      }),
      readLegacyQuota: async () => [],
      migrateQuota: async () => undefined,
      completeMigration: (revision) => markMigrationComplete(statePath, revision, store),
      failMigration: async (code) => {
        beforeOuter = await readFile(statePath, "utf8");
        outerResult = await markMigrationFailed(statePath, code);
        afterOuter = await readFile(statePath, "utf8");
        return outerResult;
      },
      prewarmConsumers: prewarm,
    })).rejects.toThrow("Portable data preparation failed: legacy_records_invalid");

    expect(outerResult).toEqual({ status: "already_failed", lastError: "legacy_records_invalid" });
    expect(afterOuter).toBe(beforeOuter);
    expect(JSON.parse(afterOuter)).toMatchObject({ status: "failed", lastError: "legacy_records_invalid" });
    expect(prewarm).not.toHaveBeenCalled();
  });
});

describe("portable ingestion lifecycle", () => {
  it("stops polling idempotently while allowing an in-flight run to finish", async () => {
    let poll: (() => void) | undefined;
    const clearInterval = vi.fn(() => { poll = undefined; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let runs = 0;
    const runner = createPortableIngestionRunner(async () => {
      runs += 1;
      if (runs === 1) await gate;
    });
    const lifecycle = createPortableIngestionLifecycle(runner, {
      setInterval: (callback) => {
        poll = callback;
        return 1 as unknown as NodeJS.Timeout;
      },
      clearInterval,
    });

    const startup = lifecycle.start();
    await vi.waitFor(() => expect(runs).toBe(1));
    const stopping = lifecycle.stop();
    const stoppingAgain = lifecycle.stop();
    poll?.();
    await lifecycle.trigger("manual-recompute");
    let cleanupFinished = false;
    void stopping.then(() => { cleanupFinished = true; });
    await Promise.resolve();
    expect(cleanupFinished).toBe(false);
    release();
    await Promise.all([startup, stopping, stoppingAgain]);

    expect(runs).toBe(1);
    expect(cleanupFinished).toBe(true);
    expect(clearInterval).toHaveBeenCalledTimes(1);
  });

  it("clears and recreates its interval safely when reinitialized", async () => {
    const handles: number[] = [];
    const cleared: number[] = [];
    const runner = createPortableIngestionRunner(async () => undefined);
    const lifecycle = createPortableIngestionLifecycle(runner, {
      setInterval: () => {
        const handle = handles.length + 1;
        handles.push(handle);
        return handle as unknown as NodeJS.Timeout;
      },
      clearInterval: (handle) => cleared.push(handle as unknown as number),
    });

    await lifecycle.start();
    await lifecycle.start();
    await lifecycle.stop();

    expect(handles).toEqual([1, 2]);
    expect(cleared).toEqual([1, 2]);
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

  it("runs a trigger arriving at the exact drain-cleanup boundary without overlap", async () => {
    let enterBoundary!: () => void;
    const boundaryEntered = new Promise<void>((resolve) => { enterBoundary = resolve; });
    let leaveBoundary!: () => void;
    const boundaryGate = new Promise<void>((resolve) => { leaveBoundary = resolve; });
    let active = 0;
    let maximum = 0;
    let runs = 0;
    const runner = createPortableIngestionRunner(async () => {
      runs += 1;
      active += 1;
      maximum = Math.max(maximum, active);
      active -= 1;
    }, undefined, {
      beforeActiveCleanup: async () => {
        enterBoundary();
        await boundaryGate;
      },
    });

    const first = runner.trigger("startup");
    await boundaryEntered;
    const boundary = runner.trigger("source-change");
    leaveBoundary();
    await Promise.all([first, boundary]);

    expect(runs).toBe(2);
    expect(maximum).toBe(1);
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

  it("treats a legacy quota file read error as fatal while preserving every source", async () => {
    const logDir = await mkdtemp(path.join(os.tmpdir(), "quotabar-startup-quota-io-"));
    const readable = path.join(logDir, "2026-07-11.jsonl");
    const denied = path.join(logDir, "2026-07-12.jsonl");
    const contents = `${JSON.stringify({
      kind: "snapshot", provider: "claude", status: "ok",
      fetchedAt: "2026-07-11T10:00:00.000Z", windows: [],
    })}\n`;
    await writeFile(readable, contents, "utf8");
    await writeFile(denied, contents, "utf8");
    const fileSystem = {
      readdir: nodeFs.readdir.bind(nodeFs),
      readFile: async (filePath: string, encoding: BufferEncoding) => {
        if (path.resolve(filePath) === path.resolve(denied)) {
          throw Object.assign(new Error("raw denied path"), { code: "EACCES" });
        }
        return await nodeFs.readFile(filePath, encoding);
      },
    };

    await expect(readLegacyQuotaSnapshots(logDir, { fileSystem })).rejects.toThrow("Legacy quota file read failed");
    expect(await readFile(readable, "utf8")).toBe(contents);
    expect(await readFile(denied, "utf8")).toBe(contents);
  });

  it("records quota_migration_failed and skips prewarm after legacy quota I/O failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "quotabar-startup-quota-state-"));
    const usageRoot = path.join(root, "usage");
    const statePath = path.join(usageRoot, "migration-state.json");
    const store = new PortableUsageStore(usageRoot);
    const prewarm = vi.fn();

    await expect(preparePortableData({
      beginMigration: () => markMigrationRunning(statePath),
      ingestProviderEvents: async () => ({ inserted: 0, updated: 0 }),
      readLegacyRecords: async () => [],
      reconcileLegacy: async () => ({
        storeRevision: await store.getRevision(), syntheticInserted: 0, syntheticUpdated: 0,
      }),
      readLegacyQuota: async () => { throw new Error("Legacy quota file read failed"); },
      migrateQuota: async () => undefined,
      completeMigration: (revision) => markMigrationComplete(statePath, revision, store),
      failMigration: (code) => markMigrationFailed(statePath, code),
      prewarmConsumers: prewarm,
    })).rejects.toThrow("Portable data preparation failed at quota_migration");

    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      status: "failed", lastError: "quota_migration_failed",
    });
    expect(prewarm).not.toHaveBeenCalled();

    await expect(preparePortableData({
      beginMigration: () => markMigrationRunning(statePath),
      ingestProviderEvents: async () => ({ inserted: 0, updated: 0 }),
      readLegacyRecords: async () => [],
      reconcileLegacy: async () => ({
        storeRevision: await store.getRevision(), syntheticInserted: 0, syntheticUpdated: 0,
      }),
      readLegacyQuota: async () => [],
      migrateQuota: async () => undefined,
      completeMigration: (revision) => markMigrationComplete(statePath, revision, store),
      failMigration: (code) => markMigrationFailed(statePath, code),
      prewarmConsumers: prewarm,
    })).resolves.toMatchObject({ status: "complete", quotaSnapshots: 0 });
    expect(prewarm).toHaveBeenCalledOnce();
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
    await markMigrationComplete(statePath, usage.storeRevision, store);

    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      status: "complete",
      storeRevision: usage.storeRevision,
    });
  });

  it("does not publish a reconciled revision after another writer mutates the usage store", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "quotabar-startup-stale-revision-"));
    const usageRoot = path.join(root, "usage");
    const statePath = path.join(usageRoot, "migration-state.json");
    const store = new PortableUsageStore(usageRoot);
    await markMigrationRunning(statePath);
    const migration = await migrateLegacyData({ store, records: [], statePath, finalizeState: false });
    await store.upsert([{
      schemaVersion: 1,
      id: "newer-provider-event",
      provider: "claude",
      occurredAt: "2026-07-12T12:00:00.000Z",
      model: "claude-sonnet-4",
      sessionKey: "newer-session",
      source: "claude-log",
      synthetic: false,
      inputTokens: 1,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      reasoningOutputTokens: 0,
    }]);

    await expect(markMigrationComplete(statePath, migration.storeRevision, store)).resolves.toMatchObject({
      status: "stale_revision",
    });
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ status: "running" });
  });

  it("prevents a real second process from making another process publish a stale revision", async () => {
    const usageRoot = await mkdtemp(path.join(os.tmpdir(), "quotabar-finalize-process-"));
    await Promise.all([
      runFinalizeChild(usageRoot, "a"),
      runFinalizeChild(usageRoot, "b"),
    ]);
    const stale = JSON.parse(await readFile(path.join(usageRoot, "a-result.json"), "utf8"));
    expect(stale.status).toBe("stale_revision");
    expect(JSON.parse(await readFile(path.join(usageRoot, "migration-state.json"), "utf8"))).toMatchObject({
      status: "running",
    });

    const store = new PortableUsageStore(usageRoot);
    const retried = await migrateLegacyData({ store, records: [], statePath: path.join(usageRoot, "migration-state.json"), finalizeState: false });
    await expect(markMigrationComplete(path.join(usageRoot, "migration-state.json"), retried.storeRevision, store))
      .resolves.toMatchObject({ status: "applied" });
    const finalState = JSON.parse(await readFile(path.join(usageRoot, "migration-state.json"), "utf8"));
    expect(finalState.storeRevision).toBe(await store.getRevision());
  });

  it("writes only strict allowlisted startup failure states", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "quotabar-startup-failed-"));
    const statePath = path.join(root, "migration-state.json");
    await markMigrationRunning(statePath);
    expect(await markMigrationFailed(statePath, "quota_migration_failed")).toEqual({ status: "applied" });
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
    await expect(markMigrationRunning(statePath)).resolves.toEqual({ status: "future_state" });
    expect(await readFile(statePath, "utf8")).toBe(future);
  });

  it.each(["complete", "failed"] as const)("does not overwrite a future state immediately before %s", async (transition) => {
    const root = await mkdtemp(path.join(os.tmpdir(), `quotabar-startup-future-${transition}-`));
    const statePath = path.join(root, "migration-state.json");
    const store = new PortableUsageStore(root);
    const future = `${JSON.stringify({
      schemaVersion: 2,
      status: "complete",
      usageMigrationVersion: 2,
      storeRevision: "e".repeat(64),
      updatedAt: "2026-07-12T10:00:00.000Z",
    })}\n`;
    await writeFile(statePath, future, "utf8");

    const result = transition === "complete"
      ? await markMigrationComplete(statePath, "d".repeat(64), store)
      : await markMigrationFailed(statePath, "quota_migration_failed");

    expect(result).toEqual({ status: "future_state" });
    expect(await readFile(statePath, "utf8")).toBe(future);
  });

  it("serializes competing finalizers and never overwrites the first committed terminal state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "quotabar-startup-finalize-race-"));
    const statePath = path.join(root, "migration-state.json");
    const store = new PortableUsageStore(root);
    await markMigrationRunning(statePath);
    const revision = await store.getRevision();

    const results = await Promise.all([
      markMigrationComplete(statePath, revision, store),
      markMigrationFailed(statePath, "quota_migration_failed"),
    ]);
    const parsed = parseMigrationState(JSON.parse(await readFile(statePath, "utf8"))).state;

    expect(results.filter(({ status }) => status === "applied")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "not_running")).toHaveLength(1);
    expect(["complete", "failed"]).toContain(parsed?.status);
  });
});

function runFinalizeChild(root: string, role: "a" | "b"): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.resolve("node_modules/vitest/vitest.mjs"),
      "run",
      "tests/fixtures/portableFinalizeChild.test.ts",
    ], {
      cwd: process.cwd(),
      env: { ...process.env, QUOTABAR_FINALIZE_ROOT: root, QUOTABAR_FINALIZE_ROLE: role },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Portable finalization child exited with code ${code}: ${output}`));
    });
  });
}

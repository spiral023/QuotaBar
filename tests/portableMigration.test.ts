import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  migrateLegacyData,
  PORTABLE_USAGE_MIGRATION_VERSION,
} from "../src/portable/migration";
import { eventId, sessionKey } from "../src/portable/eventIdentity";
import type { PortableUsageEvent } from "../src/portable/types";
import { PortableUsageStore } from "../src/portable/usageStore";
import type { BackfillDayRecord, BackfillPerModelEntry } from "../src/reports/types";

const ZERO_MODEL: BackfillPerModelEntry = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
  costUSD: 0,
};

function record(
  date: string,
  provider: "claude" | "codex",
  model: string,
  values: Partial<BackfillPerModelEntry> = {},
): BackfillDayRecord {
  const perModel = { ...ZERO_MODEL, ...values };
  return {
    date,
    provider,
    inputTokens: perModel.inputTokens,
    outputTokens: perModel.outputTokens,
    cacheCreationTokens: perModel.cacheCreationTokens,
    cacheReadTokens: perModel.cacheReadTokens,
    totalTokens: perModel.totalTokens,
    costUSD: perModel.costUSD,
    sessionCount: 1,
    models: [model],
    perModel: { [model]: perModel },
  };
}

function providerEvent(
  id: string,
  occurredAt: string,
  provider: "claude" | "codex",
  model: string,
  values: Partial<PortableUsageEvent> = {},
): PortableUsageEvent {
  return {
    schemaVersion: 1,
    id,
    provider,
    occurredAt,
    model,
    projectName: "Existing project",
    sessionKey: `session-${id}`,
    source: provider === "claude" ? "claude-log" : "codex-log",
    synthetic: false,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    reasoningOutputTokens: 0,
    ...values,
  };
}

describe("migrateLegacyData", () => {
  let rootDir: string;
  let statePath: string;
  let store: PortableUsageStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "quotabar-portable-migration-"));
    statePath = path.join(rootDir, "migration-state.json");
    store = new PortableUsageStore(rootDir);
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("creates one deterministic synthetic reconciliation event for a backfill-only model/day", async () => {
    const legacy = record("2026-05-20", "claude", "claude-sonnet-4-6", {
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationTokens: 30,
      cacheReadTokens: 400,
      totalTokens: 550,
      costUSD: 1.1,
      inputCostUSD: 0.1,
      outputCostUSD: 0.2,
      cacheCreationCostUSD: 0.3,
      cacheReadCostUSD: 0.5,
    });

    expect(await migrateLegacyData({ store, records: [legacy], statePath })).toEqual({
      status: "complete",
      syntheticInserted: 1,
      syntheticUpdated: 0,
    });
    const [event] = await store.read();
    expect(event).toMatchObject({
      provider: "claude",
      occurredAt: "2026-05-20T12:00:00.000Z",
      model: "claude-sonnet-4-6",
      projectName: "Imported legacy data",
      source: "legacy-reconciliation",
      synthetic: true,
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationTokens: 30,
      cacheReadTokens: 400,
      reasoningOutputTokens: 0,
      costUSD: 1.1,
      inputCostUSD: 0.1,
      outputCostUSD: 0.2,
      cacheCreationCostUSD: 0.3,
      cacheReadCostUSD: 0.5,
    });
    expect(event.id).toMatch(/^[0-9a-f]{64}$/);
    expect(event.sessionKey).toMatch(/^[0-9a-f]{64}$/);
    expect(event.id).not.toBe(event.sessionKey);
    const permanentIdentity = JSON.stringify([
      "quotabar-legacy-reconciliation-event-v1",
      "2026-05-20",
      "claude",
      "claude-sonnet-4-6",
    ]);
    expect(event.id).toBe(eventId({
      provider: "claude",
      occurredAt: "2026-05-20T12:00:00.000Z",
      model: "claude-sonnet-4-6",
      session: permanentIdentity,
      ordinal: 0,
    }));
    expect(event.sessionKey).toBe(sessionKey("claude", permanentIdentity));
  });

  it("aggregates provider events by their parsed UTC instant rather than timestamp text", async () => {
    await store.upsert([providerEvent(
      "offset-current",
      "2026-05-20T23:30:00-02:00",
      "claude",
      "model",
      { inputTokens: 10 },
    )]);
    const may20 = record("2026-05-20", "claude", "model", { inputTokens: 10, totalTokens: 10 });
    const may21 = record("2026-05-21", "claude", "model", { inputTokens: 10, totalTokens: 10 });

    await migrateLegacyData({ store, records: [may20, may21], statePath });

    const synthetic = (await store.read()).filter(({ source }) => source === "legacy-reconciliation");
    expect(synthetic).toHaveLength(1);
    expect(synthetic[0]).toMatchObject({
      occurredAt: "2026-05-20T12:00:00.000Z",
      inputTokens: 10,
    });
  });

  it("rejects an invalid stored timestamp with a fixed safe error", async () => {
    const unsafeTimestamp = "private-invalid-timestamp-value";
    const invalid = providerEvent("invalid", unsafeTimestamp, "claude", "model");
    store.read = async () => [invalid];

    let message = "";
    try {
      await migrateLegacyData({
        store,
        records: [record("2026-05-20", "claude", "model")],
        statePath,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("Portable usage store events are invalid");
    expect(message).not.toContain(unsafeTimestamp);
    const failed = await readFile(statePath, "utf8");
    expect(JSON.parse(failed)).toMatchObject({ status: "failed", lastError: "store_events_invalid" });
    expect(failed).not.toContain(unsafeTimestamp);
  });

  it("creates no synthetic event when provider totals already equal backfill", async () => {
    await store.upsert([providerEvent("current", "2026-05-20T10:00:00.000Z", "claude", "model", {
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationTokens: 30,
      cacheReadTokens: 40,
      costUSD: 1,
      inputCostUSD: 0.1,
      outputCostUSD: 0.2,
      cacheCreationCostUSD: 0.3,
      cacheReadCostUSD: 0.4,
    })]);
    const legacy = record("2026-05-20", "claude", "model", {
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationTokens: 30,
      cacheReadTokens: 40,
      totalTokens: 100,
      costUSD: 1,
      inputCostUSD: 0.1,
      outputCostUSD: 0.2,
      cacheCreationCostUSD: 0.3,
      cacheReadCostUSD: 0.4,
    });

    expect(await migrateLegacyData({ store, records: [legacy], statePath })).toMatchObject({
      syntheticInserted: 0,
      syntheticUpdated: 0,
    });
    expect((await store.read()).map(({ source }) => source)).toEqual(["claude-log"]);
  });

  it("reconciles every token and cost component independently without negative deltas", async () => {
    await store.upsert([providerEvent("current", "2026-06-01T08:00:00.000Z", "codex", "gpt-5.5", {
      inputTokens: 90,
      outputTokens: 60,
      cacheCreationTokens: 7,
      cacheReadTokens: 10,
      reasoningOutputTokens: 9,
      costUSD: 0.75,
      inputCostUSD: 0.4,
      outputCostUSD: 0.05,
      cacheCreationCostUSD: 0.2,
      cacheReadCostUSD: 0.1,
    })]);
    const legacy = record("2026-06-01", "codex", "gpt-5.5", {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 5,
      cacheReadTokens: 30,
      totalTokens: 180,
      costUSD: 1,
      inputCostUSD: 0.3,
      outputCostUSD: 0.2,
      cacheCreationCostUSD: 0.1,
      cacheReadCostUSD: 0.4,
    });

    await migrateLegacyData({ store, records: [legacy], statePath });
    const synthetic = (await store.read()).find(({ synthetic }) => synthetic);
    expect(synthetic).toMatchObject({
      inputTokens: 10,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 20,
      reasoningOutputTokens: 0,
      costUSD: 0.25,
      inputCostUSD: 0,
      outputCostUSD: 0.15,
      cacheCreationCostUSD: 0,
      cacheReadCostUSD: 0.3,
    });
    expect(Object.values(synthetic ?? {}).filter((value): value is number => typeof value === "number")
      .every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
  });

  it("updates the same synthetic ID on an increased legacy aggregate and does not count itself as baseline", async () => {
    const first = record("2026-05-20", "claude", "model", { inputTokens: 10, totalTokens: 10 });
    await migrateLegacyData({ store, records: [first], statePath });
    const [before] = await store.read();
    await writeFile(statePath, `${JSON.stringify({
      schemaVersion: 1,
      status: "complete",
      usageMigrationVersion: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
    })}\n`, "utf8");

    const second = record("2026-05-20", "claude", "model", { inputTokens: 15, totalTokens: 15 });
    expect(await migrateLegacyData({ store, records: [second], statePath })).toMatchObject({
      syntheticInserted: 0,
      syntheticUpdated: 1,
    });
    const [after] = await store.read();
    expect(after.id).toBe(before.id);
    expect(after.inputTokens).toBe(15);
  });

  it("reconciles multiple providers, days, and normalized Codex/Claude models independently", async () => {
    const records = [
      record("2026-05-20", "claude", "claude-model", {
        inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4, totalTokens: 10,
      }),
      record("2026-05-20", "codex", "codex-model", {
        inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, totalTokens: 18,
      }),
      record("2026-05-21", "claude", "other-model", { outputTokens: 8, totalTokens: 8 }),
    ];

    await migrateLegacyData({ store, records, statePath });
    expect((await store.read()).map((event) => [
      event.occurredAt,
      event.provider,
      event.model,
      event.inputTokens,
      event.outputTokens,
      event.cacheCreationTokens,
      event.cacheReadTokens,
      event.reasoningOutputTokens,
    ])).toEqual([
      ["2026-05-20T12:00:00.000Z", "claude", "claude-model", 1, 2, 3, 4, 0],
      ["2026-05-20T12:00:00.000Z", "codex", "codex-model", 5, 6, 0, 7, 0],
      ["2026-05-21T12:00:00.000Z", "claude", "other-model", 0, 8, 0, 0, 0],
    ]);
  });

  it("handles component-only and total-only costs without NaN or double-count fallback", async () => {
    const componentOnly = record("2026-05-20", "claude", "components", {
      totalTokens: 1,
      inputTokens: 1,
      costUSD: 0,
      inputCostUSD: 0.25,
      outputCostUSD: 0.75,
    });
    const totalOnly = record("2026-05-20", "claude", "total", {
      totalTokens: 1,
      outputTokens: 1,
      costUSD: 2,
    });

    const combined: BackfillDayRecord = {
      ...componentOnly,
      inputTokens: componentOnly.inputTokens + totalOnly.inputTokens,
      outputTokens: componentOnly.outputTokens + totalOnly.outputTokens,
      totalTokens: componentOnly.totalTokens + totalOnly.totalTokens,
      costUSD: componentOnly.costUSD + totalOnly.costUSD,
      models: ["components", "total"],
      perModel: { ...componentOnly.perModel, ...totalOnly.perModel },
    };
    await migrateLegacyData({ store, records: [combined], statePath });
    const byModel = new Map((await store.read()).map((event) => [event.model, event]));
    expect(byModel.get("components")).toMatchObject({
      costUSD: 1,
      inputCostUSD: 0.25,
      outputCostUSD: 0.75,
    });
    expect(byModel.get("total")).toMatchObject({ costUSD: 2 });
    expect(byModel.get("total")).not.toHaveProperty("inputCostUSD");
  });

  it("uses explicit total costs as authoritative despite inconsistent component sums", async () => {
    await store.upsert([
      providerEvent("current-low-components", "2026-05-20T08:00:00.000Z", "claude", "low-components", {
        costUSD: 0.4,
        inputCostUSD: 4,
        outputCostUSD: 6,
      }),
      providerEvent("current-high-components", "2026-05-20T09:00:00.000Z", "claude", "high-components", {
        costUSD: 0.8,
        inputCostUSD: 0.04,
        outputCostUSD: 0.06,
      }),
    ]);
    const lowComponents = record("2026-05-20", "claude", "low-components", {
      costUSD: 1,
      inputCostUSD: 0.1,
      outputCostUSD: 0.1,
    });
    const highComponents = record("2026-05-20", "claude", "high-components", {
      costUSD: 1,
      inputCostUSD: 4,
      outputCostUSD: 6,
    });
    const combined: BackfillDayRecord = {
      ...lowComponents,
      costUSD: 2,
      models: ["low-components", "high-components"],
      perModel: { ...lowComponents.perModel, ...highComponents.perModel },
    };

    await migrateLegacyData({ store, records: [combined], statePath });

    const synthetic = new Map(
      (await store.read())
        .filter(({ source }) => source === "legacy-reconciliation")
        .map((event) => [event.model, event]),
    );
    expect(synthetic.get("low-components")).toMatchObject({
      costUSD: 0.6,
      inputCostUSD: 0,
      outputCostUSD: 0,
    });
    expect(synthetic.get("high-components")).toMatchObject({
      costUSD: 0.2,
      inputCostUSD: 3.96,
      outputCostUSD: 5.94,
    });
  });

  it("rejects duplicate or malformed records deterministically without serializing their contents", async () => {
    const duplicate = record("2026-05-20", "claude", "model");
    await expect(migrateLegacyData({ store, records: [duplicate, duplicate], statePath }))
      .rejects.toThrow(/^Legacy backfill records are invalid$/);
    const failed = JSON.parse(await readFile(statePath, "utf8"));
    expect(failed).toMatchObject({ status: "failed", lastError: "legacy_records_invalid" });
    expect(JSON.stringify(failed)).not.toContain("model");

    await writeFile(statePath, "", "utf8");
    const malformed = { ...duplicate, date: "../../secret-value" } as BackfillDayRecord;
    await expect(migrateLegacyData({ store, records: [malformed], statePath }))
      .rejects.toThrow(/^Legacy backfill records are invalid$/);
  });

  it("persists running and complete schema-v1 states and resumes both interruption points idempotently", async () => {
    const legacy = record("2026-05-20", "claude", "model", { inputTokens: 10, totalTokens: 10 });
    await expect(migrateLegacyData({ store, records: [legacy], statePath, failAfterState: "running" }))
      .rejects.toThrow("Portable usage migration interrupted");
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      status: "running",
      usageMigrationVersion: PORTABLE_USAGE_MIGRATION_VERSION,
    });

    await expect(migrateLegacyData({ store, records: [legacy], statePath, failAfterState: "events" }))
      .rejects.toThrow("Portable usage migration interrupted");
    expect((await store.read()).filter(({ synthetic }) => synthetic)).toHaveLength(1);
    expect(JSON.parse(await readFile(statePath, "utf8")).status).toBe("running");

    expect(await migrateLegacyData({ store, records: [legacy], statePath })).toMatchObject({
      status: "complete",
      syntheticInserted: 0,
      syntheticUpdated: 0,
    });
    expect((await store.read()).filter(({ synthetic }) => synthetic)).toHaveLength(1);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      status: "complete",
      usageMigrationVersion: PORTABLE_USAGE_MIGRATION_VERSION,
    });
  });

  it("skips current complete state, reruns older versions, and safely resets corrupt state", async () => {
    const legacy = record("2026-05-20", "claude", "model", { inputTokens: 10, totalTokens: 10 });
    const now = () => new Date("2026-07-13T10:00:00.000Z");
    await writeFile(statePath, `${JSON.stringify({
      schemaVersion: 1,
      status: "complete",
      usageMigrationVersion: PORTABLE_USAGE_MIGRATION_VERSION,
      updatedAt: "2026-01-01T00:00:00.000Z",
      authorization: "private-sensitive-state-value",
    })}\n`, "utf8");
    expect(await migrateLegacyData({ store, records: [legacy], statePath, now })).toEqual({
      status: "complete", syntheticInserted: 0, syntheticUpdated: 0,
    });
    expect(await store.read()).toEqual([]);
    const sanitizedComplete = await readFile(statePath, "utf8");
    expect(JSON.parse(sanitizedComplete)).toEqual({
      schemaVersion: 1,
      status: "complete",
      usageMigrationVersion: PORTABLE_USAGE_MIGRATION_VERSION,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(sanitizedComplete).not.toContain("private-sensitive-state-value");

    await writeFile(statePath, "private malformed state contents", "utf8");
    expect(await migrateLegacyData({ store, records: [legacy], statePath, now })).toMatchObject({ syntheticInserted: 1 });
    expect(await readdir(rootDir)).not.toContain("private malformed state contents");
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      status: "complete",
      updatedAt: "2026-07-13T10:00:00.000Z",
    });
  });

  it("safely resets migration states with invalid field types", async () => {
    const unsafeValue = "private-invalid-version-value";
    await writeFile(statePath, `${JSON.stringify({
      schemaVersion: 1,
      status: "complete",
      usageMigrationVersion: unsafeValue,
      updatedAt: "2026-01-01T00:00:00.000Z",
    })}\n`, "utf8");

    expect(await migrateLegacyData({
      store,
      records: [record("2026-05-20", "claude", "model", { inputTokens: 1, totalTokens: 1 })],
      statePath,
    })).toMatchObject({ syntheticInserted: 1 });
    const rewritten = await readFile(statePath, "utf8");
    expect(JSON.parse(rewritten)).toMatchObject({
      schemaVersion: 1,
      status: "complete",
      usageMigrationVersion: PORTABLE_USAGE_MIGRATION_VERSION,
    });
    expect(rewritten).not.toContain(unsafeValue);
  });

  it("rejects a migration state path outside or elsewhere inside the store root", async () => {
    const legacy = record("2026-05-20", "claude", "model");
    await expect(migrateLegacyData({
      store,
      records: [legacy],
      statePath: path.join(rootDir, "nested", "migration-state.json"),
    })).rejects.toThrow("Portable migration state path must match the store root");
    await expect(migrateLegacyData({
      store,
      records: [legacy],
      statePath: path.join(path.dirname(rootDir), "migration-state.json"),
    })).rejects.toThrow("Portable migration state path must match the store root");
    await expect(readdir(rootDir)).resolves.toEqual([]);
  });

  it("does not modify legacy backfill files when a state write fails", async () => {
    const legacyDir = path.join(rootDir, "debug");
    const legacyPath = path.join(legacyDir, "2026-05-20.backfill.jsonl");
    const contents = "legacy-data-must-remain-byte-identical\n";
    await mkdir(legacyDir);
    await writeFile(legacyPath, contents, "utf8");
    await mkdir(statePath);

    await expect(migrateLegacyData({
      store,
      records: [record("2026-05-20", "claude", "model")],
      statePath,
    })).rejects.toThrow("Portable migration state write failed");
    expect(await readFile(legacyPath, "utf8")).toBe(contents);
  });
});

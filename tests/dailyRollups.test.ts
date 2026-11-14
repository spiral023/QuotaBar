import * as fs from "node:fs/promises";
import type { PathLike } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PortableUsageStore } from "../src/portable/usageStore";
import { aggregateDaily } from "../src/portable/dailyRollups";
import { fromClaudeEntries, fromCodexEvents } from "../src/portable/eventAdapters";
import { generateUsageReport } from "../src/reports/reportService";
import { buildModelsData } from "../src/main/modelsData";
import type { PortableUsageEvent } from "../src/portable/types";

function event(id: string, occurredAt: string, overrides: Partial<PortableUsageEvent> = {}): PortableUsageEvent {
  return { ...fromClaudeEntries([{ provider: "claude", timestamp: occurredAt, model: "claude-haiku-4-5",
    project: "fixture", session: id, inputTokens: 100, outputTokens: 20, cacheCreationTokens: 3, cacheReadTokens: 40,
    costUSD: 2, inputCostUSD: .5, cacheReadCostUSD: .25 }])[0], id, ...overrides };
}

describe("persisted daily rollups", () => {
  let root: string;
  let store: PortableUsageStore;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "quotabar-rollups-"));
    store = new PortableUsageStore(root);
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it("reuses persisted rows in a fresh store without reading any JSONL or changing the revision", async () => {
    await store.upsert([event("one", "2026-01-01T01:00:00.000Z"), event("two", "2026-01-01T02:00:00.000Z")]);
    const revision = await store.getRevision();
    const cold = await store.readDaily("UTC");
    expect(cold).toHaveLength(1);
    const readFile = vi.fn(fs.readFile);
    const fresh = new PortableUsageStore(root, { ...fs, readFile: readFile as typeof fs.readFile });
    expect(await fresh.readDaily("UTC")).toEqual(cold);
    expect(readFile.mock.calls.filter(([file]) => String(file).endsWith(".jsonl"))).toHaveLength(0);
    expect(await store.getRevision()).toBe(revision);
  });

  it("invalidates after append even if source stat signatures collide", async () => {
    await store.upsert([event("one", "2026-01-01T01:00:00.000Z")]);
    const original = await fs.lstat(path.join(root, "events", "2026-01.jsonl"), { bigint: true });
    const lstat = vi.fn(fs.lstat);
    lstat.mockImplementation(((file: PathLike, options: unknown) => String(file).endsWith(".jsonl")
      ? Promise.resolve(original) : fs.lstat(file, options as { bigint: true })) as typeof fs.lstat);
    const writeFile = vi.fn(fs.writeFile);
    const colliding = new PortableUsageStore(root, { ...fs, lstat: lstat as typeof fs.lstat, writeFile: writeFile as typeof fs.writeFile });
    // Establish append eligibility with a real rewrite, retaining the frozen stat.
    await colliding.reconcile([event("one", "2026-01-01T01:00:00.000Z", { costUSD: 3 })]);
    await colliding.readDaily("UTC");
    writeFile.mockClear();
    await colliding.reconcile([event("two", "2026-01-02T01:00:00.000Z")]);
    expect(writeFile.mock.calls.some(([file, , options]) => String(file).endsWith("2026-01.jsonl")
      && typeof options === "object" && options?.flag === "a")).toBe(true);
    expect((await colliding.readDaily("UTC")).reduce((sum, row) => sum + row.count, 0)).toBe(2);
  });

  it("invalidates replacement/removal through reconciliation", async () => {
    const legacy = event("derived", "2026-01-01T01:00:00.000Z", { source: "legacy-reconciliation", synthetic: true });
    await store.upsert([legacy]);
    await store.readDaily("UTC");
    await store.reconcileLegacyDerived(() => ({ events: [{ ...legacy, costUSD: 9 }], removeIds: [] }));
    expect((await store.readDaily("UTC"))[0].reportEvent.costUSD).toBe(9);
    await store.reconcileLegacyDerived(() => ({ events: [], removeIds: [legacy.id] }));
    expect(await store.readDaily("UTC")).toEqual([]);
  });

  it("preserves the persisted cache across ingestion checkpoints without event changes", async () => {
    await store.upsert([event("one", "2026-01-01T01:00:00.000Z")]);
    await store.readDaily("UTC");
    const marker = path.join(root, "daily-rollups-revision");
    const before = await fs.readFile(marker, "utf8");
    await store.reconcileWithIngestState([], { schemaVersion: 1, sources: {} });
    expect(await fs.readFile(marker, "utf8")).toBe(before);
  });

  it("recovers an interrupted source transaction before serving any persisted totals", async () => {
    await store.upsert([event("one", "2026-01-01T01:00:00.000Z")]);
    await store.readDaily("UTC");
    let fail = true;
    const interrupted = new PortableUsageStore(root, { ...fs, rename: async (from, to) => {
      if (fail && String(to).endsWith("2026-02.jsonl")) {
        fail = false;
        throw Object.assign(new Error("fixture interruption"), { code: "EIO" });
      }
      return fs.rename(from, to);
    } });
    await expect(interrupted.upsert([event("two", "2026-02-01T01:00:00.000Z")])).rejects.toThrow("fixture interruption");
    expect((await new PortableUsageStore(root).readDaily("UTC")).reduce((sum, row) => sum + row.count, 0)).toBe(2);
  });

  it("detects externally replaced partitions, including a fresh store after import", async () => {
    await store.upsert([event("one", "2026-01-01T01:00:00.000Z")]);
    await store.readDaily("UTC");
    const target = path.join(root, "events", "2026-01.jsonl");
    await fs.writeFile(`${target}.import`, JSON.stringify(event("replacement", "2026-01-01T01:00:00.000Z", { costUSD: 8 })) + "\n");
    await fs.rename(`${target}.import`, target);
    expect((await new PortableUsageStore(root).readDaily("UTC"))[0].reportEvent.costUSD).toBe(8);
  });

  it.each(["broken JSON", "wrong checksum", "invalid row"])("rebuilds %s cache from canonical usage", async (damage) => {
    await store.upsert([event("one", "2026-01-01T01:00:00.000Z")]);
    const expected = await store.readDaily("UTC");
    const cache = path.join(root, "daily-rollups", (await fs.readdir(path.join(root, "daily-rollups")))[0]);
    const content = JSON.parse(await fs.readFile(cache, "utf8")) as Record<string, unknown>;
    if (damage === "wrong checksum") content.checksum = "0";
    if (damage === "invalid row") {
      const { createHash } = await import("node:crypto");
      content.payload = JSON.stringify([{ day: "2026-01-01", count: 1, firstActivity: "2026-01-01", pricing: {}, reportEvent: {} }]);
      content.checksum = createHash("sha256").update(content.payload as string).digest("hex");
    }
    await fs.writeFile(cache, damage === "broken JSON" ? "{" : JSON.stringify(content));
    expect(await new PortableUsageStore(root).readDaily("UTC")).toEqual(expected);
  });

  it("falls back when the cache directory is unavailable", async () => {
    await store.upsert([event("one", "2026-01-01T01:00:00.000Z")]);
    await fs.writeFile(path.join(root, "daily-rollups"), "fixture obstruction");
    expect(await store.readDaily("UTC")).toHaveLength(1);
  });

  it("keeps DST days and UTC-month boundary contributions separate by timezone", async () => {
    await store.upsert([event("a", "2026-03-31T23:30:00.000Z"), event("b", "2026-04-01T00:30:00.000Z"),
      event("dst-a", "2026-10-25T00:30:00.000Z"), event("dst-b", "2026-10-25T01:30:00.000Z")]);
    const vienna = await store.readDaily("Europe/Vienna");
    expect(vienna.map((row) => [row.day, row.count])).toEqual([["2026-04-01", 2], ["2026-10-25", 2]]);
    expect(await store.readDaily("UTC")).toHaveLength(3);
    expect(await store.readDaily("Europe/Vienna")).toEqual(vienna);
  });

  it("reads canonical events for partially included boundary groups", async () => {
    const events = [event("a", "2026-01-01T01:00:00.000Z"), event("b", "2026-01-01T02:00:00.000Z"), event("c", "2026-01-01T03:00:00.000Z")];
    await store.upsert(events);
    await store.readDaily("UTC");
    const range = { since: "2026-01-01T01:30:00.000Z", until: "2026-01-01T02:30:00.000Z" };
    expect(await store.readDaily("UTC", range)).toEqual(aggregateDaily([events[1]], "UTC"));
  });

  it("keeps exact range semantics for imported offset timestamps", async () => {
    const events = [event("offset", "2026-01-01T10:00:00.000+10:00"), event("utc", "2026-01-01T02:00:00.000Z")];
    await store.upsert(events);
    await store.readDaily("UTC");
    const range = { since: "2026-01-01T00:30:00.000Z", until: "2026-01-01T03:00:00.000Z" };
    expect(await new PortableUsageStore(root).readDaily("UTC", range)).toEqual(aggregateDaily([events[1]], "UTC"));
  });

  it.each(["daily", "weekly", "monthly"] as const)("matches raw %s reports with authoritative and missing component costs", async (type) => {
    const events = [event("a", "2026-03-31T23:30:00.000Z"), event("b", "2026-04-01T03:00:00.000Z", { costUSD: .1 }),
      event("c", "2026-04-02T03:00:00.000Z", { model: "claude-opus-4-8", costUSD: undefined, inputCostUSD: undefined }),
      ...fromCodexEvents([{ timestamp: "2026-04-01T05:00:00.000Z", model: "gpt-5", isFallback: true,
        session: "codex", directory: ".", inputTokens: 100, cachedInputTokens: 20, outputTokens: 5,
        reasoningOutputTokens: 0, totalTokens: 105, costUSD: 3 }])];
    await store.upsert(events);
    const request = { type, timezone: "Europe/Vienna", since: "2026-04-01", until: "2026-04-02", breakdown: true };
    const raw = await generateUsageReport(request, { usageEvents: await store.read() });
    const cached = await generateUsageReport(request, { usageStore: store });
    expect(cached.rows).toEqual(raw.rows);
    expect(cached.totals).toEqual(raw.totals);
    const read = vi.spyOn(store, "read").mockRejectedValue(new Error("Raw read must not run"));
    expect((await generateUsageReport(request, { usageStore: store })).rows).toEqual(raw.rows);
    expect(read).not.toHaveBeenCalled();
  });

  it("uses persisted rows in Models while retaining missing pricing evidence and raw component sums", async () => {
    const events = [event("a", "2026-01-01T01:00:00.000Z"), event("b", "2026-01-01T02:00:00.000Z", { inputCostUSD: undefined })];
    await store.upsert(events);
    const raw = await buildModelsData({ usageEvents: events });
    const cached = await buildModelsData({ usageStore: store });
    expect(cached.days).toEqual(raw.days);
    expect(cached.pricing).toEqual({});
    const readFile = vi.fn(fs.readFile);
    await buildModelsData({ usageStore: new PortableUsageStore(root, { ...fs, readFile: readFile as typeof fs.readFile }) });
    expect(readFile.mock.calls.filter(([file]) => String(file).endsWith(".jsonl"))).toHaveLength(0);
  });
});

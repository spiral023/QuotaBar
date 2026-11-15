import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingestPortableUsage } from "../src/portable/ingestion";
import type { PortableUsageEvent } from "../src/portable/types";
import { PortableUsageStore } from "../src/portable/usageStore";
import type { ClaudeUsageEntry } from "../src/pricing/jsonl-reader";

describe("portable enrichment immutable fields", () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "quotabar-enrichment-guard-")); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const raw: ClaudeUsageEntry = { provider: "claude", timestamp: "2026-01-01T01:00:00.000Z", model: "fixture-model",
    project: "Fixture", session: "fixture-session", sourceEventId: "fixture-event", inputTokens: 100,
    outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0 };

  async function setup() {
    const file = path.join(root, "source.jsonl"); await fs.writeFile(file, "fixture");
    return { store: new PortableUsageStore(path.join(root, "usage")), claudeRefs: [{ file, baseDir: root }],
      codexRefs: [], readClaude: async () => [raw] };
  }

  it("rejects an in-place token mutation during source enrichment", async () => {
    const options = await setup();
    const result = await ingestPortableUsage({ ...options, enrichCosts: async events => {
      events[0].inputTokens++; return [...events];
    } });
    expect(result.errors).toEqual([expect.objectContaining({ message: "cost_failed" })]);
    expect(await options.store.read()).toEqual([]);
  });

  it("rejects an in-place mutation during stored-event repair without committing state", async () => {
    const options = await setup(); await ingestPortableUsage(options);
    const before = await options.store.read(), state = await fs.readFile(options.store.getIngestStatePath(), "utf8");
    await expect(ingestPortableUsage({ ...options, enrichCosts: async events => {
      events[0].model = "changed"; return [...events];
    } })).rejects.toThrow("Portable cost enrichment failed");
    expect(await options.store.read()).toEqual(before);
    expect(await fs.readFile(options.store.getIngestStatePath(), "utf8")).toBe(state);
  });

  it("accepts cost changes with reordered object keys and rejects additional immutable fields", async () => {
    const options = await setup();
    const enrich = (events: readonly PortableUsageEvent[]) => events.map(value => ({
      ...Object.fromEntries(Object.entries(value).reverse()), costUSD: 1, inputCostUSD: 1, outputCostUSD: 0,
      cacheCreationCostUSD: 0, cacheReadCostUSD: 0, pricingVersion: "fixture-v1",
    } as PortableUsageEvent));
    expect(await ingestPortableUsage({ ...options, enrichCosts: async events => enrich(events).map(value => ({ ...value, extra: undefined })) }))
      .toMatchObject({ inserted: 0, errors: [expect.objectContaining({ message: "cost_failed" })] });
    expect(await ingestPortableUsage({ ...options, enrichCosts: async events => enrich(events) })).toMatchObject({ inserted: 1, errors: [] });
    expect((await options.store.read())[0]).toMatchObject({ inputTokens: 100, costUSD: 1, pricingVersion: "fixture-v1" });
  });
});

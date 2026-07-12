import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelPricing } from "../src/pricing/cost-calculator";
import { HistoricalPricingResolver, type ModelPricingLookup } from "../src/pricing/historical-pricing-resolver";
import { LITELLM_PRICING_SOURCE } from "../src/pricing/litellm-fetcher";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function temporaryHistoryPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qb-historical-pricing-"));
  tempDirs.push(dir);
  return path.join(dir, "cache", "historical-model-prices.json");
}

describe("HistoricalPricingResolver", () => {
  it("uses the price observed before each event when a model price changes", async () => {
    const historyPath = temporaryHistoryPath();
    let currentPricing: ModelPricing = { input_cost_per_token: 10e-6, output_cost_per_token: 20e-6 };
    let now = new Date("2026-05-01T00:00:00.000Z");
    const lookup: ModelPricingLookup = { getModelPricing: async () => currentPricing };

    const resolver = new HistoricalPricingResolver(lookup, { historyPath, now: () => now });
    await resolver.getModelPricing("test-model", "2026-05-01T00:00:00.000Z");

    currentPricing = { input_cost_per_token: 5e-6, output_cost_per_token: 10e-6 };
    now = new Date("2026-06-01T00:00:00.000Z");
    await resolver.getModelPricing("test-model", "2026-06-01T00:00:00.000Z");

    expect(await resolver.getModelPricing("test-model", "2026-05-02T12:00:00.000Z"))
      .toEqual({ input_cost_per_token: 10e-6, output_cost_per_token: 20e-6 });
    expect(await resolver.getModelPricing("test-model", "2026-06-02T12:00:00.000Z"))
      .toEqual({ input_cost_per_token: 5e-6, output_cost_per_token: 10e-6 });
  });

  it("uses the current price for legacy events without an earlier snapshot", async () => {
    const currentPricing: ModelPricing = { input_cost_per_token: 5e-6, output_cost_per_token: 10e-6 };
    const lookup: ModelPricingLookup = { getModelPricing: async () => currentPricing };
    const resolver = new HistoricalPricingResolver(lookup, {
      historyPath: temporaryHistoryPath(),
      now: () => new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(await resolver.getModelPricing("test-model", "2026-01-15T00:00:00.000Z")).toEqual(currentPricing);
  });

  it("persists one canonical epoch with a SHA-256 checksum when a price is unchanged", async () => {
    const historyPath = temporaryHistoryPath();
    const currentPricing: ModelPricing = {
      input_cost_per_token: 5e-6,
      output_cost_per_token: 10e-6,
      provider_specific_entry: { fast: 2 },
    };
    const lookup: ModelPricingLookup = { getModelPricing: async () => currentPricing };
    const resolver = new HistoricalPricingResolver(lookup, {
      historyPath,
      now: () => new Date("2026-06-01T00:00:00.000Z"),
    });

    await resolver.getModelPricing("test-model", "2026-06-01T00:00:00.000Z");
    await resolver.getModelPricing("test-model", "2026-06-02T00:00:00.000Z");

    const history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    expect(history.source).toBe(LITELLM_PRICING_SOURCE);
    expect(history.epochs["test-model"]).toEqual([
      expect.objectContaining({
        fetchedAt: "2026-06-01T00:00:00.000Z",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
        pricing: currentPricing,
      }),
    ]);
  });

  it("treats malformed history files as an empty history", async () => {
    const historyPath = temporaryHistoryPath();
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.writeFileSync(historyPath, JSON.stringify({
      version: 1,
      source: LITELLM_PRICING_SOURCE,
      epochs: { "test-model": "not-an-epoch-list" },
    }));
    const currentPricing: ModelPricing = { input_cost_per_token: 5e-6 };
    const lookup: ModelPricingLookup = { getModelPricing: async () => currentPricing };
    const resolver = new HistoricalPricingResolver(lookup, {
      historyPath,
      now: () => new Date("2026-06-01T00:00:00.000Z"),
    });

    await expect(resolver.getModelPricing("test-model", "2026-06-02T00:00:00.000Z"))
      .resolves.toEqual(currentPricing);
  });
});

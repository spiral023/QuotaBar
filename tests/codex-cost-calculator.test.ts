import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { calculateCodexApiCost, calculateCodexApiCostBreakdown, readCodexSpeedTier, readCodexSpeedTierFromPaths } from "../src/pricing/codex-cost-calculator";
import { sumBreakdown } from "../src/pricing/cost-calculator";
import { LiteLLMFetcher } from "../src/pricing/litellm-fetcher";
import { HistoricalPricingResolver, resetHistoricalPricingResolverCacheForTests } from "../src/pricing/historical-pricing-resolver";
import type { CodexTokenEvent } from "../src/pricing/codex-log-reader";

const tmpDir = path.join(os.tmpdir(), `quotabar-codex-calc-test-${process.pid}`);
let resolverIndex = 0;

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  resetHistoricalPricingResolverCacheForTests();
});

function makeEvent(overrides: Partial<CodexTokenEvent> = {}): CodexTokenEvent {
  return {
    timestamp: "2026-05-18T10:00:00.000Z",
    model: "gpt-4o",
    isFallback: false,
    inputTokens: 1000,
    cachedInputTokens: 0,
    outputTokens: 100,
    reasoningOutputTokens: 0,
    totalTokens: 1100,
    ...overrides,
  };
}

function createFallbackPricingResolver(): HistoricalPricingResolver {
  return new HistoricalPricingResolver(new LiteLLMFetcher(true), {
    historyPath: path.join(tmpDir, `pricing-history-${resolverIndex++}.json`),
  });
}

describe("calculateCodexApiCost", () => {
  it("returns 0 for empty events", async () => {
    const pricing = createFallbackPricingResolver();
    expect(await calculateCodexApiCost([], pricing, "standard")).toBe(0);
  });

  it("calculates cost for standard tier using gpt-4o fallback pricing", async () => {
    const pricing = createFallbackPricingResolver();
    const events = [makeEvent({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 })];
    const cost = await calculateCodexApiCost(events, pricing, "standard");
    // gpt-4o: input_cost_per_token = 2.5e-6 → 1M tokens = $2.50
    expect(cost).toBeCloseTo(2.5, 4);
  });

  it("calculates output cost", async () => {
    const pricing = createFallbackPricingResolver();
    const events = [makeEvent({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 1_000_000 })];
    const cost = await calculateCodexApiCost(events, pricing, "standard");
    // gpt-4o: output_cost_per_token = 1e-5 → 1M tokens = $10.00
    expect(cost).toBeCloseTo(10.0, 4);
  });

  it("subtracts cached tokens from non-cached input", async () => {
    const pricing = createFallbackPricingResolver();
    // 1M input, 400K cached → 600K non-cached at input price, 400K at cache_read price
    // gpt-4o has no cache_read price → cached cost falls back to input price
    const events = [makeEvent({ inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 0 })];
    const cost = await calculateCodexApiCost(events, pricing, "standard");
    // non-cached: 600_000 * 2.5e-6 = $1.50; cached: 400_000 * 2.5e-6 = $1.00
    expect(cost).toBeCloseTo(2.5, 4);
  });

  it("applies fast-tier multiplier", async () => {
    const pricing = createFallbackPricingResolver();
    const events = [makeEvent({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 })];
    const standard = await calculateCodexApiCost(events, pricing, "standard");
    const fast = await calculateCodexApiCost(events, pricing, "fast");
    // gpt-4o has no provider_specific_entry.fast → fallback multiplier 2
    expect(fast).toBeCloseTo(standard * 2, 4);
  });

  it("uses direct gpt-5-codex pricing instead of aliasing to gpt-5", async () => {
    const pricing = createFallbackPricingResolver();
    const events = [makeEvent({ model: "gpt-5-codex", inputTokens: 1000, outputTokens: 100 })];
    const cost = await calculateCodexApiCost(events, pricing, "standard");
    expect(cost).toBeGreaterThan(0);
  });

  it("returns 0 for event with unknown model (no pricing found)", async () => {
    const pricing = createFallbackPricingResolver();
    const events = [makeEvent({ model: "unknown-model-xyz-9999" })];
    const cost = await calculateCodexApiCost(events, pricing, "standard");
    expect(cost).toBe(0);
  });

  it("sums costs across multiple events", async () => {
    const pricing = createFallbackPricingResolver();
    const events = [
      makeEvent({ inputTokens: 500_000, cachedInputTokens: 0, outputTokens: 0 }),
      makeEvent({ inputTokens: 500_000, cachedInputTokens: 0, outputTokens: 0 }),
    ];
    const combined = await calculateCodexApiCost(events, pricing, "standard");
    const single = await calculateCodexApiCost([makeEvent({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 })], pricing, "standard");
    expect(combined).toBeCloseTo(single, 6);
  });

  it("uses the pricing epoch at each event timestamp", async () => {
    let inputCost = 2e-6;
    let observedAt = new Date("2026-05-01T00:00:00.000Z");
    const pricing = new HistoricalPricingResolver({
      getModelPricing: async () => ({ input_cost_per_token: inputCost }),
    }, {
      historyPath: path.join(tmpDir, "historical-epochs.json"),
      now: () => observedAt,
    });

    await pricing.getModelPricing("test-model");
    inputCost = 1e-6;
    observedAt = new Date("2026-06-01T00:00:00.000Z");
    await pricing.getModelPricing("test-model");

    const cost = await calculateCodexApiCost([
      makeEvent({ model: "test-model", timestamp: "2026-05-02T00:00:00.000Z", inputTokens: 1_000_000, outputTokens: 0 }),
      makeEvent({ model: "test-model", timestamp: "2026-06-02T00:00:00.000Z", inputTokens: 1_000_000, outputTokens: 0 }),
    ], pricing, "standard");

    expect(cost).toBeCloseTo(3, 6);
  });
});

describe("calculateCodexApiCostBreakdown", () => {
  it("Summe der Komponenten == calculateCodexApiCost", async () => {
    const pricing = createFallbackPricingResolver();
    const events = [makeEvent({ inputTokens: 1_000_000, cachedInputTokens: 200_000, outputTokens: 500_000 })];
    const b = await calculateCodexApiCostBreakdown(events, pricing, "standard");
    const total = await calculateCodexApiCost(events, pricing, "standard");
    expect(sumBreakdown(b)).toBeCloseTo(total, 9);
  });

  it("trennt Input/Output/Cache-Read; Cache-Creation immer 0", async () => {
    const pricing = createFallbackPricingResolver();
    const events = [makeEvent({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 })];
    const b = await calculateCodexApiCostBreakdown(events, pricing, "standard");
    // gpt-4o: input 2.5e-6 → $2.50, output 1e-5 → $10.00
    expect(b.inputCostUSD).toBeCloseTo(2.5, 4);
    expect(b.outputCostUSD).toBeCloseTo(10.0, 4);
    expect(b.cacheCreationCostUSD).toBe(0);
  });
});

describe("readCodexSpeedTier", () => {
  it("returns standard when config file does not exist", async () => {
    const tier = await readCodexSpeedTier("/nonexistent/config.toml");
    expect(tier).toBe("standard");
  });

  it("returns fast for service_tier = priority", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "config.toml"), 'service_tier = "priority"\nmodel = "gpt-5"\n', "utf8");
    const tier = await readCodexSpeedTier(path.join(tmpDir, "config.toml"));
    expect(tier).toBe("fast");
  });

  it("returns fast for service_tier = fast", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "config.toml"), "service_tier = fast\n", "utf8");
    const tier = await readCodexSpeedTier(path.join(tmpDir, "config.toml"));
    expect(tier).toBe("fast");
  });

  it("returns standard for service_tier = standard", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "config.toml"), 'service_tier = "standard"\n', "utf8");
    const tier = await readCodexSpeedTier(path.join(tmpDir, "config.toml"));
    expect(tier).toBe("standard");
  });

  it("returns standard when service_tier key is absent", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "config.toml"), 'model = "gpt-5"\npersonality = "pragmatic"\n', "utf8");
    const tier = await readCodexSpeedTier(path.join(tmpDir, "config.toml"));
    expect(tier).toBe("standard");
  });

  it("returns fast when any config path enables priority tier", async () => {
    const dirA = path.join(tmpDir, "a");
    const dirB = path.join(tmpDir, "b");
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });
    await fs.writeFile(path.join(dirA, "config.toml"), 'service_tier = "standard"\n', "utf8");
    await fs.writeFile(path.join(dirB, "config.toml"), 'service_tier = "priority"\n', "utf8");

    const tier = await readCodexSpeedTierFromPaths([
      path.join(dirA, "config.toml"),
      path.join(dirB, "config.toml"),
    ]);

    expect(tier).toBe("fast");
  });
});

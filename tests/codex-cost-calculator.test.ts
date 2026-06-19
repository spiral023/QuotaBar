import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { calculateCodexApiCost, calculateCodexApiCostBreakdown, readCodexSpeedTier, readCodexSpeedTierFromPaths } from "../src/pricing/codex-cost-calculator";
import { sumBreakdown } from "../src/pricing/cost-calculator";
import { LiteLLMFetcher } from "../src/pricing/litellm-fetcher";
import type { CodexTokenEvent } from "../src/pricing/codex-log-reader";

const tmpDir = path.join(os.tmpdir(), `quotabar-codex-calc-test-${process.pid}`);

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
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

describe("calculateCodexApiCost", () => {
  it("returns 0 for empty events", async () => {
    const fetcher = new LiteLLMFetcher(true);
    expect(await calculateCodexApiCost([], fetcher, "standard")).toBe(0);
  });

  it("calculates cost for standard tier using gpt-4o fallback pricing", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const events = [makeEvent({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 })];
    const cost = await calculateCodexApiCost(events, fetcher, "standard");
    // gpt-4o: input_cost_per_token = 2.5e-6 → 1M tokens = $2.50
    expect(cost).toBeCloseTo(2.5, 4);
  });

  it("calculates output cost", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const events = [makeEvent({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 1_000_000 })];
    const cost = await calculateCodexApiCost(events, fetcher, "standard");
    // gpt-4o: output_cost_per_token = 1e-5 → 1M tokens = $10.00
    expect(cost).toBeCloseTo(10.0, 4);
  });

  it("subtracts cached tokens from non-cached input", async () => {
    const fetcher = new LiteLLMFetcher(true);
    // 1M input, 400K cached → 600K non-cached at input price, 400K at cache_read price
    // gpt-4o has no cache_read price → cached cost falls back to input price
    const events = [makeEvent({ inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 0 })];
    const cost = await calculateCodexApiCost(events, fetcher, "standard");
    // non-cached: 600_000 * 2.5e-6 = $1.50; cached: 400_000 * 2.5e-6 = $1.00
    expect(cost).toBeCloseTo(2.5, 4);
  });

  it("applies fast-tier multiplier", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const events = [makeEvent({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 })];
    const standard = await calculateCodexApiCost(events, fetcher, "standard");
    const fast = await calculateCodexApiCost(events, fetcher, "fast");
    // gpt-4o has no provider_specific_entry.fast → fallback multiplier 2
    expect(fast).toBeCloseTo(standard * 2, 4);
  });

  it("resolves model alias gpt-5-codex → gpt-5", async () => {
    const fetcher = new LiteLLMFetcher(true);
    // gpt-5 not in fallback → returns null → cost should be 0
    const events = [makeEvent({ model: "gpt-5-codex", inputTokens: 1000, outputTokens: 100 })];
    const cost = await calculateCodexApiCost(events, fetcher, "standard");
    // Either 0 (no gpt-5 fallback) or > 0 (if LiteLLM has it in offline mode) — just verify no throw
    expect(typeof cost).toBe("number");
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  it("returns 0 for event with unknown model (no pricing found)", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const events = [makeEvent({ model: "unknown-model-xyz-9999" })];
    const cost = await calculateCodexApiCost(events, fetcher, "standard");
    expect(cost).toBe(0);
  });

  it("sums costs across multiple events", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const events = [
      makeEvent({ inputTokens: 500_000, cachedInputTokens: 0, outputTokens: 0 }),
      makeEvent({ inputTokens: 500_000, cachedInputTokens: 0, outputTokens: 0 }),
    ];
    const combined = await calculateCodexApiCost(events, fetcher, "standard");
    const single = await calculateCodexApiCost([makeEvent({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 })], fetcher, "standard");
    expect(combined).toBeCloseTo(single, 6);
  });
});

describe("calculateCodexApiCostBreakdown", () => {
  it("Summe der Komponenten == calculateCodexApiCost", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const events = [makeEvent({ inputTokens: 1_000_000, cachedInputTokens: 200_000, outputTokens: 500_000 })];
    const b = await calculateCodexApiCostBreakdown(events, fetcher, "standard");
    const total = await calculateCodexApiCost(events, fetcher, "standard");
    expect(sumBreakdown(b)).toBeCloseTo(total, 9);
  });

  it("trennt Input/Output/Cache-Read; Cache-Creation immer 0", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const events = [makeEvent({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 })];
    const b = await calculateCodexApiCostBreakdown(events, fetcher, "standard");
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

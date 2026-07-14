import { describe, expect, it, vi } from "vitest";
import type { ModelPricing } from "../src/pricing/cost-calculator";
import { enrichPortableEventCosts } from "../src/portable/costEnrichment";
import type { PortableUsageEvent } from "../src/portable/types";

function event(overrides: Partial<PortableUsageEvent> = {}): PortableUsageEvent {
  return {
    schemaVersion: 1,
    id: "a".repeat(64),
    provider: "claude",
    occurredAt: "2026-07-13T10:00:00.000Z",
    model: "claude-test",
    projectName: "QuotaBar",
    sessionKey: "b".repeat(64),
    source: "claude-log",
    synthetic: false,
    inputTokens: 100,
    outputTokens: 20,
    cacheCreationTokens: 10,
    cacheReadTokens: 5,
    reasoningOutputTokens: 0,
    ...overrides,
  };
}

function resolver(pricing: ModelPricing | null) {
  return {
    getModelPricingBatch: vi.fn(async (_model: string, timestamps: readonly string[]) =>
      timestamps.map(() => pricing ? { pricing, pricingVersion: `litellm:${"c".repeat(64)}` } : null)),
  };
}

describe("portable cost enrichment", () => {
  it("stores Claude totals, components, and a stable price version without changing identity", async () => {
    const original = event();
    const pricing = resolver({
      input_cost_per_token: 1,
      output_cost_per_token: 2,
      cache_creation_input_token_cost: 3,
      cache_read_input_token_cost: 4,
    });

    const [priced] = await enrichPortableEventCosts([original], pricing, "standard");

    expect(priced).toMatchObject({
      id: original.id,
      sessionKey: original.sessionKey,
      inputCostUSD: 100,
      outputCostUSD: 40,
      cacheCreationCostUSD: 30,
      cacheReadCostUSD: 20,
      costUSD: 190,
      pricingVersion: `litellm:${"c".repeat(64)}`,
    });
    expect(original.costUSD).toBeUndefined();
  });

  it("uses Codex cache fallback, model alias, and fast pricing without touching legacy reconciliation", async () => {
    const pricing = resolver({ input_cost_per_token: 1, output_cost_per_token: 2, provider_specific_entry: { fast: 3 } });
    const codex = event({
      provider: "codex",
      source: "codex-log",
      model: "gpt-5.3-codex",
      inputTokens: 80,
      outputTokens: 20,
      cacheCreationTokens: 0,
      cacheReadTokens: 20,
    });
    const legacy = event({ id: "d".repeat(64), source: "legacy-reconciliation", synthetic: true });

    const [priced, untouched] = await enrichPortableEventCosts([codex, legacy], pricing, "fast");

    expect(pricing.getModelPricingBatch).toHaveBeenCalledWith("gpt-5.2-codex", [codex.occurredAt]);
    expect(priced).toMatchObject({
      id: codex.id,
      inputCostUSD: 240,
      outputCostUSD: 120,
      cacheCreationCostUSD: 0,
      cacheReadCostUSD: 60,
      costUSD: 420,
      pricingVersion: `litellm:${"c".repeat(64)};speed=fast`,
    });
    expect(untouched).toBe(legacy);
  });

  it("scales calculated components to an authoritative source total", async () => {
    const source = event({ costUSD: 19 });
    const [priced] = await enrichPortableEventCosts([source], resolver({
      input_cost_per_token: 1,
      output_cost_per_token: 2,
      cache_creation_input_token_cost: 3,
      cache_read_input_token_cost: 4,
    }), "standard");

    expect(priced.costUSD).toBe(19);
    expect((priced.inputCostUSD ?? 0) + (priced.outputCostUSD ?? 0)
      + (priced.cacheCreationCostUSD ?? 0) + (priced.cacheReadCostUSD ?? 0)).toBeCloseTo(19);
  });

  it("groups more than 120k events into one historical lookup per model", async () => {
    const pricing = resolver({ input_cost_per_token: 1 });
    const events = Array.from({ length: 120_001 }, (_, index) => event({
      id: index.toString(16).padStart(64, "0"),
      occurredAt: new Date(Date.UTC(2026, 0, 1) + index).toISOString(),
    }));

    const priced = await enrichPortableEventCosts(events, pricing, "standard");

    expect(priced).toHaveLength(events.length);
    expect(pricing.getModelPricingBatch).toHaveBeenCalledOnce();
  });

  it("leaves unknown prices retryable and does not invent zero-cost metadata", async () => {
    const original = event();
    const [unpriced] = await enrichPortableEventCosts([original], resolver(null), "standard");
    expect(unpriced).toBe(original);
    expect(unpriced).not.toHaveProperty("pricingVersion");
    expect(unpriced).not.toHaveProperty("costUSD");
  });
});

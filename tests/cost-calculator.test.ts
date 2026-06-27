import { describe, expect, it } from "vitest";
import {
  calculateTieredCost, calculateCostFromTokens, calculateCostBreakdown,
  scaleBreakdownTo, sumBreakdown,
} from "../src/pricing/cost-calculator";
import type { ModelPricing } from "../src/pricing/cost-calculator";

describe("calculateTieredCost", () => {
  it("returns 0 for undefined tokens", () => {
    expect(calculateTieredCost(undefined, 3e-6, 1.5e-6)).toBe(0);
  });

  it("returns 0 for zero tokens", () => {
    expect(calculateTieredCost(0, 3e-6, 1.5e-6)).toBe(0);
  });

  it("uses base price below 200k threshold", () => {
    expect(calculateTieredCost(100_000, 3e-6, 1.5e-6)).toBeCloseTo(100_000 * 3e-6);
  });

  it("applies tiered pricing above 200k tokens", () => {
    const cost = calculateTieredCost(250_000, 3e-6, 1.5e-6);
    expect(cost).toBeCloseTo(200_000 * 3e-6 + 50_000 * 1.5e-6);
  });

  it("uses only base price when tieredPrice is undefined", () => {
    expect(calculateTieredCost(300_000, 3e-6, undefined)).toBeCloseTo(300_000 * 3e-6);
  });

  it("returns 0 when basePrice is undefined", () => {
    expect(calculateTieredCost(100_000, undefined, undefined)).toBe(0);
  });
});

describe("calculateCostFromTokens", () => {
  it("sums input and output costs", () => {
    const pricing: ModelPricing = {
      input_cost_per_token: 3e-6,
      output_cost_per_token: 15e-6,
    };
    const cost = calculateCostFromTokens({ input_tokens: 1000, output_tokens: 200 }, pricing);
    expect(cost).toBeCloseTo(1000 * 3e-6 + 200 * 15e-6);
  });

  it("includes cache creation and read costs", () => {
    const pricing: ModelPricing = {
      input_cost_per_token: 3e-6,
      output_cost_per_token: 15e-6,
      cache_creation_input_token_cost: 3.75e-6,
      cache_read_input_token_cost: 0.3e-6,
    };
    const cost = calculateCostFromTokens(
      { input_tokens: 100, output_tokens: 100, cache_creation_input_tokens: 500, cache_read_input_tokens: 1000 },
      pricing,
    );
    expect(cost).toBeCloseTo(100 * 3e-6 + 100 * 15e-6 + 500 * 3.75e-6 + 1000 * 0.3e-6);
  });

  it("applies fast mode multiplier", () => {
    const pricing: ModelPricing = {
      input_cost_per_token: 3e-6,
      output_cost_per_token: 15e-6,
      provider_specific_entry: { fast: 6 },
    };
    const normal = calculateCostFromTokens({ input_tokens: 1000, output_tokens: 100 }, pricing);
    const fast = calculateCostFromTokens({ input_tokens: 1000, output_tokens: 100, speed: "fast" }, pricing);
    expect(fast).toBeCloseTo(normal * 6);
  });

  it("ignores fast multiplier in standard mode", () => {
    const pricing: ModelPricing = {
      input_cost_per_token: 3e-6,
      output_cost_per_token: 15e-6,
      provider_specific_entry: { fast: 6 },
    };
    const cost = calculateCostFromTokens({ input_tokens: 1000, output_tokens: 100, speed: "standard" }, pricing);
    expect(cost).toBeCloseTo(1000 * 3e-6 + 100 * 15e-6);
  });
});

describe("calculateCostBreakdown", () => {
  const pricing: ModelPricing = {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 15e-6,
    cache_creation_input_token_cost: 3.75e-6,
    cache_read_input_token_cost: 0.3e-6,
  };
  const tokens = {
    input_tokens: 100, output_tokens: 100,
    cache_creation_input_tokens: 500, cache_read_input_tokens: 1000,
  };

  it("Summe der Komponenten == calculateCostFromTokens", () => {
    const b = calculateCostBreakdown(tokens, pricing);
    expect(sumBreakdown(b)).toBeCloseTo(calculateCostFromTokens(tokens, pricing));
  });

  it("ordnet jedem Typ seinen Posten zu", () => {
    const b = calculateCostBreakdown(tokens, pricing);
    expect(b.inputCostUSD).toBeCloseTo(100 * 3e-6);
    expect(b.outputCostUSD).toBeCloseTo(100 * 15e-6);
    expect(b.cacheCreationCostUSD).toBeCloseTo(500 * 3.75e-6);
    expect(b.cacheReadCostUSD).toBeCloseTo(1000 * 0.3e-6);
  });

  it("Fast-Multiplikator wirkt auf jede Komponente", () => {
    const fastPricing: ModelPricing = { ...pricing, provider_specific_entry: { fast: 4 } };
    const normal = calculateCostBreakdown(tokens, fastPricing);
    const fast = calculateCostBreakdown({ ...tokens, speed: "fast" }, fastPricing);
    expect(fast.outputCostUSD).toBeCloseTo(normal.outputCostUSD * 4);
  });

  it("uses total Anthropic input context to choose the >200k tier for all input token types", () => {
    const tieredPricing: ModelPricing = {
      input_cost_per_token: 1,
      cache_read_input_token_cost: 2,
      cache_creation_input_token_cost: 3,
      output_cost_per_token: 4,
      input_cost_per_token_above_200k_tokens: 10,
      cache_read_input_token_cost_above_200k_tokens: 20,
      cache_creation_input_token_cost_above_200k_tokens: 30,
      output_cost_per_token_above_200k_tokens: 40,
    };

    const b = calculateCostBreakdown({
      input_tokens: 150_000,
      cache_read_input_tokens: 150_000,
      cache_creation_input_tokens: 0,
      output_tokens: 1_000,
    }, tieredPricing);

    expect(b.inputCostUSD).toBe(150_000 * 10);
    expect(b.cacheReadCostUSD).toBe(150_000 * 20);
    expect(b.outputCostUSD).toBe(1_000 * 40);
  });
});

describe("scaleBreakdownTo", () => {
  const b = { inputCostUSD: 1, outputCostUSD: 2, cacheCreationCostUSD: 0, cacheReadCostUSD: 1 }; // Σ=4

  it("skaliert exakt auf die Zielsumme, Verhältnisse bleiben", () => {
    const scaled = scaleBreakdownTo(b, 8); // Faktor 2
    expect(sumBreakdown(scaled)).toBeCloseTo(8, 9);
    expect(scaled.outputCostUSD).toBeCloseTo(4, 9);
  });

  it("Faktor 1 bei identischer Summe (rein berechnete Kosten → exakt)", () => {
    const scaled = scaleBreakdownTo(b, 4);
    expect(scaled).toEqual(b);
  });

  it("Nullsumme → alles 0 (kein Pricing)", () => {
    const zero = scaleBreakdownTo({ inputCostUSD: 0, outputCostUSD: 0, cacheCreationCostUSD: 0, cacheReadCostUSD: 0 }, 5);
    expect(sumBreakdown(zero)).toBe(0);
  });
});

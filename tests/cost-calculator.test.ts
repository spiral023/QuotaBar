import { describe, expect, it } from "vitest";
import { calculateTieredCost, calculateCostFromTokens } from "../src/pricing/cost-calculator";
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

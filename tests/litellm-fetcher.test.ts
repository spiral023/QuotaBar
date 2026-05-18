import { describe, expect, it } from "vitest";
import { LiteLLMFetcher } from "../src/pricing/litellm-fetcher";

describe("LiteLLMFetcher (offline mode)", () => {
  it("returns fallback pricing for claude-sonnet-4-5", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const pricing = await fetcher.getModelPricing("claude-sonnet-4-5");
    expect(pricing).not.toBeNull();
    expect(pricing!.input_cost_per_token).toBeGreaterThan(0);
    expect(pricing!.output_cost_per_token).toBeGreaterThan(0);
  });

  it("returns fallback pricing for gpt-4o", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const pricing = await fetcher.getModelPricing("gpt-4o");
    expect(pricing).not.toBeNull();
    expect(pricing!.input_cost_per_token).toBeGreaterThan(0);
  });

  it("returns null for unknown model", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const pricing = await fetcher.getModelPricing("unknown-model-xyz-9999");
    expect(pricing).toBeNull();
  });

  it("caches results across multiple calls", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const first = await fetcher.getModelPricing("claude-sonnet-4-5");
    const second = await fetcher.getModelPricing("claude-sonnet-4-5");
    expect(first).toBe(second);
  });

  it("finds model by fuzzy match (partial name)", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const pricing = await fetcher.getModelPricing("opus-4");
    expect(pricing).not.toBeNull();
  });

  it("still resolves gpt-4o after prefix-lookup change (regression)", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const pricing = await fetcher.getModelPricing("gpt-4o");
    expect(pricing).not.toBeNull();
    expect(pricing!.input_cost_per_token).toBeGreaterThan(0);
  });

  it("returns pricing for gpt-5.5", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const pricing = await fetcher.getModelPricing("gpt-5.5");
    expect(pricing).not.toBeNull();
    expect(pricing!.input_cost_per_token).toBeCloseTo(5e-6, 10);
    expect(pricing!.output_cost_per_token).toBeCloseTo(30e-6, 10);
    expect(pricing!.cache_read_input_token_cost).toBeCloseTo(0.5e-6, 10);
  });

  it("returns pricing for gpt-5.4", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const pricing = await fetcher.getModelPricing("gpt-5.4");
    expect(pricing).not.toBeNull();
    expect(pricing!.input_cost_per_token).toBeCloseTo(2.5e-6, 10);
    expect(pricing!.output_cost_per_token).toBeCloseTo(15e-6, 10);
    expect(pricing!.cache_read_input_token_cost).toBeCloseTo(0.25e-6, 10);
  });

  it("returns pricing for gpt-5.4-mini", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const pricing = await fetcher.getModelPricing("gpt-5.4-mini");
    expect(pricing).not.toBeNull();
    expect(pricing!.input_cost_per_token).toBeCloseTo(0.75e-6, 10);
    expect(pricing!.output_cost_per_token).toBeCloseTo(4.5e-6, 10);
  });
});

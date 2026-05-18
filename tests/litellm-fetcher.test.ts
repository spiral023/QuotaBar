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

  it("returns fallback pricing for gemini-2.0-flash", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const pricing = await fetcher.getModelPricing("gemini-2.0-flash");
    expect(pricing).not.toBeNull();
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
});

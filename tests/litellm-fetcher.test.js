"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const litellm_fetcher_1 = require("../src/pricing/litellm-fetcher");
(0, vitest_1.describe)("LiteLLMFetcher (offline mode)", () => {
    (0, vitest_1.it)("returns fallback pricing for claude-sonnet-4-5", async () => {
        const fetcher = new litellm_fetcher_1.LiteLLMFetcher(true);
        const pricing = await fetcher.getModelPricing("claude-sonnet-4-5");
        (0, vitest_1.expect)(pricing).not.toBeNull();
        (0, vitest_1.expect)(pricing.input_cost_per_token).toBeGreaterThan(0);
        (0, vitest_1.expect)(pricing.output_cost_per_token).toBeGreaterThan(0);
    });
    (0, vitest_1.it)("returns fallback pricing for gpt-4o", async () => {
        const fetcher = new litellm_fetcher_1.LiteLLMFetcher(true);
        const pricing = await fetcher.getModelPricing("gpt-4o");
        (0, vitest_1.expect)(pricing).not.toBeNull();
        (0, vitest_1.expect)(pricing.input_cost_per_token).toBeGreaterThan(0);
    });
    (0, vitest_1.it)("returns null for unknown model", async () => {
        const fetcher = new litellm_fetcher_1.LiteLLMFetcher(true);
        const pricing = await fetcher.getModelPricing("unknown-model-xyz-9999");
        (0, vitest_1.expect)(pricing).toBeNull();
    });
    (0, vitest_1.it)("caches results across multiple calls", async () => {
        const fetcher = new litellm_fetcher_1.LiteLLMFetcher(true);
        const first = await fetcher.getModelPricing("claude-sonnet-4-5");
        const second = await fetcher.getModelPricing("claude-sonnet-4-5");
        (0, vitest_1.expect)(first).toBe(second);
    });
    (0, vitest_1.it)("finds model by fuzzy match (partial name)", async () => {
        const fetcher = new litellm_fetcher_1.LiteLLMFetcher(true);
        const pricing = await fetcher.getModelPricing("opus-4");
        (0, vitest_1.expect)(pricing).not.toBeNull();
    });
    (0, vitest_1.it)("still resolves gpt-4o after prefix-lookup change (regression)", async () => {
        const fetcher = new litellm_fetcher_1.LiteLLMFetcher(true);
        const pricing = await fetcher.getModelPricing("gpt-4o");
        (0, vitest_1.expect)(pricing).not.toBeNull();
        (0, vitest_1.expect)(pricing.input_cost_per_token).toBeGreaterThan(0);
    });
    (0, vitest_1.it)("returns pricing for gpt-5.5", async () => {
        const fetcher = new litellm_fetcher_1.LiteLLMFetcher(true);
        const pricing = await fetcher.getModelPricing("gpt-5.5");
        (0, vitest_1.expect)(pricing).not.toBeNull();
        (0, vitest_1.expect)(pricing.input_cost_per_token).toBeCloseTo(5e-6, 10);
        (0, vitest_1.expect)(pricing.output_cost_per_token).toBeCloseTo(30e-6, 10);
        (0, vitest_1.expect)(pricing.cache_read_input_token_cost).toBeCloseTo(0.5e-6, 10);
    });
    (0, vitest_1.it)("returns pricing for gpt-5.4", async () => {
        const fetcher = new litellm_fetcher_1.LiteLLMFetcher(true);
        const pricing = await fetcher.getModelPricing("gpt-5.4");
        (0, vitest_1.expect)(pricing).not.toBeNull();
        (0, vitest_1.expect)(pricing.input_cost_per_token).toBeCloseTo(2.5e-6, 10);
        (0, vitest_1.expect)(pricing.output_cost_per_token).toBeCloseTo(15e-6, 10);
        (0, vitest_1.expect)(pricing.cache_read_input_token_cost).toBeCloseTo(0.25e-6, 10);
    });
    (0, vitest_1.it)("returns pricing for gpt-5.4-mini", async () => {
        const fetcher = new litellm_fetcher_1.LiteLLMFetcher(true);
        const pricing = await fetcher.getModelPricing("gpt-5.4-mini");
        (0, vitest_1.expect)(pricing).not.toBeNull();
        (0, vitest_1.expect)(pricing.input_cost_per_token).toBeCloseTo(0.75e-6, 10);
        (0, vitest_1.expect)(pricing.output_cost_per_token).toBeCloseTo(4.5e-6, 10);
    });
});

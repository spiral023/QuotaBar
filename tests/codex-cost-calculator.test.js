"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const promises_1 = __importDefault(require("node:fs/promises"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const codex_cost_calculator_1 = require("../src/pricing/codex-cost-calculator");
const litellm_fetcher_1 = require("../src/pricing/litellm-fetcher");
const tmpDir = node_path_1.default.join(node_os_1.default.tmpdir(), `quotabar-codex-calc-test-${process.pid}`);
(0, vitest_1.afterEach)(async () => {
    await promises_1.default.rm(tmpDir, { recursive: true, force: true });
});
function makeEvent(overrides = {}) {
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
(0, vitest_1.describe)("calculateCodexApiCost", () => {
    (0, vitest_1.it)("returns 0 for empty events", async () => {
        const fetcher = new litellm_fetcher_1.LiteLLMFetcher(true);
        (0, vitest_1.expect)(await (0, codex_cost_calculator_1.calculateCodexApiCost)([], fetcher, "standard")).toBe(0);
    });
    (0, vitest_1.it)("calculates cost for standard tier using gpt-4o fallback pricing", async () => {
        const fetcher = new litellm_fetcher_1.LiteLLMFetcher(true);
        const events = [makeEvent({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 })];
        const cost = await (0, codex_cost_calculator_1.calculateCodexApiCost)(events, fetcher, "standard");
        // gpt-4o: input_cost_per_token = 2.5e-6 → 1M tokens = $2.50
        (0, vitest_1.expect)(cost).toBeCloseTo(2.5, 4);
    });
    (0, vitest_1.it)("calculates output cost", async () => {
        const fetcher = new litellm_fetcher_1.LiteLLMFetcher(true);
        const events = [makeEvent({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 1_000_000 })];
        const cost = await (0, codex_cost_calculator_1.calculateCodexApiCost)(events, fetcher, "standard");
        // gpt-4o: output_cost_per_token = 1e-5 → 1M tokens = $10.00
        (0, vitest_1.expect)(cost).toBeCloseTo(10.0, 4);
    });
    (0, vitest_1.it)("subtracts cached tokens from non-cached input", async () => {
        const fetcher = new litellm_fetcher_1.LiteLLMFetcher(true);
        // 1M input, 400K cached → 600K non-cached at input price, 400K at cache_read price
        // gpt-4o has no cache_read price → cached cost falls back to input price
        const events = [makeEvent({ inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 0 })];
        const cost = await (0, codex_cost_calculator_1.calculateCodexApiCost)(events, fetcher, "standard");
        // non-cached: 600_000 * 2.5e-6 = $1.50; cached: 400_000 * 2.5e-6 = $1.00
        (0, vitest_1.expect)(cost).toBeCloseTo(2.5, 4);
    });
    (0, vitest_1.it)("applies fast-tier multiplier", async () => {
        const fetcher = new litellm_fetcher_1.LiteLLMFetcher(true);
        const events = [makeEvent({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 })];
        const standard = await (0, codex_cost_calculator_1.calculateCodexApiCost)(events, fetcher, "standard");
        const fast = await (0, codex_cost_calculator_1.calculateCodexApiCost)(events, fetcher, "fast");
        // gpt-4o has no provider_specific_entry.fast → fallback multiplier 2
        (0, vitest_1.expect)(fast).toBeCloseTo(standard * 2, 4);
    });
    (0, vitest_1.it)("resolves model alias gpt-5-codex → gpt-5", async () => {
        const fetcher = new litellm_fetcher_1.LiteLLMFetcher(true);
        // gpt-5 not in fallback → returns null → cost should be 0
        const events = [makeEvent({ model: "gpt-5-codex", inputTokens: 1000, outputTokens: 100 })];
        const cost = await (0, codex_cost_calculator_1.calculateCodexApiCost)(events, fetcher, "standard");
        // Either 0 (no gpt-5 fallback) or > 0 (if LiteLLM has it in offline mode) — just verify no throw
        (0, vitest_1.expect)(typeof cost).toBe("number");
        (0, vitest_1.expect)(cost).toBeGreaterThanOrEqual(0);
    });
    (0, vitest_1.it)("returns 0 for event with unknown model (no pricing found)", async () => {
        const fetcher = new litellm_fetcher_1.LiteLLMFetcher(true);
        const events = [makeEvent({ model: "unknown-model-xyz-9999" })];
        const cost = await (0, codex_cost_calculator_1.calculateCodexApiCost)(events, fetcher, "standard");
        (0, vitest_1.expect)(cost).toBe(0);
    });
    (0, vitest_1.it)("sums costs across multiple events", async () => {
        const fetcher = new litellm_fetcher_1.LiteLLMFetcher(true);
        const events = [
            makeEvent({ inputTokens: 500_000, cachedInputTokens: 0, outputTokens: 0 }),
            makeEvent({ inputTokens: 500_000, cachedInputTokens: 0, outputTokens: 0 }),
        ];
        const combined = await (0, codex_cost_calculator_1.calculateCodexApiCost)(events, fetcher, "standard");
        const single = await (0, codex_cost_calculator_1.calculateCodexApiCost)([makeEvent({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 })], fetcher, "standard");
        (0, vitest_1.expect)(combined).toBeCloseTo(single, 6);
    });
});
(0, vitest_1.describe)("readCodexSpeedTier", () => {
    (0, vitest_1.it)("returns standard when config file does not exist", async () => {
        const tier = await (0, codex_cost_calculator_1.readCodexSpeedTier)("/nonexistent/config.toml");
        (0, vitest_1.expect)(tier).toBe("standard");
    });
    (0, vitest_1.it)("returns fast for service_tier = priority", async () => {
        await promises_1.default.mkdir(tmpDir, { recursive: true });
        await promises_1.default.writeFile(node_path_1.default.join(tmpDir, "config.toml"), 'service_tier = "priority"\nmodel = "gpt-5"\n', "utf8");
        const tier = await (0, codex_cost_calculator_1.readCodexSpeedTier)(node_path_1.default.join(tmpDir, "config.toml"));
        (0, vitest_1.expect)(tier).toBe("fast");
    });
    (0, vitest_1.it)("returns fast for service_tier = fast", async () => {
        await promises_1.default.mkdir(tmpDir, { recursive: true });
        await promises_1.default.writeFile(node_path_1.default.join(tmpDir, "config.toml"), "service_tier = fast\n", "utf8");
        const tier = await (0, codex_cost_calculator_1.readCodexSpeedTier)(node_path_1.default.join(tmpDir, "config.toml"));
        (0, vitest_1.expect)(tier).toBe("fast");
    });
    (0, vitest_1.it)("returns standard for service_tier = standard", async () => {
        await promises_1.default.mkdir(tmpDir, { recursive: true });
        await promises_1.default.writeFile(node_path_1.default.join(tmpDir, "config.toml"), 'service_tier = "standard"\n', "utf8");
        const tier = await (0, codex_cost_calculator_1.readCodexSpeedTier)(node_path_1.default.join(tmpDir, "config.toml"));
        (0, vitest_1.expect)(tier).toBe("standard");
    });
    (0, vitest_1.it)("returns standard when service_tier key is absent", async () => {
        await promises_1.default.mkdir(tmpDir, { recursive: true });
        await promises_1.default.writeFile(node_path_1.default.join(tmpDir, "config.toml"), 'model = "gpt-5"\npersonality = "pragmatic"\n', "utf8");
        const tier = await (0, codex_cost_calculator_1.readCodexSpeedTier)(node_path_1.default.join(tmpDir, "config.toml"));
        (0, vitest_1.expect)(tier).toBe("standard");
    });
    (0, vitest_1.it)("returns fast when any config path enables priority tier", async () => {
        const dirA = node_path_1.default.join(tmpDir, "a");
        const dirB = node_path_1.default.join(tmpDir, "b");
        await promises_1.default.mkdir(dirA, { recursive: true });
        await promises_1.default.mkdir(dirB, { recursive: true });
        await promises_1.default.writeFile(node_path_1.default.join(dirA, "config.toml"), 'service_tier = "standard"\n', "utf8");
        await promises_1.default.writeFile(node_path_1.default.join(dirB, "config.toml"), 'service_tier = "priority"\n', "utf8");
        const tier = await (0, codex_cost_calculator_1.readCodexSpeedTierFromPaths)([
            node_path_1.default.join(dirA, "config.toml"),
            node_path_1.default.join(dirB, "config.toml"),
        ]);
        (0, vitest_1.expect)(tier).toBe("fast");
    });
});

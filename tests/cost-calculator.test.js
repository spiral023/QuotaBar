"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const cost_calculator_1 = require("../src/pricing/cost-calculator");
(0, vitest_1.describe)("calculateTieredCost", () => {
    (0, vitest_1.it)("returns 0 for undefined tokens", () => {
        (0, vitest_1.expect)((0, cost_calculator_1.calculateTieredCost)(undefined, 3e-6, 1.5e-6)).toBe(0);
    });
    (0, vitest_1.it)("returns 0 for zero tokens", () => {
        (0, vitest_1.expect)((0, cost_calculator_1.calculateTieredCost)(0, 3e-6, 1.5e-6)).toBe(0);
    });
    (0, vitest_1.it)("uses base price below 200k threshold", () => {
        (0, vitest_1.expect)((0, cost_calculator_1.calculateTieredCost)(100_000, 3e-6, 1.5e-6)).toBeCloseTo(100_000 * 3e-6);
    });
    (0, vitest_1.it)("applies tiered pricing above 200k tokens", () => {
        const cost = (0, cost_calculator_1.calculateTieredCost)(250_000, 3e-6, 1.5e-6);
        (0, vitest_1.expect)(cost).toBeCloseTo(200_000 * 3e-6 + 50_000 * 1.5e-6);
    });
    (0, vitest_1.it)("uses only base price when tieredPrice is undefined", () => {
        (0, vitest_1.expect)((0, cost_calculator_1.calculateTieredCost)(300_000, 3e-6, undefined)).toBeCloseTo(300_000 * 3e-6);
    });
    (0, vitest_1.it)("returns 0 when basePrice is undefined", () => {
        (0, vitest_1.expect)((0, cost_calculator_1.calculateTieredCost)(100_000, undefined, undefined)).toBe(0);
    });
});
(0, vitest_1.describe)("calculateCostFromTokens", () => {
    (0, vitest_1.it)("sums input and output costs", () => {
        const pricing = {
            input_cost_per_token: 3e-6,
            output_cost_per_token: 15e-6,
        };
        const cost = (0, cost_calculator_1.calculateCostFromTokens)({ input_tokens: 1000, output_tokens: 200 }, pricing);
        (0, vitest_1.expect)(cost).toBeCloseTo(1000 * 3e-6 + 200 * 15e-6);
    });
    (0, vitest_1.it)("includes cache creation and read costs", () => {
        const pricing = {
            input_cost_per_token: 3e-6,
            output_cost_per_token: 15e-6,
            cache_creation_input_token_cost: 3.75e-6,
            cache_read_input_token_cost: 0.3e-6,
        };
        const cost = (0, cost_calculator_1.calculateCostFromTokens)({ input_tokens: 100, output_tokens: 100, cache_creation_input_tokens: 500, cache_read_input_tokens: 1000 }, pricing);
        (0, vitest_1.expect)(cost).toBeCloseTo(100 * 3e-6 + 100 * 15e-6 + 500 * 3.75e-6 + 1000 * 0.3e-6);
    });
    (0, vitest_1.it)("applies fast mode multiplier", () => {
        const pricing = {
            input_cost_per_token: 3e-6,
            output_cost_per_token: 15e-6,
            provider_specific_entry: { fast: 6 },
        };
        const normal = (0, cost_calculator_1.calculateCostFromTokens)({ input_tokens: 1000, output_tokens: 100 }, pricing);
        const fast = (0, cost_calculator_1.calculateCostFromTokens)({ input_tokens: 1000, output_tokens: 100, speed: "fast" }, pricing);
        (0, vitest_1.expect)(fast).toBeCloseTo(normal * 6);
    });
    (0, vitest_1.it)("ignores fast multiplier in standard mode", () => {
        const pricing = {
            input_cost_per_token: 3e-6,
            output_cost_per_token: 15e-6,
            provider_specific_entry: { fast: 6 },
        };
        const cost = (0, cost_calculator_1.calculateCostFromTokens)({ input_tokens: 1000, output_tokens: 100, speed: "standard" }, pricing);
        (0, vitest_1.expect)(cost).toBeCloseTo(1000 * 3e-6 + 100 * 15e-6);
    });
});

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const modelNames_1 = require("../src/shared/modelNames");
(0, vitest_1.describe)("normalizeModelName", () => {
    (0, vitest_1.it)("strips date suffix from Claude model names", () => {
        (0, vitest_1.expect)((0, modelNames_1.normalizeModelName)("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
        (0, vitest_1.expect)((0, modelNames_1.normalizeModelName)("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
    });
    (0, vitest_1.it)("leaves names without date suffix unchanged", () => {
        (0, vitest_1.expect)((0, modelNames_1.normalizeModelName)("claude-opus-4-8")).toBe("claude-opus-4-8");
        (0, vitest_1.expect)((0, modelNames_1.normalizeModelName)("gpt-5.3-codex")).toBe("gpt-5.3-codex");
        (0, vitest_1.expect)((0, modelNames_1.normalizeModelName)("gpt-5-codex-mini")).toBe("gpt-5-codex-mini");
    });
    (0, vitest_1.it)("does not strip version-like fragments that are not dates", () => {
        (0, vitest_1.expect)((0, modelNames_1.normalizeModelName)("gpt-5.4-mini")).toBe("gpt-5.4-mini");
    });
});
(0, vitest_1.describe)("isIgnoredModel", () => {
    (0, vitest_1.it)("ignores synthetic, unknown and empty", () => {
        (0, vitest_1.expect)((0, modelNames_1.isIgnoredModel)("<synthetic>")).toBe(true);
        (0, vitest_1.expect)((0, modelNames_1.isIgnoredModel)("unknown")).toBe(true);
        (0, vitest_1.expect)((0, modelNames_1.isIgnoredModel)("")).toBe(true);
    });
    (0, vitest_1.it)("keeps real model names", () => {
        (0, vitest_1.expect)((0, modelNames_1.isIgnoredModel)("claude-opus-4-8")).toBe(false);
        (0, vitest_1.expect)((0, modelNames_1.isIgnoredModel)("gpt-5.5")).toBe(false);
    });
});

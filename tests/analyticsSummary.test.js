"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const analyticsSummary_1 = require("../src/main/analyticsSummary");
function makeRow(bucket, costUSD, provider, models = []) {
    return {
        bucket, provider, costUSD,
        inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
        totalTokens: 0, models,
        modelBreakdowns: models.map(model => ({ model, costUSD, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 })),
    };
}
(0, vitest_1.describe)("computeActiveDays", () => {
    (0, vitest_1.it)("counts union of dates from claude and codex rows", () => {
        const claude = [makeRow("2026-05-01", 1, "claude"), makeRow("2026-05-02", 1, "claude")];
        const codex = [makeRow("2026-05-02", 1, "codex"), makeRow("2026-05-03", 1, "codex")];
        (0, vitest_1.expect)((0, analyticsSummary_1.computeActiveDays)(claude, codex)).toBe(3);
    });
    (0, vitest_1.it)("returns 0 for empty input", () => {
        (0, vitest_1.expect)((0, analyticsSummary_1.computeActiveDays)([], [])).toBe(0);
    });
});
(0, vitest_1.describe)("buildSparkline7d", () => {
    (0, vitest_1.it)("returns 7 entries", () => {
        (0, vitest_1.expect)((0, analyticsSummary_1.buildSparkline7d)([], [])).toHaveLength(7);
    });
    (0, vitest_1.it)("fills claudeUSD from matching rows", () => {
        const today = new Date().toISOString().slice(0, 10);
        const rows = [makeRow(today, 5.5, "claude")];
        const sparkline = (0, analyticsSummary_1.buildSparkline7d)(rows, []);
        const todayEntry = sparkline.find(s => s.date === today);
        (0, vitest_1.expect)(todayEntry?.claudeUSD).toBe(5.5);
    });
});
(0, vitest_1.describe)("buildTopModels", () => {
    (0, vitest_1.it)("aggregates model costs across providers, sorted descending", () => {
        const claude = [makeRow("2026-05-01", 10, "claude", ["claude-sonnet-4-6"])];
        const codex = [makeRow("2026-05-01", 20, "codex", ["gpt-5.5"])];
        const top = (0, analyticsSummary_1.buildTopModels)(claude, codex, 5);
        (0, vitest_1.expect)(top[0].model).toBe("gpt-5.5");
        (0, vitest_1.expect)(top[0].costUSD).toBe(20);
        (0, vitest_1.expect)(top[1].model).toBe("claude-sonnet-4-6");
        (0, vitest_1.expect)(top[1].pctOfTotal).toBeCloseTo(10 / 30, 5);
    });
});
(0, vitest_1.describe)("computeAvgSessionMinutes", () => {
    (0, vitest_1.it)("returns 0 for empty entries", () => {
        (0, vitest_1.expect)((0, analyticsSummary_1.computeAvgSessionMinutes)([])).toBe(0);
    });
    (0, vitest_1.it)("computes duration from first to last timestamp per session", () => {
        const entries = [
            { provider: "claude", timestamp: "2026-05-01T10:00:00.000Z", model: "claude-sonnet-4-6", project: "p1", session: "s1", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
            { provider: "claude", timestamp: "2026-05-01T10:30:00.000Z", model: "claude-sonnet-4-6", project: "p1", session: "s1", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
            { provider: "claude", timestamp: "2026-05-01T11:00:00.000Z", model: "claude-sonnet-4-6", project: "p1", session: "s1", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        ];
        // Session s1: 10:00 → 11:00 = 60 min
        (0, vitest_1.expect)((0, analyticsSummary_1.computeAvgSessionMinutes)(entries)).toBe(60);
    });
});
(0, vitest_1.describe)("computeCacheHitRate", () => {
    (0, vitest_1.it)("returns 0 when no tokenUsage in snapshots", () => {
        const snaps = [{ provider: "claude", status: "ok", windows: [], updatedAt: "" }];
        const rate = (0, analyticsSummary_1.computeCacheHitRate)(snaps);
        (0, vitest_1.expect)(rate.claude).toBe(0);
    });
    (0, vitest_1.it)("computes cache_read / (cache_read + input) for claude", () => {
        const snaps = [{
                provider: "claude", status: "ok", windows: [], updatedAt: "",
                costFactor: {
                    apiCostUSD: 1, subscriptionCostUSD: 20, factor: 0.05, isEstimate: false, label: "",
                    tokenUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 900, totalTokens: 1050, models: [] },
                },
            }];
        (0, vitest_1.expect)((0, analyticsSummary_1.computeCacheHitRate)(snaps).claude).toBeCloseTo(0.9, 5);
    });
    (0, vitest_1.it)("returns zero rates when snapshots is null", () => {
        (0, vitest_1.expect)((0, analyticsSummary_1.computeCacheHitRate)(null)).toEqual({ claude: 0, codex: 0 });
    });
});

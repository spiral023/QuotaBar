"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const analyticsSummary_1 = require("../src/main/analyticsSummary");
function makeRow(bucket, costUSD, provider, tokens = {}) {
    return {
        bucket, provider, costUSD,
        inputTokens: tokens.inputTokens ?? 0,
        outputTokens: tokens.outputTokens ?? 0,
        cacheCreationTokens: tokens.cacheCreationTokens ?? 0,
        cacheReadTokens: tokens.cacheReadTokens ?? 0,
        totalTokens: 0, models: [], modelBreakdowns: [],
    };
}
function makeEntry(project, session, isoTimestamp) {
    return {
        provider: "claude", timestamp: isoTimestamp, model: "claude-sonnet-4-6",
        project, session,
        inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    };
}
(0, vitest_1.describe)("buildDailyBuckets", () => {
    (0, vitest_1.it)("returns exactly windowDays entries", () => {
        (0, vitest_1.expect)((0, analyticsSummary_1.buildDailyBuckets)([], [], 7)).toHaveLength(7);
        (0, vitest_1.expect)((0, analyticsSummary_1.buildDailyBuckets)([], [], 30)).toHaveLength(30);
    });
    (0, vitest_1.it)("maps claudeUSD and codexUSD from report rows by date", () => {
        const today = new Date().toISOString().slice(0, 10);
        const claudeRows = [makeRow(today, 3.5, "claude")];
        const codexRows = [makeRow(today, 1.2, "codex")];
        const buckets = (0, analyticsSummary_1.buildDailyBuckets)(claudeRows, codexRows, 7);
        const todayBucket = buckets.find(b => b.date === today);
        (0, vitest_1.expect)(todayBucket?.claudeUSD).toBe(3.5);
        (0, vitest_1.expect)(todayBucket?.codexUSD).toBe(1.2);
    });
    (0, vitest_1.it)("fills missing days with 0", () => {
        const buckets = (0, analyticsSummary_1.buildDailyBuckets)([], [], 7);
        (0, vitest_1.expect)(buckets.every(b => b.claudeUSD === 0 && b.codexUSD === 0)).toBe(true);
    });
    (0, vitest_1.it)("sets claudeQuotaPct and codexQuotaPct to null", () => {
        const buckets = (0, analyticsSummary_1.buildDailyBuckets)([], [], 7);
        (0, vitest_1.expect)(buckets[0].claudeQuotaPct).toBeNull();
        (0, vitest_1.expect)(buckets[0].codexQuotaPct).toBeNull();
    });
});
(0, vitest_1.describe)("buildSessionStats", () => {
    (0, vitest_1.it)("returns zeros for empty entries", () => {
        const stats = (0, analyticsSummary_1.buildSessionStats)([], 0);
        (0, vitest_1.expect)(stats.count).toBe(0);
        (0, vitest_1.expect)(stats.avgMinutes).toBe(0);
        (0, vitest_1.expect)(stats.totalHours).toBe(0);
        (0, vitest_1.expect)(stats.sessionsPerActiveDay).toBe(0);
    });
    (0, vitest_1.it)("counts distinct project+session pairs", () => {
        const entries = [
            makeEntry("p1", "s1", "2026-05-01T10:00:00.000Z"),
            makeEntry("p1", "s1", "2026-05-01T10:30:00.000Z"),
            makeEntry("p1", "s2", "2026-05-01T11:00:00.000Z"),
            makeEntry("p2", "s1", "2026-05-01T12:00:00.000Z"),
        ];
        const stats = (0, analyticsSummary_1.buildSessionStats)(entries, 1);
        (0, vitest_1.expect)(stats.count).toBe(3);
    });
    (0, vitest_1.it)("computes avgMinutes from first to last timestamp per session", () => {
        const entries = [
            makeEntry("p1", "s1", "2026-05-01T10:00:00.000Z"),
            makeEntry("p1", "s1", "2026-05-01T11:00:00.000Z"),
        ];
        const stats = (0, analyticsSummary_1.buildSessionStats)(entries, 1);
        (0, vitest_1.expect)(stats.avgMinutes).toBe(60);
    });
    (0, vitest_1.it)("computes sessionsPerActiveDay", () => {
        const entries = [
            makeEntry("p1", "s1", "2026-05-01T10:00:00.000Z"),
            makeEntry("p1", "s2", "2026-05-01T11:00:00.000Z"),
        ];
        const stats = (0, analyticsSummary_1.buildSessionStats)(entries, 2);
        (0, vitest_1.expect)(stats.sessionsPerActiveDay).toBe(1);
    });
});
(0, vitest_1.describe)("buildTotalTokens", () => {
    (0, vitest_1.it)("sums tokens across all claude rows", () => {
        const rows = [
            makeRow("2026-05-01", 1, "claude", { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheCreationTokens: 10 }),
            makeRow("2026-05-02", 2, "claude", { inputTokens: 300, outputTokens: 100 }),
        ];
        const totals = (0, analyticsSummary_1.buildTotalTokens)(rows, []);
        (0, vitest_1.expect)(totals.claude.input).toBe(400);
        (0, vitest_1.expect)(totals.claude.output).toBe(150);
        (0, vitest_1.expect)(totals.claude.cacheRead).toBe(200);
        (0, vitest_1.expect)(totals.claude.cacheCreate).toBe(10);
    });
    (0, vitest_1.it)("sums tokens across all codex rows", () => {
        const rows = [
            makeRow("2026-05-01", 1, "codex", { inputTokens: 500, outputTokens: 200, cacheReadTokens: 50 }),
        ];
        const totals = (0, analyticsSummary_1.buildTotalTokens)([], rows);
        (0, vitest_1.expect)(totals.codex.input).toBe(500);
        (0, vitest_1.expect)(totals.codex.output).toBe(200);
        (0, vitest_1.expect)(totals.codex.cached).toBe(50);
    });
    (0, vitest_1.it)("returns zeros for empty inputs", () => {
        const totals = (0, analyticsSummary_1.buildTotalTokens)([], []);
        (0, vitest_1.expect)(totals.claude.input).toBe(0);
        (0, vitest_1.expect)(totals.codex.output).toBe(0);
    });
});

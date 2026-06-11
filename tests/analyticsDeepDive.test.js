"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const analyticsSummary_1 = require("../src/main/analyticsSummary");
function makeEntry(isoTimestamp, out = 0) {
    return {
        provider: "claude", timestamp: isoTimestamp, model: "claude-sonnet-4-6",
        project: "p1", session: "s1",
        inputTokens: 0, outputTokens: out, cacheCreationTokens: 0, cacheReadTokens: 0,
    };
}
function makeRow(bucket, outputTokens) {
    return {
        bucket, provider: "claude", costUSD: 0,
        inputTokens: 0, outputTokens, cacheCreationTokens: 0, cacheReadTokens: 0,
        totalTokens: outputTokens, models: [], modelBreakdowns: [],
    };
}
(0, vitest_1.describe)("buildHourHeatmap", () => {
    (0, vitest_1.it)("returns exactly 24 entries for hours 0–23", () => {
        const result = (0, analyticsSummary_1.buildHourHeatmap)([]);
        (0, vitest_1.expect)(result).toHaveLength(24);
        (0, vitest_1.expect)(result.map(b => b.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
    });
    (0, vitest_1.it)("counts entries by UTC hour", () => {
        const entries = [
            makeEntry("2026-05-01T14:30:00.000Z"),
            makeEntry("2026-05-01T14:59:00.000Z"),
            makeEntry("2026-05-01T16:00:00.000Z"),
        ];
        const result = (0, analyticsSummary_1.buildHourHeatmap)(entries);
        (0, vitest_1.expect)(result[14].count).toBe(2);
        (0, vitest_1.expect)(result[16].count).toBe(1);
        (0, vitest_1.expect)(result[0].count).toBe(0);
    });
    (0, vitest_1.it)("sets pct=1 for peak hour, pct=0 for empty hours", () => {
        const entries = [
            makeEntry("2026-05-01T14:00:00.000Z"),
            makeEntry("2026-05-01T14:00:00.000Z"),
            makeEntry("2026-05-01T16:00:00.000Z"),
        ];
        const result = (0, analyticsSummary_1.buildHourHeatmap)(entries);
        (0, vitest_1.expect)(result[14].pct).toBe(1);
        (0, vitest_1.expect)(result[16].pct).toBe(0.5);
        (0, vitest_1.expect)(result[0].pct).toBe(0);
    });
    (0, vitest_1.it)("returns all pct=0 for empty input", () => {
        (0, vitest_1.expect)((0, analyticsSummary_1.buildHourHeatmap)([]).every(b => b.pct === 0 && b.count === 0)).toBe(true);
    });
});
(0, vitest_1.describe)("buildWeekdayDistribution", () => {
    (0, vitest_1.it)("returns exactly 7 entries for days 0–6", () => {
        const result = (0, analyticsSummary_1.buildWeekdayDistribution)([]);
        (0, vitest_1.expect)(result).toHaveLength(7);
        (0, vitest_1.expect)(result.map(b => b.day)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });
    (0, vitest_1.it)("counts entries by UTC weekday (0=Sunday)", () => {
        // 2026-05-04 is a Monday (UTC day 1)
        // 2026-05-10 is a Sunday (UTC day 0)
        const entries = [
            makeEntry("2026-05-04T12:00:00.000Z"), // Monday
            makeEntry("2026-05-04T18:00:00.000Z"), // Monday
            makeEntry("2026-05-10T10:00:00.000Z"), // Sunday
        ];
        const result = (0, analyticsSummary_1.buildWeekdayDistribution)(entries);
        (0, vitest_1.expect)(result[1].count).toBe(2); // Monday
        (0, vitest_1.expect)(result[0].count).toBe(1); // Sunday
        (0, vitest_1.expect)(result[2].count).toBe(0); // Tuesday
    });
    (0, vitest_1.it)("computes pct as share of total entries", () => {
        const entries = [
            makeEntry("2026-05-04T12:00:00.000Z"), // Monday
            makeEntry("2026-05-04T18:00:00.000Z"), // Monday
        ];
        const result = (0, analyticsSummary_1.buildWeekdayDistribution)(entries);
        (0, vitest_1.expect)(result[1].pct).toBeCloseTo(1.0);
        (0, vitest_1.expect)(result[0].pct).toBe(0);
    });
    (0, vitest_1.it)("labels are German day names starting with Sonntag", () => {
        const result = (0, analyticsSummary_1.buildWeekdayDistribution)([]);
        (0, vitest_1.expect)(result[0].label).toBe("Sonntag");
        (0, vitest_1.expect)(result[1].label).toBe("Montag");
        (0, vitest_1.expect)(result[6].label).toBe("Samstag");
    });
});
(0, vitest_1.describe)("buildTopActiveDays", () => {
    (0, vitest_1.it)("returns at most limit entries", () => {
        const entries = [
            makeEntry("2026-05-01T10:00:00.000Z"),
            makeEntry("2026-05-02T10:00:00.000Z"),
            makeEntry("2026-05-03T10:00:00.000Z"),
        ];
        (0, vitest_1.expect)((0, analyticsSummary_1.buildTopActiveDays)(entries, [], 2)).toHaveLength(2);
    });
    (0, vitest_1.it)("sorts by count descending", () => {
        const entries = [
            makeEntry("2026-05-01T10:00:00.000Z"),
            makeEntry("2026-05-02T10:00:00.000Z"),
            makeEntry("2026-05-02T11:00:00.000Z"),
        ];
        const result = (0, analyticsSummary_1.buildTopActiveDays)(entries, [], 3);
        (0, vitest_1.expect)(result[0].date).toBe("2026-05-02");
        (0, vitest_1.expect)(result[0].count).toBe(2);
        (0, vitest_1.expect)(result[1].date).toBe("2026-05-01");
    });
    (0, vitest_1.it)("picks outputTokens from claudeRows by date", () => {
        const entries = [makeEntry("2026-05-01T10:00:00.000Z")];
        const rows = [makeRow("2026-05-01", 500)];
        const result = (0, analyticsSummary_1.buildTopActiveDays)(entries, rows, 5);
        (0, vitest_1.expect)(result[0].outputTokens).toBe(500);
    });
    (0, vitest_1.it)("returns 0 outputTokens if no matching row", () => {
        const entries = [makeEntry("2026-05-01T10:00:00.000Z")];
        const result = (0, analyticsSummary_1.buildTopActiveDays)(entries, [], 5);
        (0, vitest_1.expect)(result[0].outputTokens).toBe(0);
    });
    (0, vitest_1.it)("returns entries in stable order when counts tie", () => {
        const entries = [
            makeEntry("2026-05-01T10:00:00.000Z"),
            makeEntry("2026-05-02T10:00:00.000Z"),
        ];
        const result = (0, analyticsSummary_1.buildTopActiveDays)(entries, [], 5);
        (0, vitest_1.expect)(result).toHaveLength(2);
        (0, vitest_1.expect)(result[0].count).toBe(1);
        (0, vitest_1.expect)(result[1].count).toBe(1);
    });
});
function makeEntryFull(isoTimestamp, outputTokens, inputTokens = 0) {
    return {
        provider: "claude", timestamp: isoTimestamp, model: "claude-sonnet-4-6",
        project: "p1", session: "s1",
        inputTokens, outputTokens, cacheCreationTokens: 0, cacheReadTokens: 0,
    };
}
(0, vitest_1.describe)("buildFiveHourPeak", () => {
    (0, vitest_1.it)("returns zeros and null for empty input", () => {
        const r = (0, analyticsSummary_1.buildFiveHourPeak)([]);
        (0, vitest_1.expect)(r.maxOutputTokens).toBe(0);
        (0, vitest_1.expect)(r.maxTotalTokens).toBe(0);
        (0, vitest_1.expect)(r.peakWindowStart).toBeNull();
    });
    (0, vitest_1.it)("returns single entry as its own peak", () => {
        const r = (0, analyticsSummary_1.buildFiveHourPeak)([makeEntryFull("2026-05-01T10:00:00.000Z", 1000, 500)]);
        (0, vitest_1.expect)(r.maxOutputTokens).toBe(1000);
        (0, vitest_1.expect)(r.maxTotalTokens).toBe(1500);
        (0, vitest_1.expect)(r.peakWindowStart).toBe("2026-05-01T10:00:00.000Z");
    });
    (0, vitest_1.it)("sums entries within 5h window", () => {
        const entries = [
            makeEntryFull("2026-05-01T10:00:00.000Z", 300),
            makeEntryFull("2026-05-01T12:00:00.000Z", 400),
            makeEntryFull("2026-05-01T14:59:00.000Z", 200), // 4h59m after first → within 5h
        ];
        const r = (0, analyticsSummary_1.buildFiveHourPeak)(entries);
        (0, vitest_1.expect)(r.maxOutputTokens).toBe(900);
    });
    (0, vitest_1.it)("excludes entries outside the 5h window", () => {
        const entries = [
            makeEntryFull("2026-05-01T10:00:00.000Z", 300),
            makeEntryFull("2026-05-01T15:01:00.000Z", 1000), // 5h01m later → separate window
        ];
        const r = (0, analyticsSummary_1.buildFiveHourPeak)(entries);
        (0, vitest_1.expect)(r.maxOutputTokens).toBe(1000); // second window wins
    });
    (0, vitest_1.it)("peakWindowStart is the first entry of the best window", () => {
        const entries = [
            makeEntryFull("2026-05-01T08:00:00.000Z", 100),
            makeEntryFull("2026-05-01T10:00:00.000Z", 500),
            makeEntryFull("2026-05-01T11:00:00.000Z", 500),
        ];
        const r = (0, analyticsSummary_1.buildFiveHourPeak)(entries);
        // All three entries are within 5h of each other (11:00 - 08:00 = 3h),
        // so the window starting at 08:00 (sum=1100) beats the one starting at 10:00 (sum=1000).
        (0, vitest_1.expect)(r.peakWindowStart).toBe("2026-05-01T08:00:00.000Z");
    });
});
function makeCodexEvent(isoTimestamp) {
    return {
        timestamp: isoTimestamp, model: "gpt-5.5", isFallback: false,
        session: "s1", directory: "/home",
        inputTokens: 100, cachedInputTokens: 0, outputTokens: 50,
        reasoningOutputTokens: 0, totalTokens: 150,
    };
}
(0, vitest_1.describe)("buildWeeklySummary", () => {
    (0, vitest_1.it)("groups daily rows by Monday-start week", () => {
        // 2026-05-04 = Monday, 2026-05-05 = Tuesday (same week)
        // 2026-05-11 = Monday (next week)
        const rows = [
            makeRow("2026-05-04", 0),
            makeRow("2026-05-05", 0),
            makeRow("2026-05-11", 0),
        ];
        const result = (0, analyticsSummary_1.buildWeeklySummary)(rows, [], [], []);
        (0, vitest_1.expect)(result).toHaveLength(2);
        (0, vitest_1.expect)(result[0].weekStart).toBe("2026-05-04");
        (0, vitest_1.expect)(result[1].weekStart).toBe("2026-05-11");
    });
    (0, vitest_1.it)("sums claudeTokens and claudeCostUSD from rows", () => {
        const rows = [
            { ...makeRow("2026-05-04", 200), totalTokens: 500, costUSD: 3.5 },
            { ...makeRow("2026-05-05", 100), totalTokens: 300, costUSD: 1.5 },
        ];
        const result = (0, analyticsSummary_1.buildWeeklySummary)(rows, [], [], []);
        (0, vitest_1.expect)(result[0].claudeTokens).toBe(800);
        (0, vitest_1.expect)(result[0].claudeCostUSD).toBeCloseTo(5.0);
    });
    (0, vitest_1.it)("counts claudeMessages from entries", () => {
        const entries = [
            makeEntry("2026-05-04T10:00:00.000Z"),
            makeEntry("2026-05-04T11:00:00.000Z"),
            makeEntry("2026-05-11T10:00:00.000Z"),
        ];
        const result = (0, analyticsSummary_1.buildWeeklySummary)([], [], entries, []);
        const week1 = result.find(w => w.weekStart === "2026-05-04");
        (0, vitest_1.expect)(week1?.claudeMessages).toBe(2);
    });
    (0, vitest_1.it)("counts codexEvents from codex events", () => {
        const events = [
            makeCodexEvent("2026-05-04T10:00:00.000Z"),
            makeCodexEvent("2026-05-04T12:00:00.000Z"),
        ];
        const result = (0, analyticsSummary_1.buildWeeklySummary)([], [], [], events);
        (0, vitest_1.expect)(result[0].codexEvents).toBe(2);
    });
    (0, vitest_1.it)("sums codexTokens from codexRows", () => {
        const rows = [
            { ...makeRow("2026-05-04", 0), totalTokens: 400 },
        ];
        const result = (0, analyticsSummary_1.buildWeeklySummary)([], rows, [], []);
        (0, vitest_1.expect)(result[0].codexTokens).toBe(400);
    });
    (0, vitest_1.it)("returns weeks sorted oldest first", () => {
        const rows = [makeRow("2026-05-11", 0), makeRow("2026-05-04", 0)];
        const result = (0, analyticsSummary_1.buildWeeklySummary)(rows, [], [], []);
        (0, vitest_1.expect)(result[0].weekStart < result[1].weekStart).toBe(true);
    });
});
(0, vitest_1.describe)("buildCostEfficiency", () => {
    (0, vitest_1.it)("computes costPer1kOutputTokens", () => {
        const r = (0, analyticsSummary_1.buildCostEfficiency)(10, 100_000, 5);
        (0, vitest_1.expect)(r.costPer1kOutputTokens).toBeCloseTo(0.1);
    });
    (0, vitest_1.it)("returns 0 costPer1kOutputTokens when outputTokens=0", () => {
        (0, vitest_1.expect)((0, analyticsSummary_1.buildCostEfficiency)(10, 0, 5).costPer1kOutputTokens).toBe(0);
    });
    (0, vitest_1.it)("computes costPerActiveHour", () => {
        const r = (0, analyticsSummary_1.buildCostEfficiency)(50, 1_000_000, 10);
        (0, vitest_1.expect)(r.costPerActiveHour).toBeCloseTo(5);
    });
    (0, vitest_1.it)("returns 0 costPerActiveHour when totalHours=0", () => {
        (0, vitest_1.expect)((0, analyticsSummary_1.buildCostEfficiency)(10, 100_000, 0).costPerActiveHour).toBe(0);
    });
    (0, vitest_1.it)("returns exactly 3 ROI tier entries", () => {
        (0, vitest_1.expect)((0, analyticsSummary_1.buildCostEfficiency)(200, 1_000_000, 10).roiByTier).toHaveLength(3);
    });
    (0, vitest_1.it)("computes ROI correctly for Pro tier", () => {
        const r = (0, analyticsSummary_1.buildCostEfficiency)(200, 1_000_000, 10);
        const pro = r.roiByTier.find(t => t.tier === "Claude Pro");
        (0, vitest_1.expect)(pro.price).toBe(20);
        (0, vitest_1.expect)(pro.roi).toBeCloseTo(10);
    });
    (0, vitest_1.it)("computes subCostPerActiveHour from prorated subscription", () => {
        // $20/mo sub, prorated to 7 days = $20*7/30 ≈ $4.67; 10 active hours → ≈$0.467/h
        const r = (0, analyticsSummary_1.buildCostEfficiency)(50, 1_000_000, 10, 20 * 7 / 30);
        (0, vitest_1.expect)(r.subCostPerActiveHour).toBeCloseTo(20 * 7 / 30 / 10);
    });
    (0, vitest_1.it)("returns 0 subCostPerActiveHour when activeHours=0", () => {
        (0, vitest_1.expect)((0, analyticsSummary_1.buildCostEfficiency)(10, 100_000, 0, 5).subCostPerActiveHour).toBe(0);
    });
    (0, vitest_1.it)("returns 0 subCostPerActiveHour when no subscription configured", () => {
        (0, vitest_1.expect)((0, analyticsSummary_1.buildCostEfficiency)(10, 100_000, 5, 0).subCostPerActiveHour).toBe(0);
    });
    (0, vitest_1.it)("backward-compatible: subCostPerActiveHour=0 when 4th arg omitted", () => {
        (0, vitest_1.expect)((0, analyticsSummary_1.buildCostEfficiency)(10, 100_000, 5).subCostPerActiveHour).toBe(0);
    });
});
function makeSessionEntry(isoTimestamp, session, project = "p1") {
    return { ...makeEntry(isoTimestamp), session, project };
}
(0, vitest_1.describe)("computeActiveHours", () => {
    (0, vitest_1.it)("returns 0 for empty entries", () => {
        (0, vitest_1.expect)((0, analyticsSummary_1.computeActiveHours)([])).toBe(0);
    });
    (0, vitest_1.it)("sums continuous activity within one block", () => {
        const entries = [
            makeEntry("2026-05-01T10:00:00.000Z"),
            makeEntry("2026-05-01T10:10:00.000Z"),
            makeEntry("2026-05-01T10:20:00.000Z"),
        ];
        (0, vitest_1.expect)((0, analyticsSummary_1.computeActiveHours)(entries)).toBeCloseTo(20 / 60);
    });
    (0, vitest_1.it)("excludes idle gaps longer than 30 minutes", () => {
        const entries = [
            makeEntry("2026-05-01T10:00:00.000Z"),
            makeEntry("2026-05-01T10:10:00.000Z"),
            // 3h idle — same session, but should not count as work time
            makeEntry("2026-05-01T13:10:00.000Z"),
            makeEntry("2026-05-01T13:20:00.000Z"),
        ];
        (0, vitest_1.expect)((0, analyticsSummary_1.computeActiveHours)(entries)).toBeCloseTo(20 / 60);
    });
    (0, vitest_1.it)("does not double-count overlapping parallel sessions", () => {
        const entries = [
            makeSessionEntry("2026-05-01T10:00:00.000Z", "s1"),
            makeSessionEntry("2026-05-01T10:30:00.000Z", "s1"),
            makeSessionEntry("2026-05-01T11:00:00.000Z", "s1"),
            makeSessionEntry("2026-05-01T10:00:00.000Z", "s2", "p2"),
            makeSessionEntry("2026-05-01T10:30:00.000Z", "s2", "p2"),
            makeSessionEntry("2026-05-01T11:00:00.000Z", "s2", "p2"),
        ];
        (0, vitest_1.expect)((0, analyticsSummary_1.computeActiveHours)(entries)).toBeCloseTo(1);
    });
    (0, vitest_1.it)("credits a minimum of 1 minute per activity block", () => {
        const entries = [makeEntry("2026-05-01T10:00:00.000Z")];
        (0, vitest_1.expect)((0, analyticsSummary_1.computeActiveHours)(entries)).toBeCloseTo(1 / 60);
    });
    (0, vitest_1.it)("handles unsorted input", () => {
        const entries = [
            makeEntry("2026-05-01T10:20:00.000Z"),
            makeEntry("2026-05-01T10:00:00.000Z"),
            makeEntry("2026-05-01T10:10:00.000Z"),
        ];
        (0, vitest_1.expect)((0, analyticsSummary_1.computeActiveHours)(entries)).toBeCloseTo(20 / 60);
    });
    (0, vitest_1.it)("returns unrounded hours suitable for division", () => {
        const entries = [
            makeEntry("2026-05-01T10:00:00.000Z"),
            makeEntry("2026-05-01T10:03:00.000Z"),
        ];
        // 3 minutes = 0.05h — must not collapse to 0 through rounding
        (0, vitest_1.expect)((0, analyticsSummary_1.computeActiveHours)(entries)).toBeCloseTo(0.05);
    });
});

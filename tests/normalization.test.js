"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const codex_1 = require("../src/providers/codex");
const claude_1 = require("../src/providers/claude");
(0, vitest_1.describe)("provider snapshot normalization", () => {
    (0, vitest_1.it)("normalizes Codex primary and weekly windows", () => {
        const snapshot = (0, codex_1.normalizeCodexUsageResponse)({
            plan_type: "plus",
            rate_limit: {
                primary_window: { used_percent: 67, limit_window_seconds: 18000, reset_at: 1770000000 },
                secondary_window: { used_percent: 31, limit_window_seconds: 604800 }
            }
        }, { accountId: "acct_1" });
        (0, vitest_1.expect)(snapshot.provider).toBe("codex");
        (0, vitest_1.expect)(snapshot.status).toBe("ok");
        (0, vitest_1.expect)(snapshot.planType).toBe("plus");
        (0, vitest_1.expect)(snapshot.identity?.accountId).toBe("acct_1");
        (0, vitest_1.expect)(snapshot.windows[0]).toMatchObject({ name: "fiveHour", usedPercent: 67, windowSeconds: 18000 });
        (0, vitest_1.expect)(snapshot.windows[1]).toMatchObject({ name: "weekly", usedPercent: 31, windowSeconds: 604800 });
    });
    (0, vitest_1.it)("normalizes Claude five-hour and weekly windows", () => {
        const snapshot = (0, claude_1.normalizeClaudeUsageResponse)({
            fiveHour: { utilization: 0.42, resetsAt: "2026-05-18T12:15:00.000Z" },
            sevenDay: { utilization: 18 }
        }, { rateLimitTier: "Max" });
        (0, vitest_1.expect)(snapshot.provider).toBe("claude");
        (0, vitest_1.expect)(snapshot.status).toBe("ok");
        (0, vitest_1.expect)(snapshot.planType).toBe("Max");
        (0, vitest_1.expect)(snapshot.windows[0]).toMatchObject({ name: "fiveHour", usedPercent: 42 });
        (0, vitest_1.expect)(snapshot.windows[1]).toMatchObject({ name: "weekly", usedPercent: 18 });
    });
    (0, vitest_1.it)("normalizes current Claude Code OAuth snake_case windows", () => {
        const snapshot = (0, claude_1.normalizeClaudeUsageResponse)({
            five_hour: { utilization: 0.25, resets_at: null },
            seven_day: { utilization: 0.5, resets_at: "2026-05-19T11:00:01.185904+00:00" },
            extra_usage: { used_credits: 10, monthly_limit: 40 }
        }, { rateLimitTier: "default_raven" });
        (0, vitest_1.expect)(snapshot.windows[0]).toMatchObject({ name: "fiveHour", usedPercent: 25 });
        (0, vitest_1.expect)(snapshot.windows[1]).toMatchObject({
            name: "weekly",
            usedPercent: 50,
            resetsAt: "2026-05-19T11:00:01.185904+00:00"
        });
        (0, vitest_1.expect)(snapshot.windows[2]).toMatchObject({ name: "credits", usedPercent: 25 });
    });
});

import { describe, expect, it } from "vitest";
import { normalizeCodexUsageResponse } from "../src/providers/codex";
import { normalizeClaudeUsageResponse } from "../src/providers/claude";

describe("provider snapshot normalization", () => {
  it("normalizes Codex primary and weekly windows", () => {
    const snapshot = normalizeCodexUsageResponse({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 67, limit_window_seconds: 18000, reset_at: 1770000000 },
        secondary_window: { used_percent: 31, limit_window_seconds: 604800 }
      }
    }, { accountId: "acct_1" });

    expect(snapshot.provider).toBe("codex");
    expect(snapshot.status).toBe("ok");
    expect(snapshot.planType).toBe("plus");
    expect(snapshot.identity?.accountId).toBe("acct_1");
    expect(snapshot.windows[0]).toMatchObject({ name: "fiveHour", usedPercent: 67, windowSeconds: 18000 });
    expect(snapshot.windows[1]).toMatchObject({ name: "weekly", usedPercent: 31, windowSeconds: 604800 });
  });

  it("normalizes Claude five-hour and weekly windows", () => {
    const snapshot = normalizeClaudeUsageResponse({
      fiveHour: { utilization: 0.42, resetsAt: "2026-05-18T12:15:00.000Z" },
      sevenDay: { utilization: 18 }
    }, { rateLimitTier: "Max" });

    expect(snapshot.provider).toBe("claude");
    expect(snapshot.status).toBe("ok");
    expect(snapshot.planType).toBe("Max");
    expect(snapshot.windows[0]).toMatchObject({ name: "fiveHour", usedPercent: 42 });
    expect(snapshot.windows[1]).toMatchObject({ name: "weekly", usedPercent: 18 });
  });

  it("normalizes current Claude Code OAuth snake_case windows", () => {
    const snapshot = normalizeClaudeUsageResponse({
      five_hour: { utilization: 0.25, resets_at: null },
      seven_day: { utilization: 0.5, resets_at: "2026-05-19T11:00:01.185904+00:00" },
      extra_usage: { used_credits: 10, monthly_limit: 40 }
    }, { rateLimitTier: "default_raven" });

    expect(snapshot.windows[0]).toMatchObject({ name: "fiveHour", usedPercent: 25 });
    expect(snapshot.windows[1]).toMatchObject({
      name: "weekly",
      usedPercent: 50,
      resetsAt: "2026-05-19T11:00:01.185904+00:00"
    });
    expect(snapshot.windows[2]).toMatchObject({ name: "credits", usedPercent: 25 });
  });
});

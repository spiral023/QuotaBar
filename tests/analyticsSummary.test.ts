import { describe, it, expect } from "vitest";
import type { ReportRow } from "../src/reports/types";
import {
  computeActiveDays,
  buildSparkline7d,
  buildTopModels,
  computeAvgSessionMinutes,
  computeCacheHitRate,
} from "../src/main/analyticsSummary";
import type { ClaudeUsageEntry } from "../src/pricing/jsonl-reader";
import type { UsageSnapshot } from "../src/providers/types";

function makeRow(bucket: string, costUSD: number, provider: "claude" | "codex", models: string[] = []): ReportRow {
  return {
    bucket, provider, costUSD,
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    totalTokens: 0, models,
    modelBreakdowns: models.map(model => ({ model, costUSD, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 })),
  };
}

describe("computeActiveDays", () => {
  it("counts union of dates from claude and codex rows", () => {
    const claude = [makeRow("2026-05-01", 1, "claude"), makeRow("2026-05-02", 1, "claude")];
    const codex  = [makeRow("2026-05-02", 1, "codex"),  makeRow("2026-05-03", 1, "codex")];
    expect(computeActiveDays(claude, codex)).toBe(3);
  });

  it("returns 0 for empty input", () => {
    expect(computeActiveDays([], [])).toBe(0);
  });
});

describe("buildSparkline7d", () => {
  it("returns 7 entries", () => {
    expect(buildSparkline7d([], [])).toHaveLength(7);
  });

  it("fills claudeUSD from matching rows", () => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = [makeRow(today, 5.5, "claude")];
    const sparkline = buildSparkline7d(rows, []);
    const todayEntry = sparkline.find(s => s.date === today);
    expect(todayEntry?.claudeUSD).toBe(5.5);
  });
});

describe("buildTopModels", () => {
  it("aggregates model costs across providers, sorted descending", () => {
    const claude = [makeRow("2026-05-01", 10, "claude", ["claude-sonnet-4-6"])];
    const codex  = [makeRow("2026-05-01", 20, "codex",  ["gpt-5.5"])];
    const top = buildTopModels(claude, codex, 5);
    expect(top[0].model).toBe("gpt-5.5");
    expect(top[0].costUSD).toBe(20);
    expect(top[1].model).toBe("claude-sonnet-4-6");
    expect(top[1].pctOfTotal).toBeCloseTo(10 / 30, 5);
  });
});

describe("computeAvgSessionMinutes", () => {
  it("returns 0 for empty entries", () => {
    expect(computeAvgSessionMinutes([])).toBe(0);
  });

  it("computes duration from first to last timestamp per session", () => {
    const entries: ClaudeUsageEntry[] = [
      { provider: "claude", timestamp: "2026-05-01T10:00:00.000Z", model: "claude-sonnet-4-6", project: "p1", session: "s1", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      { provider: "claude", timestamp: "2026-05-01T10:30:00.000Z", model: "claude-sonnet-4-6", project: "p1", session: "s1", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      { provider: "claude", timestamp: "2026-05-01T11:00:00.000Z", model: "claude-sonnet-4-6", project: "p1", session: "s1", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    ];
    // Session s1: 10:00 → 11:00 = 60 min
    expect(computeAvgSessionMinutes(entries)).toBe(60);
  });
});

describe("computeCacheHitRate", () => {
  it("returns 0 when no tokenUsage in snapshots", () => {
    const snaps: UsageSnapshot[] = [{ provider: "claude", status: "ok", windows: [], updatedAt: "" }];
    const rate = computeCacheHitRate(snaps);
    expect(rate.claude).toBe(0);
  });

  it("computes cache_read / (cache_read + input) for claude", () => {
    const snaps: UsageSnapshot[] = [{
      provider: "claude", status: "ok", windows: [], updatedAt: "",
      costFactor: {
        apiCostUSD: 1, subscriptionCostUSD: 20, factor: 0.05, isEstimate: false, label: "",
        tokenUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 900, totalTokens: 1050, models: [] },
      },
    }];
    expect(computeCacheHitRate(snaps).claude).toBeCloseTo(0.9, 5);
  });

  it("returns zero rates when snapshots is null", () => {
    expect(computeCacheHitRate(null)).toEqual({ claude: 0, codex: 0 });
  });
});

import { describe, it, expect } from "vitest";
import type { ReportRow } from "../src/reports/types";
import type { ClaudeUsageEntry } from "../src/pricing/jsonl-reader";
import {
  buildDailyBuckets,
  buildSessionStats,
  buildTotalTokens,
} from "../src/main/analyticsSummary";

function makeRow(
  bucket: string,
  costUSD: number,
  provider: "claude" | "codex",
  tokens: Partial<Pick<ReportRow, "inputTokens"|"outputTokens"|"cacheReadTokens"|"cacheCreationTokens">> = {}
): ReportRow {
  return {
    bucket, provider, costUSD,
    inputTokens: tokens.inputTokens ?? 0,
    outputTokens: tokens.outputTokens ?? 0,
    cacheCreationTokens: tokens.cacheCreationTokens ?? 0,
    cacheReadTokens: tokens.cacheReadTokens ?? 0,
    totalTokens: 0, models: [], modelBreakdowns: [],
  };
}

function makeEntry(project: string, session: string, isoTimestamp: string): ClaudeUsageEntry {
  return {
    provider: "claude", timestamp: isoTimestamp, model: "claude-sonnet-4-6",
    project, session,
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
  };
}

describe("buildDailyBuckets", () => {
  it("returns exactly windowDays entries", () => {
    expect(buildDailyBuckets([], [], 7)).toHaveLength(7);
    expect(buildDailyBuckets([], [], 30)).toHaveLength(30);
  });

  it("maps claudeUSD and codexUSD from report rows by date", () => {
    const today = new Date().toISOString().slice(0, 10);
    const claudeRows = [makeRow(today, 3.5, "claude")];
    const codexRows  = [makeRow(today, 1.2, "codex")];
    const buckets = buildDailyBuckets(claudeRows, codexRows, 7);
    const todayBucket = buckets.find(b => b.date === today);
    expect(todayBucket?.claudeUSD).toBe(3.5);
    expect(todayBucket?.codexUSD).toBe(1.2);
  });

  it("fills missing days with 0", () => {
    const buckets = buildDailyBuckets([], [], 7);
    expect(buckets.every(b => b.claudeUSD === 0 && b.codexUSD === 0)).toBe(true);
  });

  it("sets claudeQuotaPct and codexQuotaPct to null", () => {
    const buckets = buildDailyBuckets([], [], 7);
    expect(buckets[0].claudeQuotaPct).toBeNull();
    expect(buckets[0].codexQuotaPct).toBeNull();
  });
});

describe("buildSessionStats", () => {
  it("returns zeros for empty entries", () => {
    const stats = buildSessionStats([], 0);
    expect(stats.count).toBe(0);
    expect(stats.avgMinutes).toBe(0);
    expect(stats.totalHours).toBe(0);
    expect(stats.sessionsPerActiveDay).toBe(0);
  });

  it("counts distinct project+session pairs", () => {
    const entries = [
      makeEntry("p1", "s1", "2026-05-01T10:00:00.000Z"),
      makeEntry("p1", "s1", "2026-05-01T10:30:00.000Z"),
      makeEntry("p1", "s2", "2026-05-01T11:00:00.000Z"),
      makeEntry("p2", "s1", "2026-05-01T12:00:00.000Z"),
    ];
    const stats = buildSessionStats(entries, 1);
    expect(stats.count).toBe(3);
  });

  it("computes avgMinutes from first to last timestamp per session", () => {
    const entries = [
      makeEntry("p1", "s1", "2026-05-01T10:00:00.000Z"),
      makeEntry("p1", "s1", "2026-05-01T11:00:00.000Z"),
    ];
    const stats = buildSessionStats(entries, 1);
    expect(stats.avgMinutes).toBe(60);
  });

  it("computes sessionsPerActiveDay", () => {
    const entries = [
      makeEntry("p1", "s1", "2026-05-01T10:00:00.000Z"),
      makeEntry("p1", "s2", "2026-05-01T11:00:00.000Z"),
    ];
    const stats = buildSessionStats(entries, 2);
    expect(stats.sessionsPerActiveDay).toBe(1);
  });
});

describe("buildTotalTokens", () => {
  it("sums tokens across all claude rows", () => {
    const rows = [
      makeRow("2026-05-01", 1, "claude", { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheCreationTokens: 10 }),
      makeRow("2026-05-02", 2, "claude", { inputTokens: 300, outputTokens: 100 }),
    ];
    const totals = buildTotalTokens(rows, []);
    expect(totals.claude.input).toBe(400);
    expect(totals.claude.output).toBe(150);
    expect(totals.claude.cacheRead).toBe(200);
    expect(totals.claude.cacheCreate).toBe(10);
  });

  it("sums tokens across all codex rows", () => {
    const rows = [
      makeRow("2026-05-01", 1, "codex", { inputTokens: 500, outputTokens: 200, cacheReadTokens: 50 }),
    ];
    const totals = buildTotalTokens([], rows);
    expect(totals.codex.input).toBe(500);
    expect(totals.codex.output).toBe(200);
    expect(totals.codex.cached).toBe(50);
  });

  it("returns zeros for empty inputs", () => {
    const totals = buildTotalTokens([], []);
    expect(totals.claude.input).toBe(0);
    expect(totals.codex.output).toBe(0);
  });
});

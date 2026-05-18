import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultSettings } from "../src/config/settings";
import { generateUsageReport } from "../src/reports/reportService";

const tmpRoot = path.join(os.tmpdir(), `quotabar-reports-${process.pid}`);

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function writeJsonl(filePath: string, entries: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

describe("usage reports", () => {
  it("aggregates Claude daily rows with project instances and costUSD in auto mode", async () => {
    const claudeRoot = path.join(tmpRoot, "claude", "projects");
    await writeJsonl(path.join(claudeRoot, "proj-a", "session-a.jsonl"), [
      {
        timestamp: "2026-05-18T23:30:00.000Z",
        costUSD: 1.25,
        sessionId: "s-a",
        message: { id: "m1", model: "claude-haiku-4-5", usage: { input_tokens: 100, output_tokens: 200 } },
      },
    ]);
    await writeJsonl(path.join(claudeRoot, "proj-b", "session-b.jsonl"), [
      {
        timestamp: "2026-05-19T00:30:00.000Z",
        costUSD: 2.5,
        sessionId: "s-b",
        message: { id: "m2", model: "claude-sonnet-4-5", usage: { input_tokens: 300, output_tokens: 400 } },
      },
    ]);

    const report = await generateUsageReport({
      provider: "claude",
      type: "daily",
      since: "2026-05-18",
      until: "2026-05-19",
      timezone: "UTC",
      instances: true,
      costMode: "auto",
      order: "asc",
      breakdown: true,
    }, {
      settings: { ...defaultSettings, pricingOfflineMode: true },
      claudeProjectsDirs: [claudeRoot],
      codexSessionsDirs: [],
      codexConfigPaths: [],
    });

    expect(report.rows.map((row) => [row.bucket, row.provider, row.project, row.costUSD])).toEqual([
      ["2026-05-18", "claude", "proj-a", 1.25],
      ["2026-05-19", "claude", "proj-b", 2.5],
    ]);
    expect(report.totals.costUSD).toBeCloseTo(3.75, 6);
    expect(report.rows[0].modelBreakdowns).toHaveLength(1);
  });

  it("groups Claude weekly rows using Monday as the default week start", async () => {
    const claudeRoot = path.join(tmpRoot, "claude-weekly", "projects");
    await writeJsonl(path.join(claudeRoot, "proj", "session.jsonl"), [
      {
        timestamp: "2026-05-24T12:00:00.000Z",
        costUSD: 1,
        message: { id: "m1", model: "claude-haiku-4-5", usage: { output_tokens: 100 } },
      },
      {
        timestamp: "2026-05-25T12:00:00.000Z",
        costUSD: 2,
        message: { id: "m2", model: "claude-haiku-4-5", usage: { output_tokens: 100 } },
      },
    ]);

    const report = await generateUsageReport({
      provider: "claude",
      type: "weekly",
      timezone: "UTC",
      costMode: "auto",
      order: "asc",
    }, {
      settings: { ...defaultSettings, pricingOfflineMode: true },
      claudeProjectsDirs: [claudeRoot],
      codexSessionsDirs: [],
      codexConfigPaths: [],
    });

    expect(report.rows.map((row) => [row.bucket, row.costUSD])).toEqual([
      ["2026-W21", 1],
      ["2026-W22", 2],
    ]);
  });

  it("aggregates Codex session rows and includes fallback flags", async () => {
    const sessions = path.join(tmpRoot, "codex", "sessions");
    await writeJsonl(path.join(sessions, "2026", "05", "18", "session-abc12345.jsonl"), [
      { timestamp: "2026-05-18T10:00:00.000Z", type: "turn_context", payload: { model: "gpt-4o" } },
      {
        timestamp: "2026-05-18T10:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 1000, cached_input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 1050 },
          },
        },
      },
    ]);

    const report = await generateUsageReport({
      provider: "codex",
      type: "session",
      timezone: "UTC",
      codexSpeed: "standard",
      order: "asc",
    }, {
      settings: { ...defaultSettings, pricingOfflineMode: true },
      claudeProjectsDirs: [],
      codexSessionsDirs: [sessions],
      codexConfigPaths: [],
    });

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      provider: "codex",
      session: "session-abc12345",
      inputTokens: 1000,
      cacheReadTokens: 100,
      outputTokens: 50,
      totalTokens: 1050,
      isFallback: false,
    });
    expect(report.totals.costUSD).toBeGreaterThan(0);
  });

  it("filters reports by project and date range", async () => {
    const claudeRoot = path.join(tmpRoot, "claude-filter", "projects");
    await writeJsonl(path.join(claudeRoot, "keep", "session.jsonl"), [
      { timestamp: "2026-05-02T10:00:00.000Z", costUSD: 99, message: { id: "old", model: "claude-haiku-4-5", usage: { output_tokens: 100 } } },
      { timestamp: "2026-05-18T10:00:00.000Z", costUSD: 4, message: { id: "m1", model: "claude-haiku-4-5", usage: { output_tokens: 100 } } },
    ]);
    await writeJsonl(path.join(claudeRoot, "drop", "session.jsonl"), [
      { timestamp: "2026-05-18T10:00:00.000Z", costUSD: 8, message: { id: "m2", model: "claude-haiku-4-5", usage: { output_tokens: 100 } } },
    ]);

    const report = await generateUsageReport({
      provider: "claude",
      type: "monthly",
      since: "2026-05-10",
      until: "2026-05-31",
      project: "keep",
      costMode: "auto",
      timezone: "UTC",
    }, {
      settings: { ...defaultSettings, pricingOfflineMode: true },
      claudeProjectsDirs: [claudeRoot],
      codexSessionsDirs: [],
      codexConfigPaths: [],
    });

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ bucket: "2026-05", project: "keep", costUSD: 4 });
    expect(report.totals.costUSD).toBe(4);
  });

  it("supports Claude auto, calculate, and display cost modes", async () => {
    const claudeRoot = path.join(tmpRoot, "claude-cost-modes", "projects");
    await writeJsonl(path.join(claudeRoot, "proj", "session.jsonl"), [
      { timestamp: "2026-05-18T10:00:00.000Z", costUSD: 7, message: { id: "official", model: "claude-haiku-4-5", usage: { output_tokens: 1000 } } },
      { timestamp: "2026-05-18T11:00:00.000Z", message: { id: "missing", model: "claude-haiku-4-5", usage: { output_tokens: 1000 } } },
    ]);
    const deps = {
      settings: { ...defaultSettings, pricingOfflineMode: true },
      claudeProjectsDirs: [claudeRoot],
      codexSessionsDirs: [],
      codexConfigPaths: [],
    };
    const base = { provider: "claude" as const, type: "daily" as const, timezone: "UTC", order: "asc" as const };

    const auto = await generateUsageReport({ ...base, costMode: "auto" }, deps);
    const calculate = await generateUsageReport({ ...base, costMode: "calculate" }, deps);
    const display = await generateUsageReport({ ...base, costMode: "display" }, deps);

    expect(auto.totals.costUSD).toBeCloseTo(7 + 1000 * 4e-6, 5);
    expect(calculate.totals.costUSD).toBeCloseTo(2000 * 4e-6, 5);
    expect(display.totals.costUSD).toBe(7);
  });
});

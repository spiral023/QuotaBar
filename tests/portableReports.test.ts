import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fromClaudeEntries, fromCodexEvents, toClaudeEntries, toCodexEvents } from "../src/portable/eventAdapters";
import { PORTABLE_STORE_VERSION, type PortableUsageEvent } from "../src/portable/types";
import { PortableUsageStore } from "../src/portable/usageStore";
import type { ModelPricing } from "../src/pricing/cost-calculator";
import type { CodexTokenEvent } from "../src/pricing/codex-log-reader";
import { HistoricalPricingResolver, resetHistoricalPricingResolverCacheForTests } from "../src/pricing/historical-pricing-resolver";
import type { ClaudeUsageEntry } from "../src/pricing/jsonl-reader";
import { generateUsageReport } from "../src/reports/reportService";
import type { ReportRequest } from "../src/reports/types";

const tmpRoot = path.join(os.tmpdir(), `quotabar-portable-reports-${process.pid}`);

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  resetHistoricalPricingResolverCacheForTests();
  vi.restoreAllMocks();
});

function legacyFixtures(): { claude: ClaudeUsageEntry[]; codex: CodexTokenEvent[] } {
  return {
    claude: [
      {
        provider: "claude", timestamp: "2026-05-24T23:30:00.000Z", model: "claude-test",
        project: "alpha", projectName: "alpha", session: "claude-a", inputTokens: 100,
        outputTokens: 20, cacheCreationTokens: 5, cacheReadTokens: 10, costUSD: 1.25,
      },
      {
        provider: "claude", timestamp: "2026-06-01T01:15:00.000Z", model: "claude-test",
        project: "beta", projectName: "beta", session: "claude-b", inputTokens: 200,
        outputTokens: 40, cacheCreationTokens: 10, cacheReadTokens: 20, costUSD: 2.5,
      },
    ],
    codex: [
      {
        timestamp: "2026-05-25T00:30:00.000Z", model: "codex-test", isFallback: false,
        session: "codex-a", directory: "alpha", projectName: "alpha", inputTokens: 150,
        cachedInputTokens: 30, outputTokens: 25, reasoningOutputTokens: 5, totalTokens: 175,
      },
      {
        timestamp: "2026-06-02T13:45:00.000Z", model: "codex-test", isFallback: false,
        session: "codex-b", directory: "beta", projectName: "beta", inputTokens: 300,
        cachedInputTokens: 60, outputTokens: 50, reasoningOutputTokens: 10, totalTokens: 350,
      },
    ],
  };
}

function equivalentFixtures(): {
  usageEvents: PortableUsageEvent[];
  claudeEntries: ClaudeUsageEntry[];
  codexEvents: CodexTokenEvent[];
} {
  const legacy = legacyFixtures();
  const usageEvents = [...fromClaudeEntries(legacy.claude), ...fromCodexEvents(legacy.codex)].map((event) => {
    if (event.provider !== "codex") return event;
    const inputCostUSD = event.inputTokens * 2e-6;
    const outputCostUSD = event.outputTokens * 4e-6;
    const cacheReadCostUSD = event.cacheReadTokens * 1e-6;
    return {
      ...event,
      costUSD: inputCostUSD + outputCostUSD + cacheReadCostUSD,
      inputCostUSD,
      outputCostUSD,
      cacheCreationCostUSD: 0,
      cacheReadCostUSD,
      pricingVersion: "fixture-standard",
    };
  });
  return {
    usageEvents,
    claudeEntries: toClaudeEntries(usageEvents),
    codexEvents: toCodexEvents(usageEvents),
  };
}

function pricingResolver(name: string): HistoricalPricingResolver {
  const pricing: ModelPricing = {
    input_cost_per_token: 2e-6,
    output_cost_per_token: 4e-6,
    cache_read_input_token_cost: 1e-6,
  };
  return new HistoricalPricingResolver({ getModelPricing: async () => pricing }, {
    historyPath: path.join(tmpRoot, `${name}.json`),
  });
}

describe("portable usage reports", () => {
  const requests: Array<[string, ReportRequest]> = [
    ["daily", { provider: "all", type: "daily", timezone: "UTC", order: "asc" }],
    ["weekly", { provider: "all", type: "weekly", timezone: "UTC", order: "asc" }],
    ["monthly", { provider: "all", type: "monthly", timezone: "UTC", order: "asc" }],
    ["hourly", { provider: "all", type: "hourly", timezone: "UTC", order: "asc" }],
    ["session", { provider: "all", type: "session", timezone: "UTC", order: "asc" }],
    ["project rows", { provider: "all", type: "daily", timezone: "UTC", order: "asc", instances: true }],
    ["breakdowns", { provider: "all", type: "daily", timezone: "UTC", order: "asc", breakdown: true }],
    ["date range", { provider: "all", type: "daily", since: "2026-05-25", until: "2026-06-01", timezone: "UTC", order: "asc" }],
    ["project filter", { provider: "all", type: "daily", project: "beta", timezone: "UTC", order: "asc" }],
    ["Claude totals", { provider: "claude", type: "daily", timezone: "UTC", order: "asc" }],
    ["Codex totals", { provider: "codex", type: "daily", timezone: "UTC", order: "asc" }],
  ];

  it.each(requests)("matches legacy rows and totals for %s", async (name, request) => {
    const fixtures = equivalentFixtures();
    const resolver = pricingResolver(name.replaceAll(" ", "-"));
    const legacy = await generateUsageReport({ ...request, source: "legacy" }, {
      claudeEntries: fixtures.claudeEntries,
      codexEvents: fixtures.codexEvents,
      codexConfigPaths: [],
      pricingResolver: resolver,
    });
    const portable = await generateUsageReport(request, {
      usageEvents: fixtures.usageEvents,
      claudeEntries: [],
      codexEvents: [],
      codexConfigPaths: [],
      pricingResolver: resolver,
    });

    expect(portable.rows).toEqual(legacy.rows);
    expect(portable.totals).toEqual(legacy.totals);
    expect(portable.request.source).toBe("portable");
  });

  it("uses only portable events when injected provider readers throw", async () => {
    const fixtures = equivalentFixtures();
    const readClaudeEntries = vi.fn(async (): Promise<ClaudeUsageEntry[]> => {
      throw new Error("Claude provider history must not be read");
    });
    const readCodexEvents = vi.fn(async (): Promise<CodexTokenEvent[]> => {
      throw new Error("Codex provider history must not be read");
    });
    const readCodexSpeedTier = vi.fn(async () => {
      throw new Error("Codex provider config must not be read");
    });

    const report = await generateUsageReport({ type: "daily", timezone: "UTC" }, {
      usageEvents: fixtures.usageEvents,
      claudeEntries: [],
      codexEvents: [],
      codexConfigPaths: [],
      readClaudeEntries,
      readCodexEvents,
      readCodexSpeedTier,
      pricingResolver: pricingResolver("reader-isolation"),
    });

    expect(report.rows).toHaveLength(4);
    expect(readClaudeEntries).not.toHaveBeenCalled();
    expect(readCodexEvents).not.toHaveBeenCalled();
    expect(readCodexSpeedTier).not.toHaveBeenCalled();
  });

  it("preserves Codex auto speed-tier cost parity", async () => {
    const fixtures = equivalentFixtures();
    const fastEvents = fixtures.usageEvents.map((event) => event.provider === "codex" ? {
      ...event,
      costUSD: (event.costUSD ?? 0) * 2,
      inputCostUSD: (event.inputCostUSD ?? 0) * 2,
      outputCostUSD: (event.outputCostUSD ?? 0) * 2,
      cacheCreationCostUSD: (event.cacheCreationCostUSD ?? 0) * 2,
      cacheReadCostUSD: (event.cacheReadCostUSD ?? 0) * 2,
      pricingVersion: "fixture-fast",
    } : event);
    const request: ReportRequest = { provider: "codex", type: "daily", timezone: "UTC", codexSpeed: "auto" };
    const resolver = pricingResolver("speed-tier");
    const readCodexSpeedTier = vi.fn(async () => "fast" as const);

    const legacy = await generateUsageReport({ ...request, source: "legacy" }, {
      codexEvents: fixtures.codexEvents,
      readCodexSpeedTier,
      pricingResolver: resolver,
    });
    const portable = await generateUsageReport(request, {
      usageEvents: fastEvents,
      readCodexSpeedTier,
      pricingResolver: resolver,
    });

    expect(portable.totals.costUSD).toBe(legacy.totals.costUSD);
    expect(readCodexSpeedTier).toHaveBeenCalledOnce();
  });

  it("bounds store reads to the requested range and hides neutral reconciliation markers", async () => {
    const fixtures = equivalentFixtures();
    const marker: PortableUsageEvent = {
      schemaVersion: PORTABLE_STORE_VERSION,
      id: "neutral-marker",
      provider: "claude",
      occurredAt: "2026-05-25T12:00:00.000Z",
      model: "__legacy_reconciliation__",
      projectName: "internal",
      sessionKey: "internal-marker",
      source: "legacy-reconciliation",
      synthetic: true,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      reasoningOutputTokens: 0,
      legacyTarget: {
        inputTokens: 1, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
        reasoningOutputTokens: 0, costUSD: 0, inputCostUSD: 0, outputCostUSD: 0,
        cacheCreationCostUSD: 0, cacheReadCostUSD: 0,
      },
    };
    const store = new PortableUsageStore(path.join(tmpRoot, "store"));
    await store.upsert([...fixtures.usageEvents, marker]);
    const read = vi.spyOn(store, "read");

    const report = await generateUsageReport({
      provider: "all", type: "session", since: "2026-05-25", until: "2026-06-01",
      timezone: "America/Los_Angeles", order: "asc",
    }, {
      usageStore: store,
      claudeEntries: [],
      codexEvents: [],
      codexConfigPaths: [],
      pricingResolver: pricingResolver("bounded"),
    });

    expect(read).toHaveBeenCalledWith({
      since: "2026-05-24T00:00:00.000Z",
      until: "2026-06-02T23:59:59.999Z",
    });
    expect(report.rows).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ session: "internal-marker" }),
    ]));
  });
});

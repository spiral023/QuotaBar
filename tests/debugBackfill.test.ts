import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DebugRecorder } from "../src/main/debugRecorder";
import { runBackfill } from "../src/main/debugBackfill";
import { LiteLLMFetcher } from "../src/pricing/litellm-fetcher";
import { HistoricalPricingResolver, resetHistoricalPricingResolverCacheForTests } from "../src/pricing/historical-pricing-resolver";

let tmpDir: string;
let claudeDir: string;
let codexDir: string;

async function writeClaudeJsonl(file: string, lines: object[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

async function writeCodexJsonl(file: string, lines: object[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-backfill-"));
  claudeDir = path.join(tmpDir, "claude", "projects");
  codexDir = path.join(tmpDir, "codex", "sessions");
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.mkdir(codexDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  resetHistoricalPricingResolverCacheForTests();
});

function offlinePricingResolver(): HistoricalPricingResolver {
  return new HistoricalPricingResolver(new LiteLLMFetcher(true), {
    historyPath: path.join(tmpDir, "historical-prices.json"),
  });
}

describe("runBackfill", () => {
  it("emits tokens.usage and tokens.daySummary into per-day backfill files", async () => {
    await writeClaudeJsonl(path.join(claudeDir, "proj-a", "session-1.jsonl"), [
      { type: "assistant", timestamp: "2026-05-20T14:00:00Z",
        message: { id: "m1", model: "claude-sonnet-4-6",
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 200 } } },
      { type: "assistant", timestamp: "2026-05-21T09:00:00Z",
        message: { id: "m2", model: "claude-sonnet-4-6",
          usage: { input_tokens: 80, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    ]);
    const logDir = path.join(tmpDir, "debug");
    const recorder = new DebugRecorder({ enabled: true, logDir });

    const result = await runBackfill({
      recorder,
      logDir,
      claudeProjectsDirs: [claudeDir],
      codexSessionsDirs: [codexDir],
    });
    await recorder.flush();

    expect(result.daysWritten).toBeGreaterThanOrEqual(2);
    expect(result.errors).toEqual([]);
    const files = await fs.readdir(logDir);
    expect(files).toContain("2026-05-20.backfill.jsonl");
    expect(files).toContain("2026-05-21.backfill.jsonl");

    const day20 = (await fs.readFile(path.join(logDir, "2026-05-20.backfill.jsonl"), "utf8"))
      .trim().split("\n").map((l) => JSON.parse(l));
    expect(day20.some((e) => e.kind === "tokens.usage" && e.provider === "claude")).toBe(true);
    expect(day20.some((e) => e.kind === "tokens.daySummary" && e.provider === "claude" && e.input === 100)).toBe(true);
  });

  it("skips the whole run when no source file changed since last run", async () => {
    await writeClaudeJsonl(path.join(claudeDir, "proj", "session.jsonl"), [
      { type: "assistant", timestamp: "2026-05-20T14:00:00Z",
        message: { id: "m1", model: "claude-sonnet-4-6",
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    ]);
    const logDir = path.join(tmpDir, "debug");
    const recorder = new DebugRecorder({ enabled: true, logDir });
    const opts = { recorder, logDir, claudeProjectsDirs: [claudeDir], codexSessionsDirs: [codexDir] };

    const first = await runBackfill(opts);
    await recorder.flush();
    const second = await runBackfill(opts);
    await recorder.flush();

    expect(first.daysWritten).toBeGreaterThan(0);
    // Zweiter Lauf: Quelldatei unverändert → kompletter Skip via Manifest.
    expect(second.daysWritten).toBe(0);
    // Manifest wurde geschrieben.
    const files = await fs.readdir(logDir);
    expect(files).toContain("backfill-manifest.json");
  });

  it("Codex totalTokens does not double-count cachedInput", async () => {
    // input_tokens=1000 already includes cached_input_tokens=800.
    // totalTokens must be input+output+reasoning = 1000+100+0 = 1100, not 1000+800+100 = 1900.
    await writeCodexJsonl(path.join(codexDir, "session-cx.jsonl"), [
      { type: "turn_context", payload: { model: "gpt-5.5" } },
      { type: "event_msg", timestamp: "2026-05-20T14:00:00Z", payload: {
        type: "token_count", info: {
          last_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100,
                              reasoning_output_tokens: 0, total_tokens: 1100 },
        },
      }},
    ]);
    const logDir = path.join(tmpDir, "debug");
    const recorder = new DebugRecorder({ enabled: true, logDir });

    await runBackfill({ recorder, logDir, claudeProjectsDirs: [claudeDir], codexSessionsDirs: [codexDir] });
    await recorder.flush();

    const lines = (await fs.readFile(path.join(logDir, "2026-05-20.backfill.jsonl"), "utf8"))
      .trim().split("\n").map((l) => JSON.parse(l));
    const summary = lines.find((e) => e.kind === "tokens.daySummary" && e.provider === "codex");
    expect(summary).toBeDefined();
    expect(summary.input).toBe(1000);
    expect(summary.cachedInput).toBe(800);
    expect(summary.output).toBe(100);
    expect(summary.totalTokens).toBe(1100); // must NOT be 1900
  });

  it("calculates totalCostUSD when a pricing resolver is provided", async () => {
    // claude-sonnet-4-5 ist in den Fallback-Preisen: input=3e-6, output=15e-6, cacheRead=3e-7
    await writeClaudeJsonl(path.join(claudeDir, "proj", "session.jsonl"), [
      { type: "assistant", timestamp: "2026-05-20T14:00:00Z",
        message: { id: "m1", model: "claude-sonnet-4-5",
          usage: { input_tokens: 1000, output_tokens: 500,
                   cache_creation_input_tokens: 0, cache_read_input_tokens: 2000 } } },
    ]);
    const logDir = path.join(tmpDir, "debug");
    const recorder = new DebugRecorder({ enabled: true, logDir });

    await runBackfill({
      recorder, logDir,
      claudeProjectsDirs: [claudeDir],
      codexSessionsDirs: [codexDir],
      pricingResolver: offlinePricingResolver(),
    });
    await recorder.flush();

    const lines = (await fs.readFile(path.join(logDir, "2026-05-20.backfill.jsonl"), "utf8"))
      .trim().split("\n").map((l) => JSON.parse(l));
    const summary = lines.find((e: { kind: string; provider: string }) => e.kind === "tokens.daySummary" && e.provider === "claude");
    expect(summary).toBeDefined();
    // 1000 * 3e-6 + 500 * 15e-6 + 2000 * 3e-7 = 0.003 + 0.0075 + 0.0006 = 0.0111
    expect(summary.totalCostUSD).toBeCloseTo(0.0111, 6);
    expect(summary.perModel["claude-sonnet-4-5"].costUSD).toBeCloseTo(0.0111, 6);
  });

  it("uses each Codex event's historical price when forced backfill rebuilds daily summaries", async () => {
    const model = "historical-codex";
    let currentOutputPrice = 2e-6;
    let now = new Date("2026-05-01T00:00:00.000Z");
    const resolver = new HistoricalPricingResolver({
      getModelPricing: async () => ({ output_cost_per_token: currentOutputPrice }),
    }, {
      historyPath: path.join(tmpDir, "historical-prices.json"),
      now: () => now,
    });
    await resolver.getModelPricing(model);
    currentOutputPrice = 1e-6;
    now = new Date("2026-06-01T00:00:00.000Z");
    await resolver.getModelPricing(model);

    await writeCodexJsonl(path.join(codexDir, "session-cx.jsonl"), [
      { type: "turn_context", payload: { model } },
      { type: "event_msg", timestamp: "2026-05-02T12:00:00Z", payload: { type: "token_count", info: {
        last_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 1_000_000, reasoning_output_tokens: 0, total_tokens: 1_000_000 },
      } } },
      { type: "event_msg", timestamp: "2026-06-02T12:00:00Z", payload: { type: "token_count", info: {
        last_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 1_000_000, reasoning_output_tokens: 0, total_tokens: 1_000_000 },
      } } },
    ]);
    const logDir = path.join(tmpDir, "debug");
    const recorder = new DebugRecorder({ enabled: true, logDir });

    await runBackfill({
      recorder,
      logDir,
      claudeProjectsDirs: [claudeDir],
      codexSessionsDirs: [codexDir],
      force: true,
      pricingResolver: resolver,
    });
    await recorder.flush();

    const costs = await Promise.all(["2026-05-02", "2026-06-02"].map(async (day) => {
      const lines = (await fs.readFile(path.join(logDir, `${day}.backfill.jsonl`), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line));
      return lines.find((entry) => entry.kind === "tokens.daySummary" && entry.provider === "codex").totalCostUSD;
    }));
    expect(costs).toEqual([2, 1]);
  });

  it("preserves contributions from unchanged source files when only one file of a day changes", async () => {
    // Ein Tag (2026-05-20) wird von ZWEI Quelldateien gespeist.
    const sessA = path.join(claudeDir, "proj-a", "session-1.jsonl");
    const sessB = path.join(claudeDir, "proj-b", "session-2.jsonl");
    await writeClaudeJsonl(sessA, [
      { type: "assistant", timestamp: "2026-05-20T08:00:00Z",
        message: { id: "m1", model: "claude-sonnet-4-6",
          usage: { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    ]);
    await writeClaudeJsonl(sessB, [
      { type: "assistant", timestamp: "2026-05-20T09:00:00Z",
        message: { id: "m2", model: "claude-haiku-4-5",
          usage: { input_tokens: 500, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    ]);
    const logDir = path.join(tmpDir, "debug");
    const recorder = new DebugRecorder({ enabled: true, logDir });
    const opts = { recorder, logDir, claudeProjectsDirs: [claudeDir], codexSessionsDirs: [codexDir] };

    // Erster Lauf: beide Dateien fließen in den Tagessatz ein (100 + 500 = 600).
    await runBackfill(opts);
    await recorder.flush();

    // Nur session-1 ändert sich (zusätzlicher Eintrag am selben Tag); session-2 bleibt unverändert.
    await writeClaudeJsonl(sessA, [
      { type: "assistant", timestamp: "2026-05-20T08:00:00Z",
        message: { id: "m1", model: "claude-sonnet-4-6",
          usage: { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
      { type: "assistant", timestamp: "2026-05-20T08:30:00Z",
        message: { id: "m3", model: "claude-sonnet-4-6",
          usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    ]);

    // Zweiter Lauf: session-1 gilt als geändert, session-2 als unverändert.
    await runBackfill(opts);
    await recorder.flush();

    const summary = (await fs.readFile(path.join(logDir, "2026-05-20.backfill.jsonl"), "utf8"))
      .trim().split("\n").map((l) => JSON.parse(l))
      .find((e) => e.kind === "tokens.daySummary" && e.provider === "claude");
    expect(summary).toBeDefined();
    // Der Beitrag der unveränderten session-2 (Modell + 500 Tokens) darf NICHT verloren gehen.
    expect(Object.keys(summary.perModel)).toContain("claude-haiku-4-5");
    expect(summary.input).toBe(610); // 100 + 10 (session-1) + 500 (session-2)
  });

  it("force=true regenerates existing backfill files", async () => {
    await writeClaudeJsonl(path.join(claudeDir, "proj", "session.jsonl"), [
      { type: "assistant", timestamp: "2026-05-20T14:00:00Z",
        message: { id: "m1", model: "claude-sonnet-4-6",
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    ]);
    const logDir = path.join(tmpDir, "debug");
    const recorder = new DebugRecorder({ enabled: true, logDir });
    const opts = { recorder, logDir, claudeProjectsDirs: [claudeDir], codexSessionsDirs: [codexDir] };

    await runBackfill(opts);
    await recorder.flush();
    const result = await runBackfill({ ...opts, force: true });
    await recorder.flush();

    expect(result.daysWritten).toBeGreaterThan(0);
  });

  it("preserves existing backfill files when a source disappears from the configured roots", async () => {
    const originalSource = path.join(claudeDir, "proj", "session.jsonl");
    await writeClaudeJsonl(originalSource, [
      { type: "assistant", timestamp: "2026-05-20T14:00:00Z",
        message: { id: "m1", model: "claude-sonnet-4-6",
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    ]);
    const logDir = path.join(tmpDir, "debug");
    const recorder = new DebugRecorder({ enabled: true, logDir });

    await runBackfill({ recorder, logDir, claudeProjectsDirs: [claudeDir], codexSessionsDirs: [codexDir] });
    await recorder.flush();

    const replacementRoot = path.join(tmpDir, "new-claude", "projects");
    await fs.mkdir(replacementRoot, { recursive: true });
    const result = await runBackfill({
      recorder,
      logDir,
      claudeProjectsDirs: [replacementRoot],
      codexSessionsDirs: [codexDir],
    });
    await recorder.flush();

    expect(result.daysWritten).toBe(0);
    const existing = await fs.readFile(path.join(logDir, "2026-05-20.backfill.jsonl"), "utf8");
    expect(existing).toContain("tokens.daySummary");
    expect(existing).toContain("claude-sonnet-4-6");
  });
});

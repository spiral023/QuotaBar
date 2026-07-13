import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DebugRecorder } from "../src/main/debugRecorder";
import type { SnapshotEvent } from "../src/main/debugEvents";
import { appendQuotaSnapshots, readQuotaSnapshots } from "../src/portable/quotaStore";

function snapshot(
  provider: "claude" | "codex",
  fetchedAt: string,
  overrides: Partial<SnapshotEvent> = {},
): SnapshotEvent {
  return {
    kind: "snapshot",
    provider,
    status: "ok",
    planType: "pro",
    windows: [
      {
        name: "fiveHour",
        usedPercent: 20,
        remainingPercent: 80,
        resetsAt: "2026-08-01T05:00:00.000Z",
        windowSeconds: 18_000,
        label: "5-hour limit",
        pace: {
          stage: "onTrack",
          deltaPercent: 1,
          expectedUsedPercent: 19,
          actualUsedPercent: 20,
          etaSeconds: 12_000,
          willLastToReset: true,
        },
        burnRatePctPerHour: 4,
        safetyGapSeconds: 3_600,
      },
      {
        name: "weekly",
        usedPercent: 45,
        remainingPercent: 55,
        resetsAt: "2026-08-08T00:00:00.000Z",
        windowSeconds: 604_800,
      },
    ],
    fetchedAt,
    ...overrides,
  };
}

describe("portable quota store", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "quotabar-quota-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("partitions snapshots by UTC month and deduplicates provider plus fetchedAt", async () => {
    const julyClaude = snapshot("claude", "2026-07-31T23:59:59.000Z");
    const julyCodex = snapshot("codex", "2026-07-31T23:59:59.000Z");
    const augustClaude = snapshot("claude", "2026-08-01T00:00:00.000Z");

    await appendQuotaSnapshots(root, [julyClaude, julyCodex, augustClaude, julyClaude]);
    await appendQuotaSnapshots(root, [julyClaude, julyCodex, augustClaude]);

    expect(await readdir(path.join(root, "snapshots"))).toEqual(["2026-07.jsonl", "2026-08.jsonl"]);
    expect(await readQuotaSnapshots(root)).toEqual([julyClaude, julyCodex, augustClaude]);
    expect((await readQuotaSnapshots(root))[0].windows).toEqual(julyClaude.windows);
  });

  it("uses the UTC month for timestamps with an explicit offset", async () => {
    const julyUtc = snapshot("claude", "2026-08-01T00:30:00+02:00");

    await appendQuotaSnapshots(root, [julyUtc]);

    expect(await readdir(path.join(root, "snapshots"))).toEqual(["2026-07.jsonl"]);
    expect(await readQuotaSnapshots(root)).toEqual([julyUtc]);
  });

  it("reads inclusive ranges without touching unrelated monthly partitions", async () => {
    await appendQuotaSnapshots(root, [
      snapshot("claude", "2026-06-30T23:59:59.999Z"),
      snapshot("claude", "2026-07-01T00:00:00.000Z"),
      snapshot("codex", "2026-07-31T23:59:59.999Z"),
      snapshot("claude", "2026-08-01T00:00:00.000Z"),
    ]);
    await writeFile(path.join(root, "snapshots", "2025-01.jsonl"), "unrelated damaged partition\n", "utf8");

    expect(await readQuotaSnapshots(root, { since: "2026-07-01", until: "2026-07-31" }))
      .toEqual([
        snapshot("claude", "2026-07-01T00:00:00.000Z"),
        snapshot("codex", "2026-07-31T23:59:59.999Z"),
      ]);
  });

  it("skips malformed and invalid disk records while returning sanitized valid records", async () => {
    const snapshotsDir = path.join(root, "snapshots");
    await mkdir(snapshotsDir, { recursive: true });
    const valid = snapshot("claude", "2026-07-03T00:00:00.000Z");
    await writeFile(path.join(snapshotsDir, "2026-07.jsonl"), [
      "{not-json",
      JSON.stringify({ ...valid, provider: "other" }),
      JSON.stringify({ ...valid, windows: [{ name: "weekly", usedPercent: Number.NaN }] }),
      JSON.stringify({ ...valid, authorization: "secret", rawResponse: { private: true } }),
      "",
    ].join("\n"), "utf8");

    expect(await readQuotaSnapshots(root)).toEqual([valid]);
  });

  it("persists only allowlisted quota metrics and omits errors, tokens, and extra fields", async () => {
    const unsafe = {
      ...snapshot("claude", "2026-07-03T00:00:00.000Z"),
      errorMessage: "provider response included a credential",
      authorization: "secret",
      rawResponse: { prompt: "private" },
      cost: {
        apiCostUSD: 1,
        subscriptionCostUSD: 20,
        factor: 20,
        isEstimate: false,
        label: "20x",
        windowLabel: "30 days",
        windowDays: 30,
        calculationMode: "fixed",
        tokenUsage: {
          inputTokens: 1,
          outputTokens: 2,
          cacheCreationTokens: 3,
          cacheReadTokens: 4,
          totalTokens: 10,
          models: ["private-model"],
        },
        missingPricingModels: ["private-model"],
      },
    } as SnapshotEvent;

    await appendQuotaSnapshots(root, [unsafe]);

    const disk = JSON.parse(
      (await readFile(path.join(root, "snapshots", "2026-07.jsonl"), "utf8")).trim(),
    ) as Record<string, unknown>;
    expect(disk).not.toHaveProperty("errorMessage");
    expect(disk).not.toHaveProperty("authorization");
    expect(disk).not.toHaveProperty("rawResponse");
    expect(disk.cost).toEqual({
      apiCostUSD: 1,
      subscriptionCostUSD: 20,
      factor: 20,
      isEstimate: false,
      label: "20x",
      windowLabel: "30 days",
      windowDays: 30,
      calculationMode: "fixed",
    });
  });

  it("preserves nullable live window metrics without rejecting the refresh batch", async () => {
    const live = snapshot("claude", "2026-07-03T00:00:00.000Z", {
      windows: [{
        name: "weekly",
        usedPercent: 10,
        burnRatePctPerHour: null,
        safetyGapSeconds: null,
      }],
    });

    await appendQuotaSnapshots(root, [live]);

    expect(await readQuotaSnapshots(root)).toEqual([live]);
  });

  it("rejects invalid snapshots before creating store files", async () => {
    const invalid = {
      ...snapshot("claude", "2026-07-03T00:00:00.000Z"),
      windows: [{ name: "weekly", usedPercent: Number.POSITIVE_INFINITY }],
    } as SnapshotEvent;

    await expect(appendQuotaSnapshots(root, [invalid])).rejects.toThrow("Invalid portable quota snapshot");
    await expect(readdir(root)).resolves.toEqual([]);
    await expect(readQuotaSnapshots(root, { since: "2026-08-01", until: "2026-07-01" }))
      .rejects.toThrow("since is after until");
  });

  it("rejects impossible calendar timestamps", async () => {
    const invalid = snapshot("claude", "2026-02-30T00:00:00.000Z");

    await expect(appendQuotaSnapshots(root, [invalid])).rejects.toThrow("Invalid portable quota snapshot");
    await expect(readQuotaSnapshots(root, { since: "2026-02-30" })).rejects.toThrow("Invalid portable quota range");
  });

  it("persists snapshots when diagnostic recording is disabled", async () => {
    const debugDir = path.join(root, "debug");
    const recorder = new DebugRecorder({ enabled: false, logDir: debugDir });
    const event = snapshot("claude", "2026-07-03T00:00:00.000Z");

    recorder.write(event);
    await recorder.flush();
    await appendQuotaSnapshots(root, [event]);

    await expect(readdir(debugDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readQuotaSnapshots(root)).toEqual([event]);
  });

  it("wires live refresh persistence independently of the debug recorder", async () => {
    const source = await readFile(path.join(process.cwd(), "src", "main", "main.ts"), "utf8");

    expect(source).toContain("appendQuotaSnapshots(getPortableQuotaDir(), snapshots.map(snapshotEvent))");
    expect(source).toContain("Portable quota snapshot save failed");
  });

  it("uses portable quota observations for analytics window readers", async () => {
    const source = await readFile(path.join(process.cwd(), "src", "main", "analyticsWorker.ts"), "utf8");

    expect(source).toContain("readQuotaSnapshots");
    expect(source).not.toContain('import { readWindowHistoryObservations }');
    expect(source).not.toContain("readWeeklySeriesForProviders");
    expect(source).toContain("since: new Date(input.periodStartMs).toISOString()");
    expect(source).toContain("until: new Date(untilMs).toISOString()");
  });
});

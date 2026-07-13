import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
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
    expect(await readQuotaSnapshots(root)).toEqual([{
      ...julyUtc,
      fetchedAt: "2026-07-31T22:30:00.000Z",
    }]);
  });

  it("merges a newer collision by stable window name and remains idempotent", async () => {
    const fetchedAt = "2026-07-03T00:00:00.000Z";
    const original = snapshot("claude", fetchedAt, {
      status: "error",
      planType: undefined,
      windows: [
        { name: "fiveHour", usedPercent: 10, label: "Retained" },
        { name: "weekly", usedPercent: 20, remainingPercent: 80, label: "Weekly" },
      ],
      cost: undefined,
    });
    const correction = snapshot("claude", "2026-07-03T02:00:00+02:00", {
      status: "ok",
      planType: "max",
      windows: [
        { name: "weekly", usedPercent: 35 },
        { name: "monthly", usedPercent: 5 },
      ],
      cost: {
        apiCostUSD: 2,
        subscriptionCostUSD: 10,
        factor: 5,
        isEstimate: false,
        label: "5x",
      },
    });

    await appendQuotaSnapshots(root, [original]);
    await appendQuotaSnapshots(root, [correction]);
    const partition = path.join(root, "snapshots", "2026-07.jsonl");
    const once = await readFile(partition, "utf8");
    await appendQuotaSnapshots(root, [correction]);

    expect(await readFile(partition, "utf8")).toBe(once);
    expect(await readQuotaSnapshots(root)).toEqual([{
      kind: "snapshot",
      provider: "claude",
      status: "ok",
      planType: "max",
      fetchedAt,
      windows: [
        { name: "fiveHour", usedPercent: 10, label: "Retained" },
        { name: "weekly", usedPercent: 35, remainingPercent: 80, label: "Weekly" },
        { name: "monthly", usedPercent: 5 },
      ],
      cost: correction.cost,
    }]);
  });

  it("returns canonical UTC timestamps in chronological order across an offset month boundary", async () => {
    await appendQuotaSnapshots(root, [
      snapshot("codex", "2026-07-31T23:00:00.000Z"),
      snapshot("claude", "2026-08-01T00:30:00+02:00"),
    ]);

    const stored = await readQuotaSnapshots(root);
    expect(stored.map(({ provider, fetchedAt }) => [provider, fetchedAt])).toEqual([
      ["claude", "2026-07-31T22:30:00.000Z"],
      ["codex", "2026-07-31T23:00:00.000Z"],
    ]);
    const worker = await import("../src/main/analyticsWorker") as unknown as {
      quotaSnapshotsToHistoryObservations(items: SnapshotEvent[]): Array<{ ts: string }>;
    };
    expect(worker.quotaSnapshotsToHistoryObservations(stored).map(({ ts }) => ts)).toEqual([
      "2026-07-31T22:30:00.000Z",
      "2026-07-31T23:00:00.000Z",
    ]);
    expect(await readdir(path.join(root, "snapshots"))).toEqual(["2026-07.jsonl"]);
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

  it("does not replace unchanged historical partitions during a current-month append", async () => {
    await appendQuotaSnapshots(root, [snapshot("claude", "2026-06-01T00:00:00.000Z")]);
    const historical = path.join(root, "snapshots", "2026-06.jsonl");
    const oldTime = new Date("2000-01-01T00:00:00.000Z");
    await utimes(historical, oldTime, oldTime);
    const before = await readFile(historical);
    const beforeStat = await stat(historical);

    await appendQuotaSnapshots(root, [snapshot("claude", "2026-07-01T00:00:00.000Z")]);

    expect(await readFile(historical)).toEqual(before);
    expect((await stat(historical)).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("stages only affected partition targets in the pending manifest", async () => {
    await appendQuotaSnapshots(root, [snapshot("claude", "2026-06-01T00:00:00.000Z")]);
    await mkdir(path.join(root, "snapshots", "2026-07.jsonl"));

    await expect(appendQuotaSnapshots(root, [snapshot("claude", "2026-07-01T00:00:00.000Z")]))
      .rejects.toThrow();

    const manifest = JSON.parse(await readFile(path.join(root, "pending-quota-transaction.json"), "utf8")) as {
      entries: Array<{ target: string }>;
    };
    expect(manifest.entries.map(({ target }) => target)).toEqual([path.join("snapshots", "2026-07.jsonl")]);
  });

  it("moves valid misplaced records found in an affected partition to their UTC month", async () => {
    const snapshotsDir = path.join(root, "snapshots");
    await mkdir(snapshotsDir, { recursive: true });
    const misplaced = snapshot("codex", "2026-08-01T00:00:00.000Z");
    await writeFile(path.join(snapshotsDir, "2026-07.jsonl"), `${JSON.stringify(misplaced)}\n`, "utf8");

    await appendQuotaSnapshots(root, [snapshot("claude", "2026-07-02T00:00:00.000Z")]);

    expect((await readQuotaSnapshots(root)).map(({ provider, fetchedAt }) => [provider, fetchedAt])).toEqual([
      ["claude", "2026-07-02T00:00:00.000Z"],
      ["codex", "2026-08-01T00:00:00.000Z"],
    ]);
    expect((await readFile(path.join(snapshotsDir, "2026-07.jsonl"), "utf8"))).not.toContain("codex");
  });

  it("serializes concurrent multi-month appends across separate Node processes", async () => {
    const fixture = path.join(process.cwd(), "tests", "fixtures", "portableQuotaStoreChild.test.ts");
    const vitest = path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
    const first = runQuotaChild(vitest, fixture, root, "a");
    const second = runQuotaChild(vitest, fixture, root, "b");
    await waitForPaths([path.join(root, "ready-a"), path.join(root, "ready-b")]);
    await writeFile(path.join(root, "children-go"), "go", "utf8");

    await Promise.all([first, second]);

    expect((await readQuotaSnapshots(root)).map(({ provider, fetchedAt }) => [provider, fetchedAt])).toEqual([
      ["claude", "2026-06-01T00:00:00.000Z"],
      ["codex", "2026-07-01T00:00:00.000Z"],
      ["claude", "2026-07-02T00:00:00.000Z"],
      ["codex", "2026-08-01T00:00:00.000Z"],
    ]);
  }, 30_000);

  it("rolls a pending multi-month transaction forward after one target was renamed", async () => {
    const snapshotsDir = path.join(root, "snapshots");
    await mkdir(snapshotsDir, { recursive: true });
    const june = serialized(snapshot("claude", "2026-06-01T00:00:00.000Z"));
    const july = serialized(snapshot("codex", "2026-07-01T00:00:00.000Z"));
    const juneTarget = path.join(snapshotsDir, "2026-06.jsonl");
    const julyTarget = path.join(snapshotsDir, "2026-07.jsonl");
    const juneTemp = `${juneTarget}.1.1.00000000-0000-4000-8000-000000000001.tmp`;
    const julyTemp = `${julyTarget}.1.1.00000000-0000-4000-8000-000000000002.tmp`;
    await writeFile(juneTarget, june, "utf8");
    await writeFile(julyTemp, july, "utf8");
    await writeManifest(root, [
      manifestEntry(root, juneTarget, juneTemp, june),
      manifestEntry(root, julyTarget, julyTemp, july),
    ]);

    expect((await readQuotaSnapshots(root)).map(({ fetchedAt }) => fetchedAt)).toEqual([
      "2026-06-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
    ]);
    await expect(access(path.join(root, "pending-quota-transaction.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts an already committed target when its staged temp is absent", async () => {
    const snapshotsDir = path.join(root, "snapshots");
    await mkdir(snapshotsDir, { recursive: true });
    const contents = serialized(snapshot("claude", "2026-07-01T00:00:00.000Z"));
    const target = path.join(snapshotsDir, "2026-07.jsonl");
    const temporary = `${target}.1.1.00000000-0000-4000-8000-000000000003.tmp`;
    await writeFile(target, contents, "utf8");
    await writeManifest(root, [manifestEntry(root, target, temporary, contents)]);

    expect(await readQuotaSnapshots(root)).toEqual([snapshot("claude", "2026-07-01T00:00:00.000Z")]);
  });

  it("fails closed on checksum corruption without replacing the committed target", async () => {
    const snapshotsDir = path.join(root, "snapshots");
    await mkdir(snapshotsDir, { recursive: true });
    const committed = serialized(snapshot("claude", "2026-07-01T00:00:00.000Z"));
    const target = path.join(snapshotsDir, "2026-07.jsonl");
    const temporary = `${target}.1.1.00000000-0000-4000-8000-000000000004.tmp`;
    await writeFile(target, committed, "utf8");
    await writeFile(temporary, "corrupt\n", "utf8");
    await writeManifest(root, [manifestEntry(root, target, temporary, "different\n")]);

    await expect(readQuotaSnapshots(root)).rejects.toThrow("checksum mismatch");
    expect(await readFile(target, "utf8")).toBe(committed);
  });

  it("preflights every checksum before applying any pending target", async () => {
    const snapshotsDir = path.join(root, "snapshots");
    await mkdir(snapshotsDir, { recursive: true });
    const june = serialized(snapshot("claude", "2026-06-01T00:00:00.000Z"));
    const july = serialized(snapshot("codex", "2026-07-01T00:00:00.000Z"));
    const juneTarget = path.join(snapshotsDir, "2026-06.jsonl");
    const julyTarget = path.join(snapshotsDir, "2026-07.jsonl");
    const juneTemp = `${juneTarget}.1.1.00000000-0000-4000-8000-000000000006.tmp`;
    const julyTemp = `${julyTarget}.1.1.00000000-0000-4000-8000-000000000007.tmp`;
    await writeFile(juneTemp, june, "utf8");
    await writeFile(julyTemp, "corrupt\n", "utf8");
    await writeManifest(root, [
      manifestEntry(root, juneTarget, juneTemp, june),
      manifestEntry(root, julyTarget, julyTemp, july),
    ]);

    await expect(readQuotaSnapshots(root)).rejects.toThrow("checksum mismatch");
    await expect(access(juneTarget)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(julyTarget)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(juneTemp, "utf8")).resolves.toBe(june);
  });

  it("rejects a malformed transaction identity without consuming the manifest", async () => {
    const marker = path.join(root, "pending-quota-transaction.json");
    await writeFile(marker, `${JSON.stringify({
      schemaVersion: 1,
      transactionId: "not-a-transaction-id",
      entries: [],
    })}\n`, "utf8");

    await expect(readQuotaSnapshots(root)).rejects.toThrow("Invalid pending portable quota transaction");
    expect(await readFile(marker, "utf8")).toContain("not-a-transaction-id");
  });

  it("validates the complete manifest before any target mutation and releases the lock after failure", async () => {
    const snapshotsDir = path.join(root, "snapshots");
    await mkdir(snapshotsDir, { recursive: true });
    const contents = serialized(snapshot("claude", "2026-07-01T00:00:00.000Z"));
    const firstTarget = path.join(snapshotsDir, "2026-07.jsonl");
    const secondTarget = path.join(snapshotsDir, "2026-08.jsonl");
    const sharedTemp = `${firstTarget}.1.1.00000000-0000-4000-8000-000000000005.tmp`;
    await writeFile(sharedTemp, contents, "utf8");
    await writeManifest(root, [
      manifestEntry(root, firstTarget, sharedTemp, contents),
      {
        target: path.relative(root, secondTarget),
        temporary: path.relative(root, sharedTemp),
        sha256: sha256(contents),
      },
    ]);

    await expect(readQuotaSnapshots(root)).rejects.toThrow("Invalid pending portable quota transaction");
    await expect(access(firstTarget)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(secondTarget)).rejects.toMatchObject({ code: "ENOENT" });

    await unlink(path.join(root, "pending-quota-transaction.json"));
    await unlink(sharedTemp);
    await appendQuotaSnapshots(root, [snapshot("codex", "2026-08-01T00:00:00.000Z")]);
    expect((await readQuotaSnapshots(root)).map(({ provider }) => provider)).toEqual(["codex"]);
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

  it("enriches duplicate identities already present in a partition during reads", async () => {
    const snapshotsDir = path.join(root, "snapshots");
    await mkdir(snapshotsDir, { recursive: true });
    const first = snapshot("claude", "2026-07-03T00:00:00.000Z", {
      status: "error",
      windows: [{ name: "fiveHour", usedPercent: 10 }],
    });
    const second = snapshot("claude", "2026-07-03T00:00:00.000Z", {
      status: "ok",
      windows: [{ name: "weekly", usedPercent: 20 }],
    });
    await writeFile(path.join(snapshotsDir, "2026-07.jsonl"), `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`, "utf8");

    expect(await readQuotaSnapshots(root)).toEqual([{
      ...second,
      windows: [...first.windows, ...second.windows],
    }]);
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

  it("accepts valid percentage boundaries and bounded nullable metrics", async () => {
    const boundary = snapshot("claude", "2026-07-03T00:00:00.000Z", {
      windows: [{
        name: "weekly",
        usedPercent: 0,
        remainingPercent: 100,
        windowSeconds: Number.MAX_SAFE_INTEGER,
        burnRatePctPerHour: 0,
        safetyGapSeconds: 0,
        pace: {
          stage: "farBehind",
          deltaPercent: -100,
          expectedUsedPercent: 100,
          actualUsedPercent: 0,
          etaSeconds: 0,
          willLastToReset: false,
        },
      }],
    });

    await appendQuotaSnapshots(root, [boundary]);

    expect(await readQuotaSnapshots(root)).toEqual([boundary]);
  });

  it.each([
    ["used percentage above 100", { windows: [{ name: "weekly", usedPercent: 100.01 }] }],
    ["negative remaining percentage", { windows: [{ name: "weekly", remainingPercent: -1 }] }],
    ["unsafe window seconds", { windows: [{ name: "weekly", windowSeconds: Number.MAX_SAFE_INTEGER + 1 }] }],
    ["fractional window seconds", { windows: [{ name: "weekly", windowSeconds: 1.5 }] }],
    ["negative burn rate", { windows: [{ name: "weekly", burnRatePctPerHour: -0.1 }] }],
    ["unsafe safety gap", { windows: [{ name: "weekly", safetyGapSeconds: Number.MAX_SAFE_INTEGER + 1 }] }],
    ["negative safety gap", { windows: [{ name: "weekly", safetyGapSeconds: -1 }] }],
    ["pace expected percentage above 100", { windows: [{ name: "weekly", pace: {
      stage: "onTrack", deltaPercent: 0, expectedUsedPercent: 101, actualUsedPercent: 1,
      etaSeconds: 1, willLastToReset: true,
    } }] }],
    ["pace delta outside analytic bounds", { windows: [{ name: "weekly", pace: {
      stage: "farAhead", deltaPercent: 101, expectedUsedPercent: 0, actualUsedPercent: 100,
      etaSeconds: 1, willLastToReset: false,
    } }] }],
    ["unsafe pace ETA", { windows: [{ name: "weekly", pace: {
      stage: "onTrack", deltaPercent: 0, expectedUsedPercent: 1, actualUsedPercent: 1,
      etaSeconds: Number.MAX_SAFE_INTEGER + 1, willLastToReset: true,
    } }] }],
    ["unsafe API cost", { cost: {
      apiCostUSD: Number.MAX_SAFE_INTEGER + 1, subscriptionCostUSD: 1, factor: 1,
      isEstimate: false, label: "invalid",
    } }],
    ["fractional window days", { cost: {
      apiCostUSD: 1, subscriptionCostUSD: 1, factor: 1, isEstimate: false,
      label: "invalid", windowDays: 1.5,
    } }],
  ])("rejects analytically invalid or unsafe %s before writing", async (_case, overrides) => {
    const invalid = snapshot("claude", "2026-07-03T00:00:00.000Z", overrides as Partial<SnapshotEvent>);

    await expect(appendQuotaSnapshots(root, [invalid])).rejects.toThrow("Invalid portable quota snapshot");
    await expect(readdir(root)).resolves.toEqual([]);
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

  it("allows a fire-and-forget append failure to be caught without an unhandled rejection", async () => {
    await mkdir(path.join(root, "snapshots", "2026-07.jsonl"), { recursive: true });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      let caught = false;
      void appendQuotaSnapshots(root, [snapshot("claude", "2026-07-01T00:00:00.000Z")])
        .catch(() => { caught = true; });
      const deadline = Date.now() + 5_000;
      while (!caught && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(caught).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
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

function serialized(event: SnapshotEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function manifestEntry(root: string, target: string, temporary: string, contents: string): {
  target: string;
  temporary: string;
  sha256: string;
} {
  return {
    target: path.relative(root, target),
    temporary: path.relative(root, temporary),
    sha256: sha256(contents),
  };
}

async function writeManifest(
  root: string,
  entries: Array<{ target: string; temporary: string; sha256: string }>,
): Promise<void> {
  await writeFile(path.join(root, "pending-quota-transaction.json"), `${JSON.stringify({
    schemaVersion: 1,
    transactionId: "00000000-0000-4000-8000-000000000010",
    entries,
  })}\n`, "utf8");
}

function runQuotaChild(vitest: string, fixture: string, root: string, childId: "a" | "b"): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [vitest, "run", fixture, "--maxWorkers=1"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        QUOTABAR_QUOTA_CHILD_ROOT: root,
        QUOTABAR_QUOTA_CHILD_ID: childId,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Portable quota child ${childId} exited with ${code}: ${output}`));
    });
  });
}

async function waitForPaths(paths: readonly string[]): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const ready = await Promise.all(paths.map(async (filePath) => {
      try {
        await access(filePath);
        return true;
      } catch {
        return false;
      }
    }));
    if (ready.every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for quota store children");
}

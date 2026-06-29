import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { seedFromDebugLogs } from "../src/main/windowRatioSeeder";

function snapLine(
  provider: string,
  fivePct: number,
  weeklyPct: number,
  ts: string,
  fiveResetsAt?: string,
  planType?: string,
): string {
  const windows = [
    { name: "fiveHour", usedPercent: fivePct, windowSeconds: 18000, ...(fiveResetsAt ? { resetsAt: fiveResetsAt } : {}) },
    { name: "weekly", usedPercent: weeklyPct, windowSeconds: 604800 },
  ];
  return JSON.stringify({
    ts,
    kind: "snapshot",
    provider,
    status: "ok",
    ...(planType !== undefined ? { planType } : {}),
    windows,
    fetchedAt: ts,
  });
}

describe("seedFromDebugLogs", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-seed-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("akkumuliert Snapshot-Paare über mehrere Tagesdateien", async () => {
    // Events are ≤ 5 min apart within a file; the cross-file pair (23:58 → 00:03)
    // is also ≤ 10 min to show that file boundaries don't matter.
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
      snapLine("codex", 0, 0, "2026-06-09T08:00:00Z"),
      snapLine("codex", 40, 6, "2026-06-09T08:05:00Z"),
      `{"ts":"2026-06-09T08:06:00Z","kind":"refresh.start","providers":["codex"],"trigger":"interval"}`,
      "nicht-json-zeile",
      snapLine("codex", 50, 7, "2026-06-09T23:58:00Z"),
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(dir, "2026-06-10.jsonl"), [
      snapLine("codex", 60, 9, "2026-06-10T00:03:00Z"),
    ].join("\n"), "utf8");

    const seed = await seedFromDebugLogs(dir);
    // pair 1: 08:00→08:05 (+40/+6); pair 2: 08:05→23:58 gap >10 min → no pair;
    // pair 3: 23:58→00:03 (5 min, cross-file) (+10/+2). Total: 50/8.
    expect(seed.providers["codex:default"].sumFivePct).toBe(50);
    expect(seed.providers["codex:default"].sumWeeklyPct).toBe(8);
    expect(seed.seededThrough).toBe("2026-06-10");
    expect(seed.providers["codex:default"].lastFive).toBeNull();
  });

  it("ignoriert .backfill.jsonl-Dateien und fremde Events", async () => {
    await fs.writeFile(path.join(dir, "2026-06-09.backfill.jsonl"),
      snapLine("codex", 0, 0, "2026-06-09T08:00:00Z"), "utf8");
    const seed = await seedFromDebugLogs(dir);
    expect(seed.providers["codex:default"]).toBeUndefined();
    expect(seed.seededThrough).toBeNull();
  });

  it("trennt Provider sauber", async () => {
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
      snapLine("claude", 0, 0, "2026-06-09T08:00:00Z"),
      snapLine("codex", 10, 1, "2026-06-09T08:00:01Z"),
      snapLine("claude", 30, 10, "2026-06-09T08:05:00Z"),
      snapLine("codex", 20, 2, "2026-06-09T08:05:01Z"),
    ].join("\n"), "utf8");
    const seed = await seedFromDebugLogs(dir);
    expect(seed.providers["claude:default"].sumFivePct).toBe(30);
    expect(seed.providers["claude:default"].sumWeeklyPct).toBe(10);
    expect(seed.providers["codex:default"].sumFivePct).toBe(10);
    expect(seed.providers["codex:default"].sumWeeklyPct).toBe(1);
  });

  it("liefert leeres Ergebnis bei fehlendem Verzeichnis", async () => {
    const seed = await seedFromDebugLogs(path.join(dir, "gibtsnicht"));
    expect(seed.providers).toEqual({});
    expect(seed.seededThrough).toBeNull();
  });

  it("getrennte Tier-Keys: zwei interleavte planTypes akkumulieren unabhängig", async () => {
    // tierA and tierB events are interleaved; each tier's consecutive events are
    // ≤ 5 min apart. The interleaved foreign-tier event must not corrupt the pair.
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
      snapLine("claude", 0, 0, "2026-06-09T08:00:00Z", undefined, "tierA"),
      snapLine("claude", 0, 0, "2026-06-09T08:01:00Z", undefined, "tierB"),
      snapLine("claude", 20, 5, "2026-06-09T08:04:00Z", undefined, "tierA"),
      snapLine("claude", 15, 3, "2026-06-09T08:05:00Z", undefined, "tierB"),
    ].join("\n"), "utf8");

    const seed = await seedFromDebugLogs(dir);
    expect(seed.providers["claude:tierA"].sumFivePct).toBe(20);
    expect(seed.providers["claude:tierA"].sumWeeklyPct).toBe(5);
    expect(seed.providers["claude:tierB"].sumFivePct).toBe(15);
    expect(seed.providers["claude:tierB"].sumWeeklyPct).toBe(3);
  });

  it("Max-Alter beim Seeding: Events > 10 min auseinander bilden kein Paar", async () => {
    // 30-min gap → no pair accumulates, but seededThrough is still set.
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
      snapLine("claude", 10, 2, "2026-06-09T08:00:00Z"),
      snapLine("claude", 40, 8, "2026-06-09T08:30:00Z"),
    ].join("\n"), "utf8");

    const seed = await seedFromDebugLogs(dir);
    expect(seed.providers["claude:default"].sumFivePct).toBe(0);
    expect(seed.providers["claude:default"].sumWeeklyPct).toBe(0);
    expect(seed.providers["claude:default"].pairCount).toBe(0);
    expect(seed.seededThrough).toBe("2026-06-09");
  });

  it("skips the current live log day to avoid double-counting with live observations", async () => {
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
      snapLine("codex", 0, 0, "2026-06-09T08:00:00Z"),
      snapLine("codex", 40, 6, "2026-06-09T08:05:00Z"),
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(dir, "2026-06-10.jsonl"), [
      snapLine("codex", 0, 0, "2026-06-10T08:00:00Z"),
      snapLine("codex", 80, 12, "2026-06-10T08:05:00Z"),
    ].join("\n"), "utf8");

    const seed = await seedFromDebugLogs(dir, new Date("2026-06-10T12:00:00.000Z"));

    expect(seed.providers["codex:default"].sumFivePct).toBe(40);
    expect(seed.seededThrough).toBe("2026-06-09");
  });
});

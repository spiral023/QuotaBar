import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { seedFromDebugLogs } from "../src/main/windowRatioSeeder";

function snapLine(provider: string, fivePct: number, weeklyPct: number, ts: string, fiveResetsAt?: string): string {
  const windows = [
    { name: "fiveHour", usedPercent: fivePct, windowSeconds: 18000, ...(fiveResetsAt ? { resetsAt: fiveResetsAt } : {}) },
    { name: "weekly", usedPercent: weeklyPct, windowSeconds: 604800 },
  ];
  return JSON.stringify({ ts, kind: "snapshot", provider, status: "ok", windows, fetchedAt: ts });
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
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
      snapLine("codex", 0, 0, "2026-06-09T08:00:00Z"),
      snapLine("codex", 40, 6, "2026-06-09T09:00:00Z"),
      `{"ts":"2026-06-09T09:01:00Z","kind":"refresh.start","providers":["codex"],"trigger":"interval"}`,
      "nicht-json-zeile",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(dir, "2026-06-10.jsonl"), [
      snapLine("codex", 60, 9, "2026-06-10T08:00:00Z"),
    ].join("\n"), "utf8");

    const seed = await seedFromDebugLogs(dir);
    expect(seed.providers.codex.sumFivePct).toBe(60);
    expect(seed.providers.codex.sumWeeklyPct).toBe(9);
    expect(seed.seededThrough).toBe("2026-06-10");
    expect(seed.providers.codex.lastFive).toBeNull();
  });

  it("ignoriert .backfill.jsonl-Dateien und fremde Events", async () => {
    await fs.writeFile(path.join(dir, "2026-06-09.backfill.jsonl"),
      snapLine("codex", 0, 0, "2026-06-09T08:00:00Z"), "utf8");
    const seed = await seedFromDebugLogs(dir);
    expect(seed.providers.codex).toBeUndefined();
    expect(seed.seededThrough).toBeNull();
  });

  it("trennt Provider sauber", async () => {
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
      snapLine("claude", 0, 0, "2026-06-09T08:00:00Z"),
      snapLine("codex", 10, 1, "2026-06-09T08:00:01Z"),
      snapLine("claude", 30, 10, "2026-06-09T09:00:00Z"),
      snapLine("codex", 20, 2, "2026-06-09T09:00:01Z"),
    ].join("\n"), "utf8");
    const seed = await seedFromDebugLogs(dir);
    expect(seed.providers.claude.sumFivePct).toBe(30);
    expect(seed.providers.claude.sumWeeklyPct).toBe(10);
    expect(seed.providers.codex.sumFivePct).toBe(10);
    expect(seed.providers.codex.sumWeeklyPct).toBe(1);
  });

  it("liefert leeres Ergebnis bei fehlendem Verzeichnis", async () => {
    const seed = await seedFromDebugLogs(path.join(dir, "gibtsnicht"));
    expect(seed.providers).toEqual({});
    expect(seed.seededThrough).toBeNull();
  });
});

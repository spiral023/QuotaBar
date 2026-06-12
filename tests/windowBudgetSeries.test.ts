import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readWeeklySeries } from "../src/main/windowBudgetSeries";

function snapLine(provider: string, fivePct: number, weeklyPct: number, ts: string, fiveResetsAt?: string, planType?: string): string {
  const windows = [
    { name: "fiveHour", usedPercent: fivePct, windowSeconds: 18000, ...(fiveResetsAt ? { resetsAt: fiveResetsAt } : {}) },
    { name: "weekly", usedPercent: weeklyPct, windowSeconds: 604800 },
  ];
  return JSON.stringify({ ts, kind: "snapshot", provider, status: "ok", ...(planType !== undefined ? { planType } : {}), windows, fetchedAt: ts });
}

describe("readWeeklySeries", () => {
  let dir: string;
  const START = new Date("2026-06-09T00:00:00.000Z").getTime();
  const NOW = new Date("2026-06-11T00:00:00.000Z").getTime();

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-series-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("bucketet Weekly-Werte auf 30-Minuten-Raster (letzter Wert gewinnt)", async () => {
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
      snapLine("claude", 5, 10, "2026-06-09T08:01:00Z"),
      snapLine("claude", 6, 11, "2026-06-09T08:15:00Z"),
      snapLine("claude", 8, 14, "2026-06-09T08:40:00Z"),
      snapLine("codex", 50, 50, "2026-06-09T08:20:00Z"),
    ].join("\n"), "utf8");

    const s = await readWeeklySeries(dir, "claude", START, NOW);
    expect(s.points).toHaveLength(2);
    expect(s.points[0].weeklyPct).toBe(11);
    expect(s.points[1].weeklyPct).toBe(14);
    expect(new Date(s.points[0].t).getTime()).toBe(new Date("2026-06-09T08:00:00Z").getTime());
  });

  it("ignoriert Snapshots außerhalb des Zeitfensters", async () => {
    await fs.writeFile(path.join(dir, "2026-06-08.jsonl"),
      snapLine("claude", 5, 10, "2026-06-08T08:00:00Z"), "utf8");
    const s = await readWeeklySeries(dir, "claude", START, NOW);
    expect(s.points).toHaveLength(0);
  });

  it("erkennt 5h-Resets über resetsAt-Wechsel", async () => {
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
      snapLine("claude", 80, 30, "2026-06-09T09:00:00Z", "2026-06-09T10:00:00Z"),
      snapLine("claude", 81, 31, "2026-06-09T09:30:00Z", "2026-06-09T10:00:00Z"),
      snapLine("claude", 2, 31, "2026-06-09T10:30:00Z", "2026-06-09T15:30:00Z"),
    ].join("\n"), "utf8");
    const s = await readWeeklySeries(dir, "claude", START, NOW);
    expect(s.fiveHourResets).toEqual(["2026-06-09T10:30:00Z"]);
  });

  it("erkennt 5h-Resets über Prozent-Einbruch, wenn resetsAt fehlt", async () => {
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
      snapLine("claude", 80, 30, "2026-06-09T09:00:00Z"),
      snapLine("claude", 2, 30, "2026-06-09T10:30:00Z"),
    ].join("\n"), "utf8");
    const s = await readWeeklySeries(dir, "claude", START, NOW);
    expect(s.fiveHourResets).toEqual(["2026-06-09T10:30:00Z"]);
  });

  it("liefert leere Serie bei fehlendem Verzeichnis", async () => {
    const s = await readWeeklySeries(path.join(dir, "nix"), "claude", START, NOW);
    expect(s.points).toEqual([]);
    expect(s.fiveHourResets).toEqual([]);
  });

  it("erkennt 5h-Reset über eine Tagesdatei-Grenze hinweg", async () => {
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"),
      snapLine("claude", 80, 30, "2026-06-09T23:30:00Z"), "utf8");
    await fs.writeFile(path.join(dir, "2026-06-10.jsonl"),
      snapLine("claude", 2, 30, "2026-06-10T00:30:00Z"), "utf8");
    const s = await readWeeklySeries(dir, "claude", START, NOW);
    expect(s.fiveHourResets).toEqual(["2026-06-10T00:30:00Z"]);
  });

  it("ignoriert Snapshots mit status != ok", async () => {
    const errLine = JSON.stringify({
      ts: "2026-06-09T08:00:00Z", kind: "snapshot", provider: "claude", status: "error",
      windows: [{ name: "weekly", usedPercent: 99, windowSeconds: 604800 }], fetchedAt: "2026-06-09T08:00:00Z",
    });
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
      errLine,
      snapLine("claude", 5, 12, "2026-06-09T09:00:00Z"),
    ].join("\n"), "utf8");
    const s = await readWeeklySeries(dir, "claude", START, NOW);
    expect(s.points).toHaveLength(1);
    expect(s.points[0].weeklyPct).toBe(12);
  });

  it("filtert nach planType: nur passende Events werden gebucketet", async () => {
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
      snapLine("claude", 5, 20, "2026-06-09T08:00:00Z", undefined, "tierA"),
      snapLine("claude", 6, 30, "2026-06-09T08:10:00Z", undefined, "tierB"),  // different planType → excluded
      snapLine("claude", 7, 40, "2026-06-09T08:20:00Z"),                       // no planType → excluded
      snapLine("claude", 8, 50, "2026-06-09T08:25:00Z", undefined, "tierA"),
    ].join("\n"), "utf8");
    const s = await readWeeklySeries(dir, "claude", START, NOW, 30, "tierA");
    // all four timestamps fall into the same 30-min bucket; last tierA value wins
    expect(s.points).toHaveLength(1);
    expect(s.points[0].weeklyPct).toBe(50);
  });

  it("Reset-Erkennung ignoriert fremde planType-Events", async () => {
    // tierA: fivePct 80, then tierB dip to 2, then tierA back to 81
    // With filter "tierA" the dip must NOT register as a reset
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
      snapLine("claude", 80, 30, "2026-06-09T09:00:00Z", undefined, "tierA"),
      snapLine("claude", 2,  30, "2026-06-09T09:30:00Z", undefined, "tierB"),  // foreign account dip
      snapLine("claude", 81, 31, "2026-06-09T10:00:00Z", undefined, "tierA"),
    ].join("\n"), "utf8");
    const s = await readWeeklySeries(dir, "claude", START, NOW, 30, "tierA");
    expect(s.fiveHourResets).toEqual([]);
    expect(s.points).toHaveLength(2);
    expect(s.points[0].weeklyPct).toBe(30);
    expect(s.points[1].weeklyPct).toBe(31);
  });

  it("ohne Filter registriert der fremde-planType-Einbruch einen Reset", async () => {
    // Same fixture as above but no planType filter → the tierB dip IS seen as a reset
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
      snapLine("claude", 80, 30, "2026-06-09T09:00:00Z", undefined, "tierA"),
      snapLine("claude", 2,  30, "2026-06-09T09:30:00Z", undefined, "tierB"),
      snapLine("claude", 81, 31, "2026-06-09T10:00:00Z", undefined, "tierA"),
    ].join("\n"), "utf8");
    const s = await readWeeklySeries(dir, "claude", START, NOW, 30);  // no filter
    expect(s.fiveHourResets).toHaveLength(1);
    expect(s.fiveHourResets[0]).toBe("2026-06-09T09:30:00Z");
  });
});

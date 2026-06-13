import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readWeeklySeries, insertBreaks, GAP_THRESHOLD_MS, WEEKLY_RESET_DROP_PCT } from "../src/main/windowBudgetSeries";

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

  it("Mikrosekunden-Jitter in fiveResetsAt erzeugt keine false-positive Resets", async () => {
    // Same reset instant re-serialized with microsecond jitter on each poll
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
      snapLine("claude", 20, 10, "2026-06-09T08:00:00Z", "2026-06-09T12:20:00.739597+00:00"),
      snapLine("claude", 30, 13, "2026-06-09T08:01:00Z", "2026-06-09T12:20:00.750574+00:00"),
      snapLine("claude", 40, 16, "2026-06-09T08:02:00Z", "2026-06-09T12:20:00.761033+00:00"),
    ].join("\n"), "utf8");
    const s = await readWeeklySeries(dir, "claude", START, NOW);
    expect(s.fiveHourResets).toHaveLength(0);
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

  // --- Artifact 1: rolling resetsAt fix ---

  it("ignoriert rollierendes resetsAt bei flacher Nutzung", async () => {
    // Codex idle: fivePct constant 1, each resetsAt = ts+5h (all >60s apart)
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
      snapLine("codex", 1, 10, "2026-06-09T08:00:00Z", "2026-06-09T13:00:00Z"),
      snapLine("codex", 1, 10, "2026-06-09T08:02:00Z", "2026-06-09T13:02:00Z"),
      snapLine("codex", 1, 10, "2026-06-09T08:04:00Z", "2026-06-09T13:04:00Z"),
      snapLine("codex", 1, 10, "2026-06-09T08:06:00Z", "2026-06-09T13:06:00Z"),
    ].join("\n"), "utf8");
    const s = await readWeeklySeries(dir, "codex", START, NOW);
    expect(s.fiveHourResets).toHaveLength(0);
  });

  it("ignoriert rollierendes resetsAt bei steigender Nutzung", async () => {
    // fivePct 1→2→3 with rolling resetsAt → no reset (usage not decreasing)
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
      snapLine("codex", 1, 10, "2026-06-09T08:00:00Z", "2026-06-09T13:00:00Z"),
      snapLine("codex", 2, 11, "2026-06-09T08:02:00Z", "2026-06-09T13:02:00Z"),
      snapLine("codex", 3, 12, "2026-06-09T08:04:00Z", "2026-06-09T13:04:00Z"),
    ].join("\n"), "utf8");
    const s = await readWeeklySeries(dir, "codex", START, NOW);
    expect(s.fiveHourResets).toHaveLength(0);
  });

  it("echter Rollover mit sinkender Nutzung wird weiter erkannt", async () => {
    // fivePct 10→3 (drop 7pp, below RESET_DROP_PCT=15) with resetsAt jumping by 5h
    // Only the resetsAt-change + decrease branch can fire here
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
      snapLine("codex", 10, 20, "2026-06-09T08:00:00Z", "2026-06-09T13:00:00Z"),
      snapLine("codex", 3,  20, "2026-06-09T13:00:00Z", "2026-06-09T18:00:00Z"),
    ].join("\n"), "utf8");
    const s = await readWeeklySeries(dir, "codex", START, NOW);
    expect(s.fiveHourResets).toHaveLength(1);
    expect(s.fiveHourResets[0]).toBe("2026-06-09T13:00:00Z");
  });

  // --- Artifact 2: weekly spike filter ---

  it("entfernt transienten weekly-Spike", async () => {
    // weekly buckets [2, 100, 5, 8] — spike at index 1 (100) should be removed
    const base = new Date("2026-06-09T08:00:00Z").getTime();
    const bucket = 30 * 60 * 1000;
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
      snapLine("claude", 5, 2,   new Date(base).toISOString()),
      snapLine("claude", 5, 100, new Date(base + bucket).toISOString()),
      snapLine("claude", 5, 5,   new Date(base + 2 * bucket).toISOString()),
      snapLine("claude", 5, 8,   new Date(base + 3 * bucket).toISOString()),
    ].join("\n"), "utf8");
    const s = await readWeeklySeries(dir, "claude", START, NOW);
    expect(s.points).toHaveLength(3);
    expect(s.points.map((p) => p.weeklyPct)).toEqual([2, 5, 8]);
  });

  it("entfernt Spike am Serienanfang", async () => {
    // [100, 5, 8] → first point removed (only right neighbor: 5, spike delta=95)
    const base = new Date("2026-06-09T08:00:00Z").getTime();
    const bucket = 30 * 60 * 1000;
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
      snapLine("claude", 5, 100, new Date(base).toISOString()),
      snapLine("claude", 5, 5,   new Date(base + bucket).toISOString()),
      snapLine("claude", 5, 8,   new Date(base + 2 * bucket).toISOString()),
    ].join("\n"), "utf8");
    const s = await readWeeklySeries(dir, "claude", START, NOW);
    expect(s.points).toHaveLength(2);
    expect(s.points.map((p) => p.weeklyPct)).toEqual([5, 8]);
  });

  it("behält echtes schnelles Wachstum", async () => {
    // [10, 60, 65] — 60 exceeds left by 50 but right neighbor 65 is also high
    const base = new Date("2026-06-09T08:00:00Z").getTime();
    const bucket = 30 * 60 * 1000;
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
      snapLine("claude", 5, 10,  new Date(base).toISOString()),
      snapLine("claude", 5, 60,  new Date(base + bucket).toISOString()),
      snapLine("claude", 5, 65,  new Date(base + 2 * bucket).toISOString()),
    ].join("\n"), "utf8");
    const s = await readWeeklySeries(dir, "claude", START, NOW);
    expect(s.points).toHaveLength(3);
    expect(s.points.map((p) => p.weeklyPct)).toEqual([10, 60, 65]);
  });
});

describe("insertBreaks", () => {
  const pt = (t: string, weeklyPct: number | null) => ({ t, weeklyPct });

  it("exportiert sinnvolle Schwellen", () => {
    expect(GAP_THRESHOLD_MS).toBe(60 * 60_000);
    expect(WEEKLY_RESET_DROP_PCT).toBe(15);
  });

  it("fügt Bruch bei großer Zeitlücke ein (auch ohne Sturz)", () => {
    const r = insertBreaks([
      pt("2026-06-12T08:00:00Z", 10),
      pt("2026-06-12T10:00:00Z", 12),
    ]);
    expect(r.map((p) => p.weeklyPct)).toEqual([10, null, 12]);
  });

  it("fügt Bruch bei Weekly-Sturz ein", () => {
    const r = insertBreaks([
      pt("2026-06-12T08:00:00Z", 67),
      pt("2026-06-12T08:30:00Z", 1),
    ]);
    expect(r.map((p) => p.weeklyPct)).toEqual([67, null, 1]);
  });

  it("kein Bruch bei dichten, monotonen Daten", () => {
    const r = insertBreaks([
      pt("2026-06-12T08:00:00Z", 10),
      pt("2026-06-12T08:30:00Z", 12),
      pt("2026-06-12T09:00:00Z", 15),
    ]);
    expect(r.map((p) => p.weeklyPct)).toEqual([10, 12, 15]);
  });

  it("kein Bruch bei einzelnem verpasstem Poll (< 60 min)", () => {
    const r = insertBreaks([
      pt("2026-06-12T08:00:00Z", 10),
      pt("2026-06-12T08:45:00Z", 11),
    ]);
    expect(r).toHaveLength(2);
  });

  it("gibt leere/einelementige Serie unverändert zurück", () => {
    expect(insertBreaks([])).toEqual([]);
    expect(insertBreaks([pt("2026-06-12T08:00:00Z", 5)])).toHaveLength(1);
  });
});

import { describe, expect, it, vi } from "vitest";
import { runAnalyticsTask, type WindowBudgetData } from "../src/main/analyticsWorker";
import type { SnapshotEvent } from "../src/main/debugEvents";

vi.mock("../src/portable/quotaStore", () => ({
  readQuotaSnapshots: vi.fn(async () => []),
}));

const NOW_MS = Date.parse("2026-09-06T00:00:00.000Z");
const WEEKLY_RESETS_AT = "2026-09-12T13:11:14.000Z";

/** Codex-Snapshot der größeren Tarife: nur ein 7d-Fenster, kein 5h-Fenster. */
function weeklyOnlySnapshot(fetchedAt: string, usedPercent: number, resetsAt = WEEKLY_RESETS_AT): SnapshotEvent {
  return {
    kind: "snapshot",
    provider: "codex",
    status: "ok",
    planType: "self_serve_business_prolite",
    windows: [{ name: "weekly", usedPercent, windowSeconds: 604800, resetsAt }],
    fetchedAt,
  };
}

async function buildData(snapshots: SnapshotEvent[]): Promise<WindowBudgetData> {
  return await runAnalyticsTask({
    task: "windowBudget",
    nowMs: NOW_MS,
    providers: [{
      provider: "codex",
      weeklyUsedPercent: 92,
      weeklyResetsAt: WEEKLY_RESETS_AT,
      windowsPerWeek: null,
      burnRatePctPerHour: null,
      pace: null,
      planType: "self_serve_business_prolite",
    }],
  }, {
    usageEvents: [],
    readQuotaSnapshots: async () => snapshots,
  }) as WindowBudgetData;
}

describe("windowBudget series without a five-hour window", () => {
  it("builds a weekly series from weekly-only snapshots", async () => {
    const data = await buildData([
      weeklyOnlySnapshot("2026-09-05T21:00:00.000Z", 60),
      weeklyOnlySnapshot("2026-09-05T21:30:00.000Z", 75),
      weeklyOnlySnapshot("2026-09-05T22:00:00.000Z", 92),
    ]);

    const codex = data.perProvider.codex;
    expect(codex.hasSeriesData).toBe(true);
    expect(codex.series.points.map((p) => p.weeklyPct)).toEqual([60, 75, 92]);
    // Ohne 5h-Fenster gibt es weder Reset-Marker noch eine Fenster-Umrechnung.
    expect(codex.series.fiveHourResets).toEqual([]);
    expect(codex.currentUsage).toBeNull();
  });

  it("breaks the line at a reset instead of drawing a drop", async () => {
    const data = await buildData([
      weeklyOnlySnapshot("2026-09-05T20:30:00.000Z", 88),
      weeklyOnlySnapshot("2026-09-05T21:00:00.000Z", 92),
      // Kulanz-/eingelöster Reset: Verbrauch fällt auf ~0.
      weeklyOnlySnapshot("2026-09-05T21:30:00.000Z", 1),
      weeklyOnlySnapshot("2026-09-05T22:00:00.000Z", 6),
    ]);

    // Der Null-Punkt unterbricht Linie und Fläche am Reset (spanGaps: false).
    const values = data.perProvider.codex.series.points.map((p) => p.weeklyPct);
    expect(values).toEqual([88, 92, null, 1, 6]);
  });

  it("ignores snapshots from a different plan tier", async () => {
    const data = await buildData([
      { ...weeklyOnlySnapshot("2026-09-05T21:00:00.000Z", 40), planType: "team" },
      weeklyOnlySnapshot("2026-09-05T21:30:00.000Z", 75),
    ]);

    expect(data.perProvider.codex.series.points.map((p) => p.weeklyPct)).toEqual([75]);
  });

  it("still forecasts from the weekly window alone", async () => {
    const data = await buildData([
      weeklyOnlySnapshot("2026-09-05T21:30:00.000Z", 60),
      weeklyOnlySnapshot("2026-09-05T22:00:00.000Z", 92),
    ]);

    expect(data.perProvider.codex.forecast).toBeDefined();
  });
});

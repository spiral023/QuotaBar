import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type UsageWindow = {
  name: string;
  usedPercent?: number;
  resetsAt?: string;
  windowSeconds?: number;
};
type WindowBudget = {
  learning?: boolean;
  weeklyOnly?: boolean;
  windowsPerWeek?: number;
  usedWindows?: number;
  remainingWindows?: number;
  sampleFivePct?: number;
  bonus?: { active: boolean; estimatedExtraWindows: number };
};
type Snapshot = {
  provider: string;
  status: string;
  windows: UsageWindow[];
  identity?: { email?: string };
  windowBudget?: WindowBudget;
};

function loadLiveHelpers(): {
  effectiveUsageWindow: (fiveH?: UsageWindow, weekly?: UsageWindow) => UsageWindow | null;
  effectiveUsageLabel: (win?: UsageWindow | null) => string;
  orderSnapshots: (snapshots: Snapshot[], order: string[]) => Snapshot[];
  renderStandard: (snapshot: Snapshot, name: string, delay: string, accountIndex: number) => string;
} {
  const qb = {
    esc: (value: unknown) => String(value),
    usageColor: () => "green",
    accentVar: () => "var(--green)",
    formatCountdown: () => "1h 00m",
    fmtTokens: (value: unknown) => String(value),
    settings: {},
  };
  const context = vm.createContext({
    window: { QB: qb },
    QB: qb,
    console,
    setInterval,
    clearInterval,
  });
  const script = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "tabs", "live.js"), "utf8");
  vm.runInContext(script, context);
  return (context.QB as any).__liveTest;
}

describe("live renderer helpers", () => {
  it("keeps preparing window budgets out of the hydration cache", () => {
    const script = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "tabs", "live.js"), "utf8");
    expect(script).toMatch(/windowBudget:get[\s\S]{0,220}isPortableDataPreparing\(data\)/);
  });

  it("uses the weekly window as effective card usage when weekly is the limiting quota", () => {
    const helpers = loadLiveHelpers();
    const fiveHour = { name: "fiveHour", usedPercent: 12 };
    const weekly = { name: "weekly", usedPercent: 100 };

    expect(helpers.effectiveUsageWindow(fiveHour, weekly)).toBe(weekly);
    expect(helpers.effectiveUsageLabel(weekly)).toBe("Wk 100%");
  });

  it("keeps the five-hour window as effective card usage when it is higher", () => {
    const helpers = loadLiveHelpers();
    const fiveHour = { name: "fiveHour", usedPercent: 80 };
    const weekly = { name: "weekly", usedPercent: 40 };

    expect(helpers.effectiveUsageWindow(fiveHour, weekly)).toBe(fiveHour);
    expect(helpers.effectiveUsageLabel(fiveHour)).toBe("5h 80%");
  });

  it("returns null when neither quota window has a percentage", () => {
    const helpers = loadLiveHelpers();

    expect(helpers.effectiveUsageWindow({ name: "fiveHour" }, { name: "weekly" })).toBeNull();
    expect(helpers.effectiveUsageLabel(null)).toBe("—");
  });

  it("orders healthy and authentication-error cards from settings", () => {
    const helpers = loadLiveHelpers();
    const snapshots = [
      { provider: "claude", status: "ok", windows: [] },
      { provider: "codex", status: "not_authenticated", windows: [] },
    ];

    expect(helpers.orderSnapshots(snapshots, ["codex", "claude"])
      .map((snapshot) => snapshot.provider)).toEqual(["codex", "claude"]);
    expect(snapshots.map((snapshot) => snapshot.provider)).toEqual(["claude", "codex"]);
  });

  it("renders a weekly-only Codex snapshot without a five-hour row", () => {
    const helpers = loadLiveHelpers();
    const html = helpers.renderStandard({
      provider: "codex",
      status: "ok",
      windows: [{ name: "weekly", usedPercent: 1 }],
    }, "Codex", "", 1);

    expect(html).toContain("Wk 1%");
    expect(html).toContain("Weekly");
    expect(html).not.toContain("5-Hour");
  });

  it("renders the weekly trend chart for a weekly-only budget", () => {
    const helpers = loadLiveHelpers();
    const html = helpers.renderStandard({
      provider: "codex",
      status: "ok",
      windows: [{ name: "weekly", usedPercent: 92 }],
      windowBudget: { learning: false, weeklyOnly: true },
    }, "Codex", "", 1);

    // Chart-Canvas + Forecast-Slot müssen da sein, damit hydrateWindowBudgets füllen kann.
    expect(html).toContain('id="wb-chart-codex"');
    expect(html).toContain('id="wb-forecast-codex"');
    // Ohne 5h-Fenster kein Fenster-Budget-Versprechen im Titel …
    expect(html).toContain("Weekly trend");
    expect(html).not.toContain("Window budget");
    // … und keine 5h-Fenster-Leiste.
    expect(html).not.toContain("5h windows:");
    expect(html).not.toContain("still learning");
  });

  it("shows a bonus badge without a window estimate for a weekly-only budget", () => {
    const helpers = loadLiveHelpers();
    const html = helpers.renderStandard({
      provider: "codex",
      status: "ok",
      windows: [{ name: "weekly", usedPercent: 2 }],
      windowBudget: {
        learning: false,
        weeklyOnly: true,
        bonus: { active: true, estimatedExtraWindows: 0 },
      },
    }, "Codex", "", 1);

    expect(html).toContain("Bonus week");
    expect(html).not.toContain("5h windows");
  });

  it("keeps the window budget label and bar when a ratio is known", () => {
    const helpers = loadLiveHelpers();
    const html = helpers.renderStandard({
      provider: "claude",
      status: "ok",
      windows: [
        { name: "fiveHour", usedPercent: 12 },
        { name: "weekly", usedPercent: 34 },
      ],
      windowBudget: {
        learning: false,
        windowsPerWeek: 10,
        usedWindows: 3.4,
        remainingWindows: 6.6,
        sampleFivePct: 400,
      },
    }, "Claude", "", 1);

    expect(html).toContain("Window budget");
    expect(html).not.toContain("Weekly trend");
    expect(html).toContain("5h windows: 3.4 used");
  });

  it("renders both quota rows when five-hour and weekly windows are available", () => {
    const helpers = loadLiveHelpers();
    const html = helpers.renderStandard({
      provider: "codex",
      status: "ok",
      windows: [
        { name: "fiveHour", usedPercent: 12 },
        { name: "weekly", usedPercent: 34 },
      ],
    }, "Codex", "", 1);

    expect(html).toContain("5-Hour");
    expect(html).toContain("Weekly");
  });

  it("preserves an incomplete five-hour row alongside the weekly row", () => {
    const helpers = loadLiveHelpers();
    const html = helpers.renderStandard(
      {
        provider: "codex",
        status: "ok",
        windows: [
          {
            name: "fiveHour",
            resetsAt: "2026-07-12T22:00:00.000Z",
            windowSeconds: 18_000,
          },
          { name: "weekly", usedPercent: 34 },
        ],
      },
      "Codex",
      "",
      1,
    );

    expect(html).toContain("5-Hour");
    expect(html).toContain("Weekly");
  });
});

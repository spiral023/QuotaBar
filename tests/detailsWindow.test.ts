import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../src/config/settings";

// Mock Electron — DetailsWindowController calls ipcMain.on and may use other
// Electron APIs at import/construction time. Provide just enough surface to
// allow construction without a running Electron runtime.
vi.mock("electron", () => {
  const ipcMain = {
    on: vi.fn(),
    handle: vi.fn(),
  };
  return {
    ipcMain,
    app: {
      isPackaged: false,
      getVersion: vi.fn(() => "1.1.4"),
      getPath: vi.fn(),
    },
    BrowserWindow: class {},
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    Tray: class {},
    clipboard: { writeText: vi.fn() },
    shell: { openPath: vi.fn(), openExternal: vi.fn() },
  };
});

import { DebugRecorder } from "../src/main/debugRecorder";
import {
  createAnalyticsGetRequest,
  createAnalyticsSummaryRequest,
  DetailsWindowController,
  portableDataIsReady,
} from "../src/main/detailsWindow";
import { ipcMain, shell } from "electron";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-dw-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("DetailsWindowController dashboard.refreshRequested", () => {
  it("emits dashboard.refreshRequested before invoking the callback", async () => {
    const recorder = new DebugRecorder({ enabled: true, logDir: tmpDir });
    const controller = new DetailsWindowController(() => null, recorder);
    const callback = vi.fn();
    (controller as unknown as { handleDashboardRefresh: (cb: () => void) => void })
      .handleDashboardRefresh(callback);
    await recorder.flush();
    expect(callback).toHaveBeenCalledOnce();
    const files = await fs.readdir(tmpDir);
    const content = await fs.readFile(path.join(tmpDir, files[0]), "utf8");
    const events = content.trim().split("\n").map((l) => JSON.parse(l));
    expect(events.some((e) => e.kind === "dashboard.refreshRequested")).toBe(true);
  });
});

describe("analytics summary worker request", () => {
  it("does not include provider history directories", () => {
    const request = createAnalyticsSummaryRequest({
      ...defaultSettings,
      claudeRoots: ["must-not-resolve"],
      codexHomes: ["must-not-resolve"],
    }, "30d", { claude: 0, codex: 0 });

    expect(request).not.toHaveProperty("claudeProjectsDirs");
    expect(request).not.toHaveProperty("codexSessionsDirs");
  });

  it("includes a stable summary period end", () => {
    const nowMs = Date.parse("2026-07-13T12:34:56.789Z");
    const request = createAnalyticsSummaryRequest(defaultSettings, "7d", { claude: 0, codex: 0 }, nowMs);

    expect(request.periodEndMs).toBe(nowMs);
    expect(request.periodStartMs).toBeLessThan(nowMs);
  });
});

describe("portable analytics readiness", () => {
  it("gates every portable endpoint before worker or store reads", async () => {
    const runWorker = vi.fn(async () => { throw new Error("portable store read must not run"); });
    new DetailsWindowController(() => null, undefined, undefined, {
      portableDataIsReady: vi.fn(async () => false),
      runAnalyticsWorker: runWorker,
    });
    const calls = (ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const findHandler = (channel: string) => [...calls].reverse().find((call: unknown[]) => call[0] === channel)?.[1] as
      ((event: unknown, request?: unknown) => Promise<unknown>);
    for (const channel of ["analytics:summary", "analytics:get", "models:get", "windowBudget:get", "windowHistory:get"]) {
      await expect(findHandler(channel)({}, undefined)).resolves.toEqual({ portableDataPreparing: true });
    }
    expect(runWorker).not.toHaveBeenCalled();
  });

  it("prewarms explicit bounded usage and quota ranges only when ready", async () => {
    const runWorker = vi.fn(async () => ({}));
    const controller = new DetailsWindowController(() => null, undefined, undefined, {
      portableDataIsReady: vi.fn(async () => true),
      runAnalyticsWorker: runWorker,
      loadRuntimeSettings: vi.fn(async () => defaultSettings),
      now: () => Date.parse("2026-07-13T12:00:00.000Z"),
    });
    controller.prewarmAnalytics();
    await vi.waitFor(() => expect(runWorker).toHaveBeenCalled());
    expect(runWorker).toHaveBeenCalledWith(expect.objectContaining({
      task: "prewarm",
      usageRange: { since: "2026-06-13T12:00:00.000Z", until: "2026-07-13T12:00:00.000Z" },
      quotaRange: { since: "2026-06-13T12:00:00.000Z", until: "2026-07-13T12:00:00.000Z" },
    }));
  });

  it("treats missing, pending and malformed migration state as preparing", async () => {
    const statePath = path.join(tmpDir, "migration-state.json");
    await expect(portableDataIsReady(statePath)).resolves.toBe(false);
    await fs.writeFile(statePath, JSON.stringify({ status: "pending" }));
    await expect(portableDataIsReady(statePath)).resolves.toBe(false);
    await fs.writeFile(statePath, "not-json");
    await expect(portableDataIsReady(statePath)).resolves.toBe(false);
  });

  it("accepts only a complete migration state", async () => {
    const statePath = path.join(tmpDir, "migration-state.json");
    await fs.writeFile(statePath, JSON.stringify({ status: "complete" }));
    await expect(portableDataIsReady(statePath)).resolves.toBe(true);
  });

  it("creates analytics worker requests without provider directories or debug logs", () => {
    const request = createAnalyticsGetRequest(
      defaultSettings,
      { since: "2026-07-01", until: "2026-07-13" },
      { claude: 10, codex: 20 },
      Date.parse("2026-07-13T12:00:00.000Z"),
      {},
      false,
    );
    expect(request).not.toHaveProperty("claudeProjectsDirs");
    expect(request).not.toHaveProperty("codexSessionsDirs");
    expect(request).not.toHaveProperty("logDir");
    expect(request).toMatchObject({ task: "get", since: "2026-07-01", until: "2026-07-13" });
  });

  it.each([
    ["spring-forward", "2026-03-08", "2026-03-08T05:00:00.000Z", "2026-03-09T03:59:59.999Z", 23],
    ["fall-back", "2026-11-01", "2026-11-01T04:00:00.000Z", "2026-11-02T04:59:59.999Z", 25],
  ])("bounds a New York %s custom day to its local calendar day", (_label, day, sinceIso, untilIso, hours) => {
    const request = createAnalyticsGetRequest(defaultSettings, { since: day, until: day, timeZone: "America/New_York" }, { claude: 0, codex: 0 }, Date.parse("2026-12-01T00:00:00.000Z"), {}, false);
    expect(request.usageRange).toEqual({ since: sinceIso, until: untilIso });
    expect(request.quotaRange).toEqual({ since: sinceIso, until: untilIso });
    expect((Date.parse(untilIso) + 1 - Date.parse(sinceIso)) / 3_600_000).toBe(hours);
  });

  it("includes the local evening through the exact historical custom end instant", () => {
    const request = createAnalyticsGetRequest(defaultSettings, { since: "2026-07-10", until: "2026-07-10", timeZone: "America/New_York" }, { claude: 0, codex: 0 }, Date.parse("2026-12-01T00:00:00.000Z"), {}, false);
    expect(request.usageRange).toEqual({ since: "2026-07-10T04:00:00.000Z", until: "2026-07-11T03:59:59.999Z" });
    expect(Date.parse((request.usageRange as { until: string }).until)).toBeGreaterThan(Date.parse("2026-07-11T03:00:00.000Z"));
  });

  it("allowlists worker settings without roots or unrelated configuration", () => {
    const request = createAnalyticsGetRequest({ ...defaultSettings, claudeRoots: ["C:/secret/claude"], codexHomes: ["C:/secret/codex"] }, undefined, { claude: 0, codex: 0 }, Date.now(), {}, false);
    expect(JSON.stringify(request)).not.toMatch(/claudeRoots|codexHomes|C:\/secret/);
    expect(request.settings).toEqual({ plans: defaultSettings.plans, pricingOfflineMode: defaultSettings.pricingOfflineMode, minModelTokenSharePct: defaultSettings.minModelTokenSharePct });
  });
});

describe("DetailsWindowController system IPC", () => {
  it("registers app metadata, system data, and path-opening handlers", () => {
    new DetailsWindowController(() => null);

    const channels = (ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => call[0]);

    expect(channels).toContain("app:meta");
    expect(channels).toContain("system:get");
    expect(channels).toContain("system:claude-roots:suggest");
    expect(channels).toContain("system:codex-homes:suggest");
    expect(channels).toContain("system:open-path");
  });

  it("opens the Artificial Analysis methodology in the external browser", async () => {
    new DetailsWindowController(() => null);

    const handler = (ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mock.calls
      .find((call: unknown[]) => call[0] === "shell:open-url")?.[1] as
        | ((event: unknown, url: unknown) => Promise<{ ok: boolean }>)
        | undefined;

    const result = await handler?.({}, "https://artificialanalysis.ai/methodology/intelligence-benchmarking");

    expect(result).toEqual({ ok: true });
    expect(shell.openExternal).toHaveBeenCalledWith("https://artificialanalysis.ai/methodology/intelligence-benchmarking");
  });

  it("opens the Coding Agent methodology in the external browser", async () => {
    new DetailsWindowController(() => null);

    const handler = (ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mock.calls
      .find((call: unknown[]) => call[0] === "shell:open-url")?.[1] as
        | ((event: unknown, url: unknown) => Promise<{ ok: boolean }>)
        | undefined;

    const result = await handler?.({}, "https://artificialanalysis.ai/methodology/coding-agents-benchmarking");

    expect(result).toEqual({ ok: true });
    expect(shell.openExternal).toHaveBeenCalledWith("https://artificialanalysis.ai/methodology/coding-agents-benchmarking");
  });
});

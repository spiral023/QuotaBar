import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../src/config/settings";

const archiveMocks = vi.hoisted(() => ({
  exportPortableData: vi.fn(),
  stagePortableImport: vi.fn(),
}));

vi.mock("../src/portable/archiveService", () => archiveMocks);

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
      relaunch: vi.fn(),
      exit: vi.fn(),
    },
    BrowserWindow: class {},
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    Tray: class {},
    clipboard: { writeText: vi.fn() },
    shell: { openPath: vi.fn(), openExternal: vi.fn() },
    dialog: {
      showSaveDialog: vi.fn(),
      showOpenDialog: vi.fn(),
    },
  };
});

import { DebugRecorder } from "../src/main/debugRecorder";
import {
  createAnalyticsGetRequest,
  createAnalyticsSummaryRequest,
  DetailsWindowController,
  portableDataIsReady,
} from "../src/main/detailsWindow";
import { app, dialog, ipcMain, shell } from "electron";
import { PortableUsageStore } from "../src/portable/usageStore";
import { preparePortableData } from "../src/main/debugBackfill";
import { markMigrationComplete, markMigrationFailed, markMigrationRunning } from "../src/portable/migration";

let tmpDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
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
    await controller.prewarmAnalytics();
    expect(runWorker).toHaveBeenCalledWith(expect.objectContaining({
      task: "prewarm",
      usageRange: { since: "2026-06-13T12:00:00.000Z", until: "2026-07-13T12:00:00.000Z" },
      quotaRange: { since: "2026-06-13T12:00:00.000Z", until: "2026-07-13T12:00:00.000Z" },
    }));
  });

  it("propagates real prewarm worker failures to startup", async () => {
    const controller = new DetailsWindowController(() => null, undefined, undefined, {
      portableDataIsReady: vi.fn(async () => true),
      runAnalyticsWorker: vi.fn(async () => { throw new Error("raw worker detail"); }),
      now: () => Date.parse("2026-07-13T12:00:00.000Z"),
    });

    await expect(controller.prewarmAnalytics()).rejects.toThrow("raw worker detail");
  });

  it("propagates readiness read failures to startup", async () => {
    const controller = new DetailsWindowController(() => null, undefined, undefined, {
      portableDataIsReady: vi.fn(async () => { throw new Error("read failed"); }),
      runAnalyticsWorker: vi.fn(async () => ({})),
    });

    await expect(controller.prewarmAnalytics()).rejects.toThrow("read failed");
  });

  it("rejects prewarm when revision readiness changed before the worker request", async () => {
    const runWorker = vi.fn(async () => ({}));
    const controller = new DetailsWindowController(() => null, undefined, undefined, {
      portableDataIsReady: vi.fn(async () => false),
      runAnalyticsWorker: runWorker,
    });

    await expect(controller.prewarmAnalytics()).rejects.toThrow("Portable analytics prewarm is not ready");
    expect(runWorker).not.toHaveBeenCalled();
  });

  it("persists consumer_prewarm_failed when the real controller worker rejects", async () => {
    const statePath = path.join(tmpDir, "migration-state.json");
    const store = new PortableUsageStore(tmpDir);
    const controller = new DetailsWindowController(() => null, undefined, undefined, {
      portableDataIsReady: vi.fn(async () => true),
      runAnalyticsWorker: vi.fn(async () => { throw new Error("raw worker detail"); }),
      now: () => Date.parse("2026-07-13T12:00:00.000Z"),
    });

    await expect(preparePortableData({
      beginMigration: () => markMigrationRunning(statePath),
      ingestProviderEvents: async () => ({ inserted: 0, updated: 0 }),
      readLegacyRecords: async () => [],
      reconcileLegacy: async () => ({
        storeRevision: await store.getRevision(), syntheticInserted: 0, syntheticUpdated: 0,
      }),
      readLegacyQuota: async () => [],
      migrateQuota: async () => undefined,
      completeMigration: (revision) => markMigrationComplete(statePath, revision, store),
      failMigration: (code, expectation) => markMigrationFailed(statePath, code, expectation, store),
      prewarmConsumers: () => controller.prewarmAnalytics(),
    })).rejects.toThrow("Portable data preparation failed at consumer_prewarm");
    expect(JSON.parse(await fs.readFile(statePath, "utf8"))).toMatchObject({
      status: "failed", lastError: "consumer_prewarm_failed",
    });
  });

  it("does not let an older prewarm failure overwrite a newer running migration", async () => {
    const statePath = path.join(tmpDir, "migration-state.json");
    const store = new PortableUsageStore(tmpDir);
    const revision = await store.getRevision();
    const controller = new DetailsWindowController(() => null, undefined, undefined, {
      portableDataIsReady: vi.fn(async () => true),
      runAnalyticsWorker: vi.fn(async () => {
        await markMigrationRunning(statePath, () => new Date("2026-07-13T12:00:01.000Z"));
        throw new Error("raw worker detail");
      }),
      now: () => Date.parse("2026-07-13T12:00:00.000Z"),
    });

    const result = await preparePortableData({
      beginMigration: () => markMigrationRunning(statePath),
      ingestProviderEvents: async () => ({ inserted: 0, updated: 0 }),
      readLegacyRecords: async () => [],
      reconcileLegacy: async () => ({ storeRevision: revision, syntheticInserted: 0, syntheticUpdated: 0 }),
      readLegacyQuota: async () => [],
      migrateQuota: async () => undefined,
      completeMigration: (current) => markMigrationComplete(statePath, current, store),
      failMigration: (code, expectation) => markMigrationFailed(statePath, code, expectation, store),
      prewarmConsumers: () => controller.prewarmAnalytics(),
    });

    expect(result).toEqual({ status: "superseded" });
    expect(JSON.parse(await fs.readFile(statePath, "utf8"))).toMatchObject({
      status: "running",
      updatedAt: "2026-07-13T12:00:01.000Z",
    });
    await expect(markMigrationComplete(statePath, revision, store)).resolves.toEqual({ status: "applied" });
  });

  it("treats missing, pending and malformed migration state as preparing", async () => {
    const statePath = path.join(tmpDir, "migration-state.json");
    await expect(portableDataIsReady(statePath)).resolves.toBe(false);
    await fs.writeFile(statePath, JSON.stringify({ status: "pending" }));
    await expect(portableDataIsReady(statePath)).resolves.toBe(false);
    await fs.writeFile(statePath, "not-json");
    await expect(portableDataIsReady(statePath)).resolves.toBe(false);
  });

  it("accepts a complete migration state only while its usage revision still matches", async () => {
    const statePath = path.join(tmpDir, "migration-state.json");
    const store = new PortableUsageStore(tmpDir);
    const revision = await store.getRevision();
    await fs.writeFile(statePath, JSON.stringify({
      schemaVersion: 1,
      status: "complete",
      usageMigrationVersion: 1,
      storeRevision: revision,
      updatedAt: "2026-07-13T12:00:00.000Z",
    }));
    await expect(portableDataIsReady(statePath)).resolves.toBe(true);
    await store.upsert([{
      schemaVersion: 1, id: "newer", provider: "claude", occurredAt: "2026-07-13T12:00:00.000Z",
      model: "model", sessionKey: "session", source: "claude-log", synthetic: false,
      inputTokens: 1, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningOutputTokens: 0,
    }]);
    await expect(portableDataIsReady(statePath)).resolves.toBe(false);
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
    expect(channels).toContain("system:export-portable-data");
    expect(channels).toContain("system:import-portable-data");
  });

  it.each([
    ["system:export-portable-data", "showSaveDialog"],
    ["system:import-portable-data", "showOpenDialog"],
  ] as const)("returns a stable cancellation result from %s", async (channel, dialogMethod) => {
    if (dialogMethod === "showSaveDialog") {
      vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: true, filePath: "" });
    } else {
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] });
    }
    new DetailsWindowController(() => null);

    const handler = findIpcHandler(channel);

    await expect(handler({})).resolves.toEqual({ ok: false, cancelled: true });
    expect(archiveMocks.exportPortableData).not.toHaveBeenCalled();
    expect(archiveMocks.stagePortableImport).not.toHaveBeenCalled();
  });

  it("exports portable data to the selected zip", async () => {
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: "C:\\Exports\\QuotaBar.zip" });
    archiveMocks.exportPortableData.mockResolvedValue({
      path: "C:\\Exports\\QuotaBar.zip",
      fileCount: 4,
      totalBytes: 128,
    });
    new DetailsWindowController(() => null);

    await expect(findIpcHandler("system:export-portable-data")({})).resolves.toEqual({
      ok: true,
      path: "C:\\Exports\\QuotaBar.zip",
      fileCount: 4,
      totalBytes: 128,
    });
    expect(dialog.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({
      defaultPath: expect.stringMatching(/\.zip$/),
      filters: [{ name: "ZIP archives", extensions: ["zip"] }],
    }));
    expect(archiveMocks.exportPortableData).toHaveBeenCalledWith(
      expect.stringMatching(/\.quotabar-win$/),
      "C:\\Exports\\QuotaBar.zip",
    );
  });

  it("stages an import, returns its verified backup, then restarts after the response flushes", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: ["C:\\Imports\\QuotaBar.zip"] });
      archiveMocks.stagePortableImport.mockResolvedValue({
        path: "C:\\Imports\\QuotaBar.zip",
        backupPath: "C:\\QuotaBar Backups\\verified.zip",
        pending: true,
        fileCount: 3,
        totalBytes: 96,
      });
      new DetailsWindowController(() => null);

      const result = await findIpcHandler("system:import-portable-data")({});

      expect(result).toEqual({
        ok: true,
        backupPath: "C:\\QuotaBar Backups\\verified.zip",
        fileCount: 3,
        totalBytes: 96,
        restartScheduled: true,
      });
      expect(archiveMocks.stagePortableImport).toHaveBeenCalledWith(
        "C:\\Imports\\QuotaBar.zip",
        expect.stringMatching(/\.quotabar-win$/),
        expect.any(String),
      );
      expect(app.relaunch).not.toHaveBeenCalled();
      expect(app.exit).not.toHaveBeenCalled();

      await vi.runAllTimersAsync();

      expect(app.relaunch).toHaveBeenCalledOnce();
      expect(app.exit).toHaveBeenCalledWith(0);
      expect(vi.mocked(app.relaunch).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(app.exit).mock.invocationCallOrder[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows only one portable archive operation at a time", async () => {
    let finishExport!: (value: { path: string; fileCount: number; totalBytes: number }) => void;
    archiveMocks.exportPortableData.mockImplementation(() => new Promise((resolve) => { finishExport = resolve; }));
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: "C:\\Exports\\QuotaBar.zip" });
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: ["C:\\Imports\\QuotaBar.zip"] });
    new DetailsWindowController(() => null);

    const exporting = findIpcHandler("system:export-portable-data")({});
    await vi.waitFor(() => expect(archiveMocks.exportPortableData).toHaveBeenCalledOnce());

    await expect(findIpcHandler("system:import-portable-data")({})).resolves.toEqual({
      ok: false,
      error: "archive_operation_in_progress",
      message: "Another portable archive operation is already in progress.",
    });
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
    expect(archiveMocks.stagePortableImport).not.toHaveBeenCalled();

    finishExport({ path: "C:\\Exports\\QuotaBar.zip", fileCount: 1, totalBytes: 1 });
    await exporting;
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

function findIpcHandler(channel: string): (event: unknown) => Promise<unknown> {
  const handler = (ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mock.calls
    .findLast((call: unknown[]) => call[0] === channel)?.[1];
  if (typeof handler !== "function") throw new Error(`Missing IPC handler: ${channel}`);
  return handler as (event: unknown) => Promise<unknown>;
}

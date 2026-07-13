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
import { createAnalyticsSummaryRequest, DetailsWindowController } from "../src/main/detailsWindow";
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

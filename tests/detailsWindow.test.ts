import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    BrowserWindow: class {},
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    Tray: class {},
    clipboard: { writeText: vi.fn() },
    shell: { openPath: vi.fn() },
  };
});

import { DebugRecorder } from "../src/main/debugRecorder";
import { DetailsWindowController } from "../src/main/detailsWindow";
import { ipcMain } from "electron";

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

describe("DetailsWindowController system IPC", () => {
  it("registers system data and path-opening handlers", () => {
    new DetailsWindowController(() => null);

    const channels = (ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => call[0]);

    expect(channels).toContain("system:get");
    expect(channels).toContain("system:open-path");
  });
});

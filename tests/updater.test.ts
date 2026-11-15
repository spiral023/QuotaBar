import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: { isPackaged: true, getVersion: () => "2.4.0" },
  events: new Map<string, (...args: any[]) => void>(), handlers: new Map<string, () => unknown>(),
  updater: { on: vi.fn(), checkForUpdates: vi.fn(), quitAndInstall: vi.fn(), autoDownload: true, autoInstallOnAppQuit: true },
  log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("electron", () => ({ app: mocks.app }));
vi.mock("electron-updater", () => ({ autoUpdater: mocks.updater }));
vi.mock("../src/main/logging", () => ({ log: mocks.log }));
vi.mock("../src/main/rendererSecurity", () => ({ rendererIpc: { handle: (channel: string, handler: () => unknown) => mocks.handlers.set(channel, handler) } }));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  mocks.app.isPackaged = true; mocks.events.clear(); mocks.handlers.clear();
  mocks.updater.on.mockImplementation((name, handler) => { mocks.events.set(name, handler); });
  mocks.updater.checkForUpdates.mockResolvedValue(null);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("production updater orchestration", () => {
  it("registers disabled IPC without network checks in development", async () => {
    mocks.app.isPackaged = false;
    const updater = await import("../src/main/updater"); await updater.initializeUpdater();
    expect(mocks.handlers.get("update:get-state")!()).toMatchObject({ status: "disabled" });
    mocks.handlers.get("update:check")!(); updater.quitAndInstall();
    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled(); expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("downloads, pushes progress and installs only after the update is ready", async () => {
    const updater = await import("../src/main/updater"), notify = vi.fn(), ready = vi.fn();
    updater.setUpdateReadyCallback(ready); await updater.initializeUpdater({ onStateChange: notify });
    updater.quitAndInstall(); expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled();
    mocks.events.get("checking-for-update")!();
    mocks.events.get("update-available")!({ version: "2.5.0" });
    mocks.events.get("download-progress")!({ percent: 42.4 });
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ status: "downloading", downloadPercent: 42 }));
    mocks.events.get("update-downloaded")!({ version: "2.5.0" });
    expect(ready).toHaveBeenCalledWith("2.5.0");
    mocks.events.get("error")!(new Error("Synthetic background failure"));
    expect(mocks.handlers.get("update:get-state")!()).toMatchObject({ status: "ready" });
    updater.quitAndInstall(); expect(mocks.updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true);
  });

  it("checks on the delayed and periodic timers", async () => {
    const updater = await import("../src/main/updater"); await updater.initializeUpdater();
    await vi.advanceTimersByTimeAsync(20000); expect(mocks.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * 3600000); expect(mocks.updater.checkForUpdates).toHaveBeenCalledTimes(2);
    mocks.events.get("update-not-available")!();
    expect(mocks.handlers.get("update:get-state")!()).toMatchObject({ status: "idle", newVersion: null });
  });

  it("notifies manual builds once per version without downloading or installing", async () => {
    const updater = await import("../src/main/updater"), manual = vi.fn();
    updater.setUpdateManualCallback(manual); await updater.initializeUpdater({ canAutoUpdate: false });
    mocks.events.get("update-available")!({ version: "2.5.0" }); mocks.events.get("update-available")!({ version: "2.5.0" });
    expect(manual).toHaveBeenCalledExactlyOnceWith("2.5.0");
    expect(mocks.updater.autoDownload).toBe(false); expect(mocks.updater.autoInstallOnAppQuit).toBe(false);
    expect(mocks.handlers.get("update:get-state")!()).toMatchObject({ status: "manual" });
    updater.quitAndInstall(); expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("pushes rejected checks as errors without installing", async () => {
    const updater = await import("../src/main/updater"); await updater.initializeUpdater();
    mocks.updater.checkForUpdates.mockRejectedValueOnce(new Error("Synthetic check failure"));
    mocks.handlers.get("update:check")!(); await Promise.resolve();
    expect(mocks.handlers.get("update:get-state")!()).toMatchObject({ status: "error", error: "Synthetic check failure" });
    expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled();
  });
});

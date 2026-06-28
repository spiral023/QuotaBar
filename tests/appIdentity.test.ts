import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShortcutDetails } from "electron";

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

describe("app identity", () => {
  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
    vi.resetModules();
    vi.clearAllMocks();
    vi.doUnmock("electron");
  });

  it("sets the display name and Windows AppUserModelID before showing notifications", async () => {
    setPlatform("win32");
    const setName = vi.fn();
    const setAppUserModelId = vi.fn();

    vi.doMock("electron", () => ({
      app: {
        setName,
        setAppUserModelId,
        getPath: vi.fn(),
      },
      shell: {},
    }));

    const { APP_DISPLAY_NAME, APP_USER_MODEL_ID, configureAppIdentity } = await import("../src/main/appIdentity");
    configureAppIdentity();

    expect(setName).toHaveBeenCalledWith(APP_DISPLAY_NAME);
    expect(setAppUserModelId).toHaveBeenCalledWith(APP_USER_MODEL_ID);
  });

  it("creates a Start Menu shortcut that gives Windows toasts the QuotaBar app name", async () => {
    setPlatform("win32");
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), "qb-appdata-"));
    const exePath = path.join(appData, "QuotaBar", "QuotaBar.exe");
    const writeShortcutLink = vi.fn(() => true);

    vi.doMock("electron", () => ({
      app: {
        isPackaged: true,
        setName: vi.fn(),
        setAppUserModelId: vi.fn(),
        getAppPath: vi.fn(() => path.join(appData, "app")),
        getPath: vi.fn((name: string) => name === "appData" ? appData : exePath),
      },
      shell: {
        readShortcutLink: vi.fn(),
        writeShortcutLink,
      },
    }));

    const { APP_DISPLAY_NAME, APP_USER_MODEL_ID, ensureWindowsNotificationShortcut, getWindowsNotificationShortcutPath } = await import("../src/main/appIdentity");
    ensureWindowsNotificationShortcut();

    const shortcutPath = getWindowsNotificationShortcutPath(appData);
    expect(writeShortcutLink).toHaveBeenCalledWith(shortcutPath, "replace", {
      target: exePath,
      args: "",
      cwd: path.dirname(exePath),
      description: APP_DISPLAY_NAME,
      appUserModelId: APP_USER_MODEL_ID,
      icon: exePath,
      iconIndex: 0,
    });
    expect(fs.existsSync(path.dirname(shortcutPath))).toBe(true);

    fs.rmSync(appData, { recursive: true, force: true });
  });

  it("keeps an existing matching Windows notification shortcut untouched", async () => {
    setPlatform("win32");
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), "qb-appdata-"));
    const exePath = path.join(appData, "QuotaBar", "QuotaBar.exe");
    const shortcutPath = path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "QuotaBar.lnk");
    fs.mkdirSync(path.dirname(shortcutPath), { recursive: true });
    fs.writeFileSync(shortcutPath, "");
    const current: ShortcutDetails = {
      target: exePath,
      args: "",
      cwd: path.dirname(exePath),
      appUserModelId: "win.quotabar.app",
    };
    const writeShortcutLink = vi.fn(() => true);

    vi.doMock("electron", () => ({
      app: {
        isPackaged: true,
        setName: vi.fn(),
        setAppUserModelId: vi.fn(),
        getAppPath: vi.fn(() => path.join(appData, "app")),
        getPath: vi.fn((name: string) => name === "appData" ? appData : exePath),
      },
      shell: {
        readShortcutLink: vi.fn(() => current),
        writeShortcutLink,
      },
    }));

    const { ensureWindowsNotificationShortcut } = await import("../src/main/appIdentity");
    ensureWindowsNotificationShortcut();

    expect(writeShortcutLink).not.toHaveBeenCalled();

    fs.rmSync(appData, { recursive: true, force: true });
  });
});

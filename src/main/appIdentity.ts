import fsSync from "node:fs";
import path from "node:path";
import { app, shell } from "electron";
import type { ShortcutDetails } from "electron";
import { log } from "./logging";

export const APP_DISPLAY_NAME = "QuotaBar";
export const APP_USER_MODEL_ID = "win.quotabar.app";

export function configureAppIdentity(): void {
  app.setName(APP_DISPLAY_NAME);
  if (process.platform === "win32") {
    app.setAppUserModelId(APP_USER_MODEL_ID);
  }
}

export function ensureWindowsNotificationShortcut(): void {
  if (process.platform !== "win32") return;

  const shortcutPath = getWindowsNotificationShortcutPath();
  const details = buildWindowsNotificationShortcutDetails();

  try {
    if (!windowsShortcutNeedsUpdate(shortcutPath, details)) return;
    fsSync.mkdirSync(path.dirname(shortcutPath), { recursive: true });
    const written = shell.writeShortcutLink(shortcutPath, "replace", details);
    if (!written) {
      log.warn(`Windows notification shortcut was not written: ${shortcutPath}`);
    }
  } catch (error) {
    log.warn(`Windows notification shortcut setup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function getWindowsNotificationShortcutPath(appDataPath = app.getPath("appData")): string {
  return path.join(
    appDataPath,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    `${APP_DISPLAY_NAME}.lnk`,
  );
}

export function buildWindowsNotificationShortcutDetails(): ShortcutDetails {
  const exePath = app.getPath("exe");
  return {
    target: exePath,
    args: app.isPackaged ? "" : quoteWindowsArg(path.resolve(process.argv[1] ?? app.getAppPath())),
    cwd: path.dirname(exePath),
    description: APP_DISPLAY_NAME,
    appUserModelId: APP_USER_MODEL_ID,
    icon: exePath,
    iconIndex: 0,
  };
}

function windowsShortcutNeedsUpdate(shortcutPath: string, expected: ShortcutDetails): boolean {
  if (!fsSync.existsSync(shortcutPath)) return true;

  try {
    const current = shell.readShortcutLink(shortcutPath);
    return (
      current.target !== expected.target ||
      (current.args ?? "") !== (expected.args ?? "") ||
      current.cwd !== expected.cwd ||
      current.appUserModelId !== expected.appUserModelId
    );
  } catch {
    return true;
  }
}

function quoteWindowsArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

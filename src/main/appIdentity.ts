import fsSync from "node:fs";
import path from "node:path";
import { app, shell } from "electron";
import type { ShortcutDetails } from "electron";
import { log } from "./logging";

export const APP_DISPLAY_NAME = "QuotaBar";
export const APP_USER_MODEL_ID = "win.quotabar.app";

export type AppVariantId = "development" | "installed" | "portable" | "zip";

export interface AppVariantInfo {
  id: AppVariantId;
  label: string;
}

export interface AppVariantContext {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  exePath?: string;
}

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

export function detectAppVariant(context: AppVariantContext = {}): AppVariantInfo {
  if (!app.isPackaged) return { id: "development", label: "Development" };

  const env = context.env ?? process.env;
  if (env.PORTABLE_EXECUTABLE_DIR) return { id: "portable", label: "Portable" };

  const exePath = context.exePath ?? app.getPath("exe");
  if (process.platform === "win32" && isKnownWindowsInstallPath(exePath, env)) {
    return { id: "installed", label: "Installed" };
  }

  return { id: "zip", label: "ZIP" };
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

function isKnownWindowsInstallPath(exePath: string, env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  const exeKey = path.normalize(exePath).toLowerCase();
  const roots = [
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs", APP_DISPLAY_NAME) : null,
    env.ProgramFiles ? path.join(env.ProgramFiles, APP_DISPLAY_NAME) : null,
    env["ProgramFiles(x86)"] ? path.join(env["ProgramFiles(x86)"], APP_DISPLAY_NAME) : null,
  ].filter((root): root is string => !!root);

  return roots.some((root) => {
    const rootKey = path.normalize(root).toLowerCase();
    return exeKey === rootKey || exeKey.startsWith(rootKey + path.sep);
  });
}

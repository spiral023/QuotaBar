import { app } from "electron";

export function isStartWithWindowsEnabled(): boolean {
  return app.getLoginItemSettings().openAtLogin;
}

export function setStartWithWindows(enabled: boolean): void {
  app.setLoginItemSettings({ openAtLogin: enabled });
}

export function applyStartupFlag(action: "install" | "uninstall" | null): void {
  if (action === "install") {
    setStartWithWindows(true);
  } else if (action === "uninstall") {
    setStartWithWindows(false);
  }
}

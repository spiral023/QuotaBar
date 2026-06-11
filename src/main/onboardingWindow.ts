import path from "path";
import { app, BrowserWindow, ipcMain } from "electron";
import { markFirstRunComplete } from "../config/firstRun";
import type { UsageProvider } from "../providers/types";
import { defaultAgentProbes, detectAgents } from "./onboarding";
import { log } from "./logging";

/**
 * Zeigt das Onboarding-Fenster beim ersten Start. Der Marker wird beim
 * Schließen immer geschrieben — egal ob über den "Los geht's"-Button oder
 * das Schließen-Kreuz — damit das Onboarding genau einmal erscheint.
 */
export function openOnboardingWindow(providers: UsageProvider[]): void {
  registerIpcHandlers(providers);

  const win = new BrowserWindow({
    width: 560,
    height: 720,
    minWidth: 480,
    minHeight: 560,
    frame: false,
    resizable: true,
    skipTaskbar: false,
    alwaysOnTop: false,
    center: true,
    backgroundColor: "#07090d",
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  void win.loadFile(path.join(__dirname, "../../src/renderer/onboarding.html"));

  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) win.show();
  });

  win.on("closed", () => {
    void markFirstRunComplete().catch((err: unknown) => {
      log.warn(`First-run marker write failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
}

let ipcRegistered = false;

function registerIpcHandlers(providers: UsageProvider[]): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle("onboarding:agents", async () => {
    return detectAgents(defaultAgentProbes(providers));
  });

  ipcMain.on("onboarding:complete", (event, payload: { autostart?: boolean }) => {
    if (payload?.autostart) {
      app.setLoginItemSettings({ openAtLogin: true });
      log.info("Autostart enabled via onboarding");
    }
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
}

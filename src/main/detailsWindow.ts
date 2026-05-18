import path from "path";
import { BrowserWindow, ipcMain, screen, Tray } from "electron";
import { UsageSnapshot } from "../providers/types";
import { loadSettings, saveSettings } from "../config/settings";
import { log } from "./logging";

export class DetailsWindowController {
  private win: BrowserWindow | null = null;
  private lastSnapshots: UsageSnapshot[] = [];
  private lastRefreshedAt: Date | null = null;
  private isPinned = false;

  constructor(private readonly getTray: () => Tray | null) {
    this.registerIpcHandlers();
  }

  open(onRefreshRequest: () => void): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.positionNearTray();
      this.pushUpdate();
      this.win.focus();
      return;
    }

    this.win = new BrowserWindow({
      width: 340,
      height: 560,
      frame: false,
      resizable: false,
      movable: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: "#090c10",
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    const htmlPath = path.join(__dirname, "../../src/renderer/index.html");
    void this.win.loadFile(htmlPath);

    this.win.once("ready-to-show", () => {
      if (!this.win || this.win.isDestroyed()) return;
      this.positionNearTray();
      this.win.show();
    });

    this.win.on("blur", () => {
      if (!this.isPinned && this.win && !this.win.isDestroyed()) this.win.hide();
    });

    this.win.on("closed", () => {
      this.win = null;
    });

    this._onRefreshRequest = onRefreshRequest;
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  /** Called by RefreshLoop listener — push new data to the open window. */
  notifyUpdate(snapshots: UsageSnapshot[]): void {
    this.lastSnapshots = snapshots;
    this.lastRefreshedAt = new Date();
    this.pushUpdate();
  }

  private pushUpdate(): void {
    if (!this.win || this.win.isDestroyed() || !this.win.isVisible()) return;
    this.win.webContents.send("quota:update", {
      snapshots: this.lastSnapshots,
      lastRefreshedAt: this.lastRefreshedAt?.toISOString() ?? null,
    });
  }

  private positionNearTray(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const tray = this.getTray();
    const [winW, winH] = this.win.getSize();

    if (tray) {
      try {
        const tb = tray.getBounds();
        const display = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y });
        const wa = display.workArea;

        let x = Math.round(tb.x + tb.width / 2 - winW / 2);
        let y = Math.round(tb.y - winH - 8);

        // Keep within work area
        x = Math.max(wa.x, Math.min(x, wa.x + wa.width - winW));
        y = Math.max(wa.y, Math.min(y, wa.y + wa.height - winH));

        this.win.setPosition(x, y, false);
        return;
      } catch {
        // fall through to center
      }
    }

    // Fallback: center on primary display
    const { workArea } = screen.getPrimaryDisplay();
    this.win.setPosition(
      Math.round(workArea.x + (workArea.width - winW) / 2),
      Math.round(workArea.y + (workArea.height - winH) / 2),
      false
    );
  }

  private _onRefreshRequest: (() => void) | null = null;

  private registerIpcHandlers(): void {
    ipcMain.on("quota:ready", () => {
      log.debug("Dashboard window ready, pushing current data");
      this.pushUpdate();
      this.win?.webContents.send("window:pin-state", this.isPinned);
    });

    ipcMain.on("window:toggle-pin", () => {
      this.isPinned = !this.isPinned;
      log.debug(`Dashboard pin toggled: ${this.isPinned}`);
      if (this.win && !this.win.isDestroyed()) {
        this.win.webContents.send("window:pin-state", this.isPinned);
      }
    });

    ipcMain.on("quota:refresh", () => {
      log.debug("Dashboard window requested refresh");
      this._onRefreshRequest?.();
    });

    ipcMain.on("window:close", () => {
      this.hide();
    });

    ipcMain.handle("settings:get", async () => {
      return await loadSettings();
    });

    ipcMain.handle("settings:save", async (_, partial: Record<string, unknown>) => {
      const current = await loadSettings();
      const merged = {
        ...current,
        ...partial,
        subscriptionCosts: {
          ...current.subscriptionCosts,
          ...((partial.subscriptionCosts as Record<string, unknown>) ?? {}),
        },
      };
      await saveSettings(merged);
      log.info("Settings saved via dashboard");
      this._onRefreshRequest?.();
    });
  }
}

import path from "path";
import { Worker } from "node:worker_threads";
import { BrowserWindow, ipcMain, screen, Tray, clipboard } from "electron";
import { UsageSnapshot } from "../providers/types";
import { loadSettings, saveSettings, normalizeNotificationSettings } from "../config/settings";
import { log } from "./logging";
import { generateUsageReport } from "../reports/reportService";
import type { ReportRequest } from "../reports/types";
import { getClaudeProjectsDirs, getCodexSessionsDirs } from "../config/paths";
import type { CostWindow, ViewMode } from "../config/settings";
import { computeCacheHitRate, type AnalyticsSummary, type AnalyticsData } from "./analyticsSummary";
import type { NotificationService } from "./notifications";
import type { DebugRecorder } from "./debugRecorder";
import { AsyncResultCache } from "./asyncResultCache";
import { PersistentWorkerClient } from "./workerClient";

// One long-lived worker instead of a fresh one per request: its module-level
// FileParseCaches stay warm, so repeat requests (cost-window switch, poll
// ticks) only re-stat the JSONL files instead of re-parsing the full history.
const analyticsWorker = new PersistentWorkerClient(
  () => new Worker(path.join(__dirname, "analyticsWorker.js"))
);

function runAnalyticsWorker(data: Record<string, unknown>): Promise<unknown> {
  return analyticsWorker.request(data);
}

export class DetailsWindowController {
  private win: BrowserWindow | null = null;
  private lastSnapshots: UsageSnapshot[] | null = null;
  private lastRefreshedAt: Date | null = null;
  private isPinned = false;
  private readonly analyticsSummaryCache = new AsyncResultCache<AnalyticsSummary>();
  private readonly analyticsDataCache = new AsyncResultCache<AnalyticsData>();
  private notificationService: NotificationService | null = null;

  constructor(
    private readonly getTray: () => Tray | null,
    private readonly recorder?: DebugRecorder
  ) {
    this.registerIpcHandlers();
  }

  setNotificationService(svc: NotificationService): void {
    this.notificationService = svc;
  }

  open(onRefreshRequest: () => void): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.positionWindow();
      this.pushUpdate();
      this.win.focus();
      return;
    }

    void loadSettings().then(settings => {
      this.recorder?.write({ kind: "dashboard.open" });
      const isDashboard = settings.viewMode !== "compact";
      this.win = new BrowserWindow({
        width:      isDashboard ? 900 : 340,
        height:     isDashboard ? 660 : 560,
        minWidth:   isDashboard ? 750 : 340,
        minHeight:  isDashboard ? 520 : 560,
        frame:      false,
        resizable:  isDashboard,
        movable:    true,
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
        this.positionWindow(isDashboard);
        this.win.show();
      });

      this.win.on("blur", () => {
        if (!this.isPinned && this.win && !this.win.isDestroyed()) this.win.hide();
      });

      this.win.on("closed", () => {
        this.recorder?.write({ kind: "dashboard.close" });
        this.win = null;
      });

      this._onRefreshRequest = onRefreshRequest;
    }).catch(err => log.error(`Failed to open window: ${err}`));
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  /** Called by RefreshLoop listener — push new data to the open window. */
  notifyUpdate(snapshots: UsageSnapshot[]): void {
    this.lastSnapshots = snapshots;
    this.lastRefreshedAt = new Date();
    this.clearAnalyticsCaches();
    this.pushUpdate();
  }

  private clearAnalyticsCaches(): void {
    this.analyticsSummaryCache.clear();
    this.analyticsDataCache.clear();
  }

  private pushUpdate(): void {
    if (!this.win || this.win.isDestroyed() || !this.win.isVisible()) return;
    this.win.webContents.send("quota:update", {
      snapshots: this.lastSnapshots,
      lastRefreshedAt: this.lastRefreshedAt?.toISOString() ?? null,
    });
  }

  private positionWindow(isDashboard = false): void {
    if (!this.win || this.win.isDestroyed()) return;
    const [winW, winH] = this.win.getSize();

    if (isDashboard) {
      const { workArea } = screen.getPrimaryDisplay();
      this.win.setPosition(
        Math.round(workArea.x + (workArea.width  - winW) / 2),
        Math.round(workArea.y + (workArea.height - winH) / 2),
        false,
      );
      return;
    }

    const tray = this.getTray();
    if (tray) {
      try {
        const tb = tray.getBounds();
        const display = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y });
        const wa = display.workArea;
        let x = Math.round(tb.x + tb.width / 2 - winW / 2);
        let y = Math.round(tb.y - winH - 8);
        x = Math.max(wa.x, Math.min(x, wa.x + wa.width  - winW));
        y = Math.max(wa.y, Math.min(y, wa.y + wa.height - winH));
        this.win.setPosition(x, y, false);
        return;
      } catch { /* fall through */ }
    }
    const { workArea } = screen.getPrimaryDisplay();
    this.win.setPosition(
      Math.round(workArea.x + (workArea.width  - winW) / 2),
      Math.round(workArea.y + (workArea.height - winH) / 2),
      false,
    );
  }

  private _onRefreshRequest: (() => void) | null = null;

  private handleDashboardRefresh(onRefreshRequest: () => void): void {
    this.recorder?.write({ kind: "dashboard.refreshRequested" });
    onRefreshRequest();
  }

  private registerIpcHandlers(): void {
    ipcMain.on("quota:ready", async () => {
      log.debug("Dashboard window ready, pushing current data");
      if (this.win && !this.win.isDestroyed()) {
        this.win.webContents.send("quota:update", {
          snapshots: this.lastSnapshots,
          lastRefreshedAt: this.lastRefreshedAt?.toISOString() ?? null,
        });
        this.win.webContents.send("window:pin-state", this.isPinned);
      }
      const settings = await loadSettings();
      this.win?.webContents.send("quota:ready-ack", { viewMode: settings.viewMode });
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
      this.handleDashboardRefresh(this._onRefreshRequest ?? (() => {}));
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
      this.clearAnalyticsCaches();
    });

    ipcMain.handle("reports:get", async (_, request: ReportRequest) => {
      const settings = await loadSettings();
      return await generateUsageReport(request, { settings });
    });

    ipcMain.handle("reports:copy-json", async (_, request: ReportRequest) => {
      const settings = await loadSettings();
      const report = await generateUsageReport(request, { settings });
      clipboard.writeText(JSON.stringify(report, null, 2));
      return { ok: true };
    });

    ipcMain.handle("analytics:summary", async (_, request?: { costWindow?: string }) => {
      const settings = await loadSettings();
      const costWindow = normalizeCostWindow(request?.costWindow) ?? settings.costWindow;
      const workerWindow = resolveAnalyticsWindow(costWindow);
      const cacheHitRate = computeCacheHitRate(this.lastSnapshots);
      const cacheKey = `summary:${costWindow}`;

      return this.analyticsSummaryCache.get(cacheKey, () => runAnalyticsWorker({
        task: "summary",
        claudeProjectsDirs: getClaudeProjectsDirs(),
        codexSessionsDirs:  getCodexSessionsDirs(),
        periodStartMs: workerWindow.periodStartMs,
        windowDays: workerWindow.windowDays,
        since: workerWindow.since,
        settings: { ...settings, costWindow },
        cacheHitRate,
      }) as Promise<AnalyticsSummary>);
    });

    ipcMain.handle("analytics:get", async () => {
      const settings     = await loadSettings();
      const { periodStartMs, windowDays, since } = calendarWindow(30);
      const cacheHitRate = computeCacheHitRate(this.lastSnapshots);

      return this.analyticsDataCache.get("get:30d", () => runAnalyticsWorker({
        task: "get",
        claudeProjectsDirs: getClaudeProjectsDirs(),
        codexSessionsDirs:  getCodexSessionsDirs(),
        periodStartMs, windowDays, since, settings, cacheHitRate,
      }) as Promise<AnalyticsData>);
    });

    ipcMain.handle("window:set-view", async (_, mode: string) => {
      if (mode !== "dashboard" && mode !== "compact") return;
      const settings = await loadSettings();
      await saveSettings({ ...settings, viewMode: mode as ViewMode });
      log.info(`View mode changed to ${mode}`);
      if (this.win && !this.win.isDestroyed()) {
        this.win.once("closed", () => {
          if (this._onRefreshRequest) this.open(this._onRefreshRequest);
        });
        this.win.close();
      }
    });

    ipcMain.handle("notification:history", () => {
      return this.notificationService?.history.getRecent(20) ?? [];
    });

    ipcMain.handle("notification:test", () => {
      this.notificationService?.sendTest();
      return { ok: true };
    });

    ipcMain.handle("notification:settings:save", async (_, partial: Record<string, unknown>) => {
      const current = await loadSettings();
      const merged = normalizeNotificationSettings({
        ...current.notifications,
        ...(partial as object),
        rules: {
          ...current.notifications.rules,
          ...((partial.rules as object) ?? {}),
        },
      });
      await saveSettings({ ...current, notifications: merged });
      this.notificationService?.updateSettings(merged);
      log.info("Notification settings saved via dashboard");
      return { ok: true };
    });
  }
}

function normalizeCostWindow(value: unknown): CostWindow | null {
  return value === "7d" || value === "30d" || value === "all"
    ? value
    : null;
}

function resolveAnalyticsWindow(costWindow: CostWindow): { periodStartMs: number; windowDays: number; since: string } {
  if (costWindow === "all") {
    return { periodStartMs: 0, windowDays: 0, since: new Date(0).toISOString().slice(0, 10) };
  }
  const windowDays = costWindow === "7d" ? 7 : 30;
  return calendarWindow(windowDays);
}

// Align the window to whole local calendar days: it covers exactly `windowDays`
// days (today plus the previous windowDays-1), starting at local midnight. This
// keeps the distinct active-day count from ever exceeding windowDays (e.g. 8/7),
// which a rolling now-minus-N×24h start would otherwise allow at day boundaries.
function calendarWindow(windowDays: number): { periodStartMs: number; windowDays: number; since: string } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (windowDays - 1));
  return { periodStartMs: start.getTime(), windowDays, since: localDateKey(start) };
}

function localDateKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

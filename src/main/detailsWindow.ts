import fs from "node:fs/promises";
import path from "path";
import { Worker } from "node:worker_threads";
import { BrowserWindow, ipcMain, screen, Tray, clipboard, shell } from "electron";
import { UsageSnapshot } from "../providers/types";
import { loadSettings, saveSettings, normalizeNotificationSettings } from "../config/settings";
import { log } from "./logging";
import { generateUsageReport } from "../reports/reportService";
import type { ReportRequest } from "../reports/types";
import {
  getClaudeProjectsDirs, getCodexSessionsDirs, getDebugLogDir, getWindowHistoryPath,
  getAppConfigDir, getLogPath, getNotificationLogPath, getUsageSnapshotCachePath,
  getFxCachePath, getWindowRatioPath, getBonusStatePath, getNotificationStatePath,
} from "../config/paths";
import { loadWindowHistoryFile, saveWindowHistoryFile, mergeWindowHistory } from "../usage/windowHistoryStore";
import type { CostWindow, ViewMode, Settings } from "../config/settings";
import { computeCacheHitRate, type AnalyticsSummary, type AnalyticsData } from "./analyticsSummary";
import type { ModelsData } from "./modelsData";
import type { WindowBudgetData, WindowHistoryData } from "./analyticsWorker";
import type { NotificationService } from "./notifications";
import type { DebugRecorder } from "./debugRecorder";
import { AsyncResultCache } from "./asyncResultCache";
import { PersistentWorkerClient } from "./workerClient";
import { collectSystemData, findOpenableSystemPath } from "./systemData";
import { sharedFxFetcher } from "../pricing/fx-fetcher";
import { planChangePoints } from "../pricing/plan-cost";

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
  private readonly modelsDataCache = new AsyncResultCache<ModelsData>();
  private readonly windowBudgetCache = new AsyncResultCache<WindowBudgetData>();
  private readonly windowHistoryCache = new AsyncResultCache<WindowHistoryData>();
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

  open(onRefreshRequest: () => void, onRecomputeRequest?: () => void, opts?: { tab?: string }): void {
    this.pendingTab = opts?.tab ?? null;
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.positionWindow();
      this.pushUpdate();
      this.win.focus();
      this.sendPendingTab();
      return;
    }

    void loadSettings().then(settings => {
      this.recorder?.write({ kind: "dashboard.open" });
      this.isPinned = settings.pinned;
      const isDashboard = settings.viewMode !== "compact";
      this.win = new BrowserWindow({
        width:      isDashboard ? 900 : 411,
        height:     isDashboard ? 660 : 672,
        minWidth:   isDashboard ? 750 : 411,
        minHeight:  isDashboard ? 520 : 672,
        frame:      false,
        resizable:  isDashboard,
        movable:    true,
        skipTaskbar: true,
        alwaysOnTop: true,
        backgroundColor: "#090c10",
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          preload: path.join(__dirname, "preload.js"),
        },
      });

      const htmlPath = path.join(__dirname, "../../src/renderer/index.html");
      void this.win.loadFile(htmlPath);

      this.win.once("ready-to-show", () => {
        if (!this.win || this.win.isDestroyed()) return;
        this.positionWindow(isDashboard);
        this.win.show();
        this.win.focus();
      });

      this.win.on("blur", () => {
        if (!this.isPinned && this.win && !this.win.isDestroyed()) this.win.hide();
      });

      this.win.on("closed", () => {
        this.recorder?.write({ kind: "dashboard.close" });
        this.win = null;
      });

      this._onRefreshRequest = onRefreshRequest;
      this._onRecomputeRequest = onRecomputeRequest ?? null;
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
    this.modelsDataCache.clear();
    this.windowBudgetCache.clear();
    this.windowHistoryCache.clear();
  }

  private computeSummary(settings: Settings, costWindow: CostWindow): Promise<AnalyticsSummary> {
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
  }

  /**
   * Spawnt den Analytics-Worker und parst die JSONL-/Codex-Historie in dessen
   * FileParseCache, bevor der Nutzer das Dashboard öffnet. Die erste
   * analytics:summary-Anfrage blockiert auf einem Kaltstart sonst ~15-20 s auf
   * Worker-Boot + Vollparse — das Vorwärmen verlagert diese Kosten weg vom
   * Öffnen-Pfad. Das hier memoizierte Ergebnis wird ggf. vom ersten Live-Refresh
   * verworfen, doch der modulglobale FileParseCache im Worker überlebt das, sodass
   * die spätere echte Anfrage die Dateien nur noch neu statt parst.
   */
  prewarmAnalytics(): void {
    void loadSettings()
      .then(settings => this.computeSummary(settings, settings.costWindow))
      .catch(err => log.warn(`Analytics prewarm failed: ${err instanceof Error ? err.message : String(err)}`));
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
  private _onRecomputeRequest: (() => void) | null = null;
  private pendingTab: string | null = null;

  private sendPendingTab(): void {
    if (!this.pendingTab || !this.win || this.win.isDestroyed()) return;
    this.win.webContents.send("ui:show-tab", this.pendingTab);
    this.pendingTab = null;
  }

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
      this.sendPendingTab();
    });

    ipcMain.on("window:toggle-pin", () => {
      this.isPinned = !this.isPinned;
      log.debug(`Dashboard pin toggled: ${this.isPinned}`);
      if (this.win && !this.win.isDestroyed()) {
        this.win.webContents.send("window:pin-state", this.isPinned);
      }
      void loadSettings().then(s => saveSettings({ ...s, pinned: this.isPinned }));
    });

    ipcMain.on("quota:refresh", () => {
      log.debug("Dashboard window requested refresh");
      this.handleDashboardRefresh(this._onRefreshRequest ?? (() => {}));
    });

    ipcMain.on("quota:recompute-cost", () => {
      log.debug("Dashboard window requested cost recompute");
      (this._onRecomputeRequest ?? (() => {}))();
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
      };
      await saveSettings(merged);
      log.info("Settings saved via dashboard");
      this.clearAnalyticsCaches();
    });

    ipcMain.handle("reports:get", async (_, request: ReportRequest) => {
      const settings = await loadSettings();
      const report = await generateUsageReport(request, { settings });
      const sinceDay = request.since ?? report.rows[0]?.bucket?.slice(0, 10);
      const untilDay = request.until ?? new Date().toISOString().slice(0, 10);
      const planChanges = (sinceDay && untilDay) ? [
        ...planChangePoints(settings.plans, "claude", sinceDay, untilDay),
        ...planChangePoints(settings.plans, "codex",  sinceDay, untilDay),
      ] : [];
      return { ...report, planChanges };
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
      return this.computeSummary(settings, costWindow);
    });

    ipcMain.handle("analytics:get", async (_, request?: { since?: string; until?: string }) => {
      const settings     = await loadSettings();
      const { periodStartMs, windowDays, since, until } = resolveAnalyticsGetWindow(request);
      const cacheHitRate = computeCacheHitRate(this.lastSnapshots);

      const needsFx = settings.plans.some((p) => p.currency === "EUR");
      if (needsFx) await sharedFxFetcher.ensureRange(since, until);
      const eurUsdRates = sharedFxFetcher.exportRange("EURUSD", since, until);
      const fxEstimated = sharedFxFetcher.estimated;
      const planSig = JSON.stringify(settings.plans);

      return this.analyticsDataCache.get(`get:${since}:${until}:${planSig}`, () => runAnalyticsWorker({
        task: "get",
        claudeProjectsDirs: getClaudeProjectsDirs(),
        codexSessionsDirs:  getCodexSessionsDirs(),
        periodStartMs, windowDays, since, until, settings, cacheHitRate,
        eurUsdRates, fxEstimated,
      }) as Promise<AnalyticsData>);
    });

    ipcMain.handle("plans:get", async () => {
      const settings = await loadSettings();
      return settings.plans;
    });

    ipcMain.handle("plans:save", async (_, plans: unknown) => {
      const current = await loadSettings();
      await saveSettings({ ...current, plans: Array.isArray(plans) ? (plans as typeof current.plans) : [] });
      this.clearAnalyticsCaches();
      log.info("Plans saved via dashboard");
      return { ok: true };
    });

    ipcMain.handle("fx:status", () => ({ estimated: sharedFxFetcher.estimated }));

    ipcMain.handle("models:get", async () => {
      const settings = await loadSettings();
      return this.modelsDataCache.get("models", () => runAnalyticsWorker({
        task: "models",
        settings,
      }) as Promise<ModelsData>);
    });

    ipcMain.handle("windowBudget:get", async (): Promise<WindowBudgetData> => {
      const snapshots = this.lastSnapshots ?? [];
      const providers = snapshots
        .filter((s) => s.status === "ok" || s.status === "stale")
        .flatMap((s) => {
          const weekly = s.windows.find((w) => w.name === "weekly");
          if (!weekly || typeof weekly.usedPercent !== "number") return [];
          const budget = s.windowBudget;
          if (!budget || budget.learning) return [];
          if (s.provider !== "claude" && s.provider !== "codex") return [];
          return [{
            provider: s.provider,
            weeklyUsedPercent: weekly.usedPercent,
            weeklyResetsAt: weekly.resetsAt ?? null,
            windowsPerWeek: budget.windowsPerWeek,
            burnRatePctPerHour: weekly.burnRatePctPerHour ?? null,
            pace: weekly.pace ?? null,
            planType: s.planType ?? null,
          }];
        });
      if (providers.length === 0) return { perProvider: {} };
      return this.windowBudgetCache.get("windowBudget", () =>
        runAnalyticsWorker({
          task: "windowBudget",
          logDir: getDebugLogDir(),
          nowMs: Date.now(),
          providers,
        }) as Promise<WindowBudgetData>
      );
    });

    ipcMain.handle("windowHistory:get", async () => {
      const settings = await loadSettings();
      // Aus den Logs berechnete, abgeschlossene 7d-Fenster (gecached).
      const computed = await this.windowHistoryCache.get("windowHistory", () =>
        runAnalyticsWorker({
          task: "windowHistory",
          logDir: getDebugLogDir(),
          nowMs: Date.now(),
        }) as Promise<WindowHistoryData>
      );
      // Mit dem persistenten Store vereinen (überlebt gelöschte Logs) und speichern.
      const histPath = getWindowHistoryPath();
      const stored = await loadWindowHistoryFile(histPath);
      const entries = mergeWindowHistory(stored.entries, computed.entries);
      await saveWindowHistoryFile(histPath, { version: 2, entries }).catch((err: unknown) => {
        log.warn(`Window-history save failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      const sinceDay = entries[0]?.weekStart?.slice(0, 10);
      const untilDay = new Date().toISOString().slice(0, 10);
      const planChanges = sinceDay ? [
        ...planChangePoints(settings.plans, "claude", sinceDay, untilDay),
        ...planChangePoints(settings.plans, "codex", sinceDay, untilDay),
      ] : [];
      return { entries, planChanges };
    });

    ipcMain.handle("system:get", async () => {
      return await collectSystemData();
    });

    ipcMain.handle("system:open-path", async (_, requestedPath: unknown) => {
      if (typeof requestedPath !== "string" || requestedPath.trim().length === 0) {
        return { ok: false, error: "invalid_path" };
      }
      const report = await collectSystemData();
      const openPath = findOpenableSystemPath(report, requestedPath);
      if (!openPath) return { ok: false, error: "path_not_allowed" };
      const error = await shell.openPath(openPath);
      return error ? { ok: false, error } : { ok: true };
    });

    ipcMain.handle("system:delete-app-data", async (_, groups: unknown) => {
      if (!Array.isArray(groups)) return { ok: false, error: "invalid_groups" };
      const allowed = new Set(["cache", "logs", "state", "debug"]);
      const validGroups = groups.filter((g): g is string => typeof g === "string" && allowed.has(g));
      if (validGroups.length === 0) return { ok: true, deleted: [], errors: [] };

      const appDir = getAppConfigDir();
      const targets: Array<{ path: string; recursive: boolean }> = [];
      for (const group of validGroups) {
        switch (group) {
          case "cache":
            targets.push({ path: getUsageSnapshotCachePath(), recursive: false });
            targets.push({ path: getFxCachePath(), recursive: false });
            break;
          case "logs":
            targets.push({ path: getLogPath(), recursive: false });
            targets.push({ path: getNotificationLogPath(), recursive: false });
            break;
          case "state":
            targets.push({ path: getWindowHistoryPath(), recursive: false });
            targets.push({ path: getWindowRatioPath(), recursive: false });
            targets.push({ path: getBonusStatePath(), recursive: false });
            targets.push({ path: getNotificationStatePath(), recursive: false });
            break;
          case "debug":
            targets.push({ path: path.join(appDir, "debug"), recursive: true });
            break;
        }
      }

      const deleted: string[] = [];
      const errors: string[] = [];
      for (const target of targets) {
        try {
          await fs.rm(target.path, { recursive: target.recursive, force: true });
          deleted.push(target.path);
          log.info(`system:delete-app-data removed ${target.path}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(msg);
          log.warn(`system:delete-app-data failed for ${target.path}: ${msg}`);
        }
      }
      return { ok: errors.length === 0, deleted, errors };
    });

    ipcMain.handle("window:set-view", async (_, mode: string) => {
      if (mode !== "dashboard" && mode !== "compact") return;
      const settings = await loadSettings();
      await saveSettings({ ...settings, viewMode: mode as ViewMode });
      log.info(`View mode changed to ${mode}`);
      if (this.win && !this.win.isDestroyed()) {
        this.win.once("closed", () => {
          if (this._onRefreshRequest) this.open(this._onRefreshRequest, this._onRecomputeRequest ?? undefined);
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

// Datumsbereich für den Analytics-Tab. Akzeptiert ein konkretes {since, until}
// (YYYY-MM-DD) aus der Steuerleiste; fällt auf die letzten 30 Kalendertage
// zurück, wenn nichts oder Ungültiges übergeben wird.
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function resolveAnalyticsGetWindow(
  request?: { since?: string; until?: string },
): { periodStartMs: number; windowDays: number; since: string; until: string } {
  if (
    request && typeof request.since === "string" && typeof request.until === "string" &&
    DATE_KEY_RE.test(request.since) && DATE_KEY_RE.test(request.until)
  ) {
    let since = request.since;
    let until = request.until;
    if (since > until) [since, until] = [until, since];
    const start = new Date(`${since}T00:00:00`);
    start.setHours(0, 0, 0, 0);
    const end = new Date(`${until}T00:00:00`);
    const windowDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
    return { periodStartMs: start.getTime(), windowDays, since, until };
  }
  const cw = calendarWindow(30);
  return { ...cw, until: localDateKey(new Date()) };
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

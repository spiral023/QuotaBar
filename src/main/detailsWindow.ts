import fs from "node:fs/promises";
import path from "path";
import { Worker } from "node:worker_threads";
import { app, BrowserWindow, ipcMain, screen, Tray, clipboard, dialog, shell } from "electron";
import { UsageSnapshot } from "../providers/types";
import { loadSettings, saveSettings, normalizeNotificationSettings } from "../config/settings";
import { log } from "./logging";
import { generateUsageReport } from "../reports/reportService";
import type { ReportRequest } from "../reports/types";
import {
  getWindowHistoryPath, getPortableMigrationPath,
  getAppConfigDir, getHomeDir, getLogPath, getNotificationLogPath, getUsageSnapshotCachePath,
  getFxCachePath, getLiteLLMModelPricesPath, getWindowRatioPath, getBonusStatePath, getNotificationStatePath,
} from "../config/paths";
import { loadWindowHistoryFile, saveWindowHistoryFile, mergeWindowHistory } from "../usage/windowHistoryStore";
import type { CostWindow, ViewMode, Settings } from "../config/settings";
import { computeCacheHitRate, type AnalyticsSummary, type AnalyticsData } from "./analyticsSummary";
import type { ModelsData } from "./modelsData";
import type { AnalyticsWorkerSettings, WindowBudgetData, WindowHistoryData } from "./analyticsWorker";
import type { NotificationService } from "./notifications";
import type { DebugRecorder } from "./debugRecorder";
import { AsyncResultCache } from "./asyncResultCache";
import { PersistentWorkerClient } from "./workerClient";
import {
  collectSystemData,
  findOpenableSystemPath,
  formatWslDiscoveryDiagnostics,
} from "./systemData";
import { sharedFxFetcher } from "../pricing/fx-fetcher";
import { planChangePoints } from "../pricing/plan-cost";
import { readDataSourceInfo } from "./dataSourceStatus";
import { configureHttpProxy, getActiveProxyUrl, httpFetch } from "./httpClient";
import { normalizeProxySettings, type ProxySettings } from "../config/settings";
import { QuickStatsLoadMetric } from "./quickStatsLoadMetric";
import { detectAppVariant } from "./appIdentity";
import { getRuntimeAgentRoots, mergeSettingsWithAgentRoots, refreshRuntimeWslAgentRoots } from "./agentRootDiscovery";
import { mergeAndSaveSettings } from "./settingsSave";
import { parseMigrationState } from "../portable/migration";
import { PortableUsageStore } from "../portable/usageStore";
import { exportPortableData, stagePortableImport } from "../portable/archiveService";

let archiveOperation: "export" | "import" | null = null;
let portableImportRestart: "pending" | "exiting" | null = null;

const ARCHIVE_BUSY_RESULT = Object.freeze({
  ok: false,
  error: "archive_operation_in_progress",
  message: "Another portable archive operation is already in progress.",
});

// One long-lived worker instead of a fresh one per request: its module-level
// FileParseCaches stay warm, so repeat requests (cost-window switch, poll
// ticks) only re-stat the JSONL files instead of re-parsing the full history.
const analyticsWorker = new PersistentWorkerClient(
  () => new Worker(path.join(__dirname, "analyticsWorker.js"))
);

function runAnalyticsWorker(data: Record<string, unknown>): Promise<unknown> {
  return analyticsWorker.request(data);
}

function analyticsWorkerSettings(settings: Settings): AnalyticsWorkerSettings {
  return {
    plans: settings.plans,
    pricingOfflineMode: settings.pricingOfflineMode,
    minModelTokenSharePct: settings.minModelTokenSharePct,
  };
}

export function createAnalyticsSummaryRequest(
  settings: Settings,
  costWindow: CostWindow,
  cacheHitRate: AnalyticsSummary["cacheHitRate"],
  periodEndMs = Date.now(),
): Record<string, unknown> {
  const workerWindow = resolveAnalyticsWindow(costWindow, periodEndMs);
  return {
    task: "summary",
    periodStartMs: workerWindow.periodStartMs,
    windowDays: workerWindow.windowDays,
    since: workerWindow.since,
    periodEndMs,
    settings: analyticsWorkerSettings(settings),
    cacheHitRate,
    usageRange: { since: new Date(workerWindow.periodStartMs).toISOString(), until: new Date(periodEndMs).toISOString() },
    quotaRange: { since: new Date(workerWindow.periodStartMs).toISOString(), until: new Date(periodEndMs).toISOString() },
  };
}

export function createAnalyticsGetRequest(
  settings: Settings,
  request: { since?: string; until?: string; timeZone?: string } | undefined,
  cacheHitRate: AnalyticsSummary["cacheHitRate"],
  nowMs: number,
  eurUsdRates: Record<string, number>,
  fxEstimated: boolean,
): Record<string, unknown> {
  const { periodStartMs, periodEndMs, windowDays, since, until, timeZone } = resolveAnalyticsGetWindow(request, nowMs);
  return {
    task: "get",
    periodStartMs,
    windowDays,
    since,
    until,
    settings: analyticsWorkerSettings(settings),
    cacheHitRate,
    eurUsdRates,
    fxEstimated,
    nowMs,
    periodEndMs,
    timeZone,
    usageRange: { since: new Date(periodStartMs).toISOString(), until: new Date(periodEndMs).toISOString() },
    quotaRange: { since: new Date(periodStartMs).toISOString(), until: new Date(periodEndMs).toISOString() },
  };
}

export interface PortableDataPreparing {
  portableDataPreparing: true;
}

const PORTABLE_DATA_PREPARING: PortableDataPreparing = Object.freeze({ portableDataPreparing: true });

export async function portableDataIsReady(
  statePath = getPortableMigrationPath(),
  store = new PortableUsageStore(path.dirname(statePath)),
): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    // Read diagnostics can contain host paths; expose only the fixed readiness category.
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Portable migration readiness read failed");
  }
  let state;
  try {
    state = parseMigrationState(JSON.parse(raw)).state;
  } catch {
    return false;
  }
  if (state?.status !== "complete" || !state.storeRevision) return false;
  try {
    return await store.getRevision() === state.storeRevision;
  } catch {
    throw new Error("Portable readiness store read failed");
  }
}

export interface DetailsWindowDependencies {
  portableDataIsReady: () => Promise<boolean>;
  runAnalyticsWorker: (data: Record<string, unknown>) => Promise<unknown>;
  loadRuntimeSettings: () => Promise<Settings>;
  now: () => number;
}

async function loadRuntimeSettings(): Promise<Settings> {
  return mergeSettingsWithAgentRoots(await loadSettings());
}

function runtimeRootContext(): { wslClaudeRoots: string[]; wslCodexHomes: string[] } {
  const roots = getRuntimeAgentRoots();
  return {
    wslClaudeRoots: roots.claudeRoots,
    wslCodexHomes: roots.codexHomes,
  };
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
  private readonly quickStatsLoadMetric = new QuickStatsLoadMetric();

  constructor(
    private readonly getTray: () => Tray | null,
    private readonly recorder?: DebugRecorder,
    private readonly onSettingsSaved?: (settings: Settings, changedKeys: string[]) => void,
    private readonly dependencies: Partial<DetailsWindowDependencies> = {},
  ) {
    this.registerIpcHandlers();
  }

  private isPortableDataReady(): Promise<boolean> {
    return (this.dependencies.portableDataIsReady ?? portableDataIsReady)();
  }

  private requestAnalyticsWorker(data: Record<string, unknown>): Promise<unknown> {
    return (this.dependencies.runAnalyticsWorker ?? runAnalyticsWorker)(data);
  }

  private runtimeSettings(): Promise<Settings> {
    return (this.dependencies.loadRuntimeSettings ?? loadRuntimeSettings)();
  }

  private nowMs(): number {
    return (this.dependencies.now ?? Date.now)();
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
    const runtimeSettings = mergeSettingsWithAgentRoots(settings);
    const cacheHitRate = computeCacheHitRate(this.lastSnapshots);
    const cacheKey = `summary:${costWindow}`;

    return this.analyticsSummaryCache.get(cacheKey, async () => {
      const startedAtMs = Date.now();
      const summary = await this.requestAnalyticsWorker(
        createAnalyticsSummaryRequest(runtimeSettings, costWindow, cacheHitRate, startedAtMs),
      ) as AnalyticsSummary;
      const durationMs = Math.max(0, Date.now() - startedAtMs);
      if (this.quickStatsLoadMetric.record(durationMs)) {
        log.info(`Quick Stats initial load completed in ${formatSeconds(durationMs)}`);
      }
      return summary;
    });
  }

  /** Warms the worker and portable summary store before the dashboard opens. */
  async prewarmAnalytics(): Promise<void> {
    if (!await this.isPortableDataReady()) throw new Error("Portable analytics prewarm is not ready");
    const until = this.nowMs();
    const since = until - 30 * 24 * 3600 * 1000;
    await this.requestAnalyticsWorker({
      task: "prewarm",
      usageRange: { since: new Date(since).toISOString(), until: new Date(until).toISOString() },
      quotaRange: { since: new Date(since).toISOString(), until: new Date(until).toISOString() },
    });
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

    ipcMain.handle("app:meta", () => ({
      version: app.getVersion(),
      variant: detectAppVariant(),
    }));

    ipcMain.handle("settings:save", async (_, partial: Record<string, unknown>) => {
      const saved = await mergeAndSaveSettings(partial, this.onSettingsSaved);
      log.info(`Dashboard action: settings:save keys=${Object.keys(partial).join(",") || "none"}`);
      if (Object.prototype.hasOwnProperty.call(partial, "claudeRoots")) {
        log.info(`Settings saved via dashboard: claudeRoots=${formatPathListForLog(partial.claudeRoots)}`);
      }
      if (Object.prototype.hasOwnProperty.call(partial, "codexHomes")) {
        log.info(`Settings saved via dashboard: codexHomes=${formatPathListForLog(partial.codexHomes)}`);
      }
      // Re-apply proxy settings without a restart when Network settings change.
      if (Object.prototype.hasOwnProperty.call(partial, "proxy")) {
        await configureHttpProxy(saved.proxy).catch((err: unknown) => {
          log.warn(`Proxy re-apply failed: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        });
      }
      this.clearAnalyticsCaches();
      return saved;
    });

    // Applies pending proxy settings and checks live API reachability. Any HTTP
    // response, including 4xx, means the connection path works; network, TLS,
    // and timeout errors count as failures.
    ipcMain.handle("settings:test-proxy", async (_, raw: unknown) => {
      const proxy: ProxySettings = normalizeProxySettings(raw as Partial<ProxySettings>);
      try {
        const proxyUrl = await configureHttpProxy(proxy);
        const res = await httpFetch("https://api.anthropic.com/api/oauth/usage", {
          method: "GET",
          signal: AbortSignal.timeout(8_000),
        });
        return { ok: true, proxyUrl, status: res.status, mode: proxy.mode };
      } catch (error) {
        return {
          ok: false,
          proxyUrl: getActiveProxyUrl(),
          mode: proxy.mode,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    ipcMain.handle("reports:get", async (_, request: ReportRequest) => {
      if (!await this.isPortableDataReady()) return PORTABLE_DATA_PREPARING;
      const settings = await loadRuntimeSettings();
      const report = await generateUsageReport({ ...request, source: "portable" }, { settings });
      const sinceDay = request.since ?? report.rows[0]?.bucket?.slice(0, 10);
      const untilDay = request.until ?? new Date().toISOString().slice(0, 10);
      const planChanges = (sinceDay && untilDay) ? [
        ...planChangePoints(settings.plans, "claude", sinceDay, untilDay),
        ...planChangePoints(settings.plans, "codex",  sinceDay, untilDay),
      ] : [];
      return { ...report, planChanges };
    });

    ipcMain.handle("reports:copy-json", async (_, request: ReportRequest) => {
      if (!await this.isPortableDataReady()) return PORTABLE_DATA_PREPARING;
      const settings = await loadRuntimeSettings();
      const report = await generateUsageReport({ ...request, source: "portable" }, { settings });
      clipboard.writeText(JSON.stringify(report, null, 2));
      return { ok: true };
    });

    ipcMain.handle("analytics:summary", async (_, request?: { costWindow?: string }) => {
      if (!await this.isPortableDataReady()) return PORTABLE_DATA_PREPARING;
      const settings = await this.runtimeSettings();
      const costWindow = normalizeCostWindow(request?.costWindow) ?? settings.costWindow;
      return this.computeSummary(settings, costWindow);
    });

    ipcMain.handle("analytics:get", async (_, request?: { since?: string; until?: string; timeZone?: string }) => {
      if (!await this.isPortableDataReady()) return PORTABLE_DATA_PREPARING;
      const settings     = await this.runtimeSettings();
      const { since, until } = resolveAnalyticsGetWindow(request, this.nowMs());
      const cacheHitRate = computeCacheHitRate(this.lastSnapshots);

      const needsFx = settings.plans.some((p) => p.currency === "EUR");
      if (needsFx) await sharedFxFetcher.ensureRange(since, until);
      const eurUsdRates = sharedFxFetcher.exportRange("EURUSD", since, until);
      const fxEstimated = sharedFxFetcher.estimated;
      const planSig = JSON.stringify(settings.plans);

      return this.analyticsDataCache.get(`get:${since}:${until}:${request?.timeZone ?? "local"}:${planSig}`, () => this.requestAnalyticsWorker(
        createAnalyticsGetRequest(settings, request, cacheHitRate, this.nowMs(), eurUsdRates, fxEstimated),
      ) as Promise<AnalyticsData>);
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

    ipcMain.handle("dataSources:get", () => ({
      litellm: readDataSourceInfo("litellm", getLiteLLMModelPricesPath()),
      fx: readDataSourceInfo("fx", getFxCachePath()),
    }));

    ipcMain.handle("models:get", async () => {
      if (!await this.isPortableDataReady()) return PORTABLE_DATA_PREPARING;
      const settings = await loadSettings();
      return this.modelsDataCache.get("models", () => this.requestAnalyticsWorker({
        task: "models",
        settings: analyticsWorkerSettings(settings),
        usageRange: { since: "1970-01-01T00:00:00.000Z", until: new Date().toISOString() },
      }) as Promise<ModelsData>);
    });

    ipcMain.handle("windowBudget:get", async () => {
      if (!await this.isPortableDataReady()) return PORTABLE_DATA_PREPARING;
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
        this.requestAnalyticsWorker({
          task: "windowBudget",
          nowMs: this.nowMs(),
          usageRange: { since: new Date(this.nowMs() - 28 * 24 * 3600 * 1000).toISOString(), until: new Date(this.nowMs()).toISOString() },
          quotaRange: { since: new Date(this.nowMs() - 28 * 24 * 3600 * 1000).toISOString(), until: new Date(this.nowMs()).toISOString() },
          providers,
        }) as Promise<WindowBudgetData>
      );
    });

    ipcMain.handle("windowHistory:get", async () => {
      if (!await this.isPortableDataReady()) return PORTABLE_DATA_PREPARING;
      const settings = await loadSettings();
      // Aus den Logs berechnete, abgeschlossene 7d-Fenster (gecached).
      const computed = await this.windowHistoryCache.get("windowHistory", () =>
        this.requestAnalyticsWorker({
          task: "windowHistory",
          nowMs: this.nowMs(),
          quotaRange: { since: new Date(this.nowMs() - 365 * 24 * 3600 * 1000).toISOString(), until: new Date(this.nowMs()).toISOString() },
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
      return await collectSystemData({
        quickStatsLoadDurationMs: this.quickStatsLoadMetric.valueMs,
        appVariant: detectAppVariant(),
        ...runtimeRootContext(),
      });
    });

    ipcMain.handle("system:export-portable-data", async () => {
      if (archiveOperation !== null || portableImportRestart !== null) return ARCHIVE_BUSY_RESULT;
      archiveOperation = "export";
      try {
        const selected = await dialog.showSaveDialog({
          title: "Export portable data",
          defaultPath: path.join(getHomeDir(), "QuotaBar-portable-data.zip"),
          filters: [{ name: "ZIP archives", extensions: ["zip"] }],
          properties: ["showOverwriteConfirmation"],
        });
        if (selected.canceled || !selected.filePath) return { ok: false, cancelled: true };
        const result = await exportPortableData(getAppConfigDir(), selected.filePath);
        log.info(`Portable archive action=export result=success files=${result.fileCount} bytes=${result.totalBytes}`);
        return { ok: true, ...result };
      } catch {
        const message = "Portable data export failed.";
        log.warn(`Portable archive action=export error=${message}`);
        return { ok: false, error: "portable_export_failed", message };
      } finally {
        archiveOperation = null;
      }
    });

    ipcMain.handle("system:import-portable-data", async () => {
      if (archiveOperation !== null || portableImportRestart !== null) return ARCHIVE_BUSY_RESULT;
      archiveOperation = "import";
      try {
        const selected = await dialog.showOpenDialog({
          title: "Import portable data",
          filters: [{ name: "ZIP archives", extensions: ["zip"] }],
          properties: ["openFile"],
        });
        const source = selected.filePaths[0];
        if (selected.canceled || !source) return { ok: false, cancelled: true };
        const result = await stagePortableImport(source, getAppConfigDir(), getHomeDir());
        log.info(`Portable archive action=import result=success files=${result.fileCount} bytes=${result.totalBytes}`);
        portableImportRestart = "pending";
        return {
          ok: true,
          backupPath: result.backupPath,
          fileCount: result.fileCount,
          totalBytes: result.totalBytes,
          restartScheduled: true,
        };
      } catch {
        const message = "Portable data import failed.";
        log.warn(`Portable archive action=import error=${message}`);
        return { ok: false, error: "portable_import_failed", message };
      } finally {
        archiveOperation = null;
      }
    });

    ipcMain.handle("system:confirm-portable-import-restart", async () => {
      if (portableImportRestart !== "pending") {
        return {
          ok: false,
          error: "portable_import_restart_not_pending",
          message: "No portable import restart is pending.",
        };
      }
      portableImportRestart = "exiting";
      app.relaunch();
      app.exit(0);
      return { ok: true };
    });

    ipcMain.handle("system:codex-homes:suggest", async () => {
      log.info("Dashboard action: Detect WSL clicked for Codex homes");
      const { discovery, roots } = await refreshRuntimeWslAgentRoots();
      for (const line of formatWslDiscoveryDiagnostics(discovery)) log.info(line);
      log.info(`WSL discovery: runtime roots claudeRoots=${formatPathListForLog(roots.claudeRoots)} codexHomes=${formatPathListForLog(roots.codexHomes)}`);
      return discovery.codexHomes;
    });

    ipcMain.handle("system:claude-roots:suggest", async () => {
      log.info("Dashboard action: Detect WSL clicked for Claude roots");
      const { discovery, roots } = await refreshRuntimeWslAgentRoots();
      for (const line of formatWslDiscoveryDiagnostics(discovery)) log.info(line);
      log.info(`WSL discovery: runtime roots claudeRoots=${formatPathListForLog(roots.claudeRoots)} codexHomes=${formatPathListForLog(roots.codexHomes)}`);
      return discovery.claudeRoots;
    });

    ipcMain.handle("shell:open-url", async (_, url: unknown) => {
      const ALLOWED = new Set([
        "https://github.com/spiral023/QuotaBar",
        "https://github.com/spiral023/QuotaBar/releases/latest",
        "https://artificialanalysis.ai/methodology/intelligence-benchmarking",
        "https://artificialanalysis.ai/methodology/coding-agents-benchmarking",
      ]);
      if (typeof url !== "string" || !ALLOWED.has(url)) return { ok: false, error: "not_allowed" };
      await shell.openExternal(url);
      return { ok: true };
    });

    ipcMain.handle("system:open-path", async (_, requestedPath: unknown) => {
      if (typeof requestedPath !== "string" || requestedPath.trim().length === 0) {
        return { ok: false, error: "invalid_path" };
      }
      const report = await collectSystemData(runtimeRootContext());
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

function formatSeconds(durationMs: number): string {
  const seconds = Math.max(0, durationMs) / 1000;
  return `${seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1)}s`;
}

function formatPathListForLog(value: unknown): string {
  if (!Array.isArray(value)) return "[]";
  const paths = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return paths.length ? `[${paths.join(", ")}]` : "[]";
}

// Datumsbereich für den Analytics-Tab. Akzeptiert ein konkretes {since, until}
// (YYYY-MM-DD) aus der Steuerleiste; fällt auf die letzten 30 Kalendertage
// zurück, wenn nichts oder Ungültiges übergeben wird.
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function resolveAnalyticsGetWindow(
  request?: { since?: string; until?: string; timeZone?: string },
  nowMs = Date.now(),
): { periodStartMs: number; periodEndMs: number; windowDays: number; since: string; until: string; timeZone: string } {
  if (
    request && typeof request.since === "string" && typeof request.until === "string" &&
    DATE_KEY_RE.test(request.since) && DATE_KEY_RE.test(request.until)
  ) {
    let since = request.since;
    let until = request.until;
    if (since > until) [since, until] = [until, since];
    const timeZone = validTimeZone(request.timeZone);
    const periodStartMs = zonedMidnightMs(since, timeZone);
    const periodEndMs = zonedMidnightMs(nextDateKey(until), timeZone) - 1;
    const windowDays = calendarDayDistance(since, until) + 1;
    return { periodStartMs, periodEndMs, windowDays, since, until, timeZone };
  }
  const now = new Date(nowMs);
  const cw = calendarWindow(30, now);
  return { ...cw, periodEndMs: nowMs, until: localDateKey(now), timeZone: validTimeZone(request?.timeZone) };
}

function validTimeZone(candidate: string | undefined): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!candidate) return fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format();
    return candidate;
  } catch {
    return fallback;
  }
}

function nextDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return next.toISOString().slice(0, 10);
}

function calendarDayDistance(since: string, until: string): number {
  return Math.max(0, Math.round((Date.parse(`${until}T00:00:00.000Z`) - Date.parse(`${since}T00:00:00.000Z`)) / 86_400_000));
}

function zonedMidnightMs(dateKey: string, timeZone: string): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  const targetUtc = Date.UTC(year, month - 1, day);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  let candidate = targetUtc;
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]));
    const representedAsUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second),
    );
    const correction = targetUtc - representedAsUtc;
    candidate += correction;
    if (correction === 0) break;
  }
  return candidate;
}

function resolveAnalyticsWindow(costWindow: CostWindow, periodEndMs = Date.now()): { periodStartMs: number; windowDays: number; since: string } {
  if (costWindow === "all") {
    return { periodStartMs: 0, windowDays: 0, since: new Date(0).toISOString().slice(0, 10) };
  }
  const windowDays = costWindow === "7d" ? 7 : 30;
  return calendarWindow(windowDays, new Date(periodEndMs));
}

// Align the window to whole local calendar days: it covers exactly `windowDays`
// days (today plus the previous windowDays-1), starting at local midnight. This
// keeps the distinct active-day count from ever exceeding windowDays (e.g. 8/7),
// which a rolling now-minus-N×24h start would otherwise allow at day boundaries.
function calendarWindow(windowDays: number, now = new Date()): { periodStartMs: number; windowDays: number; since: string } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (windowDays - 1));
  return { periodStartMs: start.getTime(), windowDays, since: localDateKey(start) };
}

function localDateKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

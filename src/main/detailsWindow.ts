import type { UpdateUiState } from "./updateState";
import { formatPathListForLog } from "./pathDiagnostics";
import { app, BrowserWindow, screen, Tray } from "electron";
import fs from "node:fs/promises";
import { Worker } from "node:worker_threads";
import path from "path";
import {
  getFxCachePath, getLiteLLMModelPricesPath,
  getPortableMigrationPath,
  getWindowHistoryPath
} from "../config/paths";
import type { CostWindow, Settings, ViewMode } from "../config/settings";
import {
  loadSettings,
  normalizeNotificationSettings,
  normalizeProxySettings,
  saveSettings,
  type ProxySettings,
} from "../config/settings";
import { parseMigrationState } from "../portable/migration";
import { getSharedUsageStore } from "../portable/usageStore";
import { sharedFxFetcher } from "../pricing/fx-fetcher";
import { planChangePoints } from "../pricing/plan-cost";
import { UsageSnapshot } from "../providers/types";
import { generateUsageReport, portableReadRange } from "../reports/reportService";
import type { ReportRequest } from "../reports/types";
import { loadWindowHistoryFile, mergeWindowHistory, saveWindowHistoryFile } from "../usage/windowHistoryStore";
import { mergeSettingsWithAgentRoots } from "./agentRootDiscovery";
import { computeCacheHitRate, type AnalyticsData, type AnalyticsSummary } from "./analyticsSummary";
import type { AnalyticsWorkerSettings, WindowBudgetData, WindowHistoryData } from "./analyticsWorker";
import { detectAppVariant } from "./appIdentity";
import { AsyncResultCache } from "./asyncResultCache";
import { readDataSourceInfo } from "./dataSourceStatus";
import type { DebugRecorder } from "./debugRecorder";
import { configureHttpProxy, getActiveProxyUrl, httpFetch } from "./httpClient";
import { log } from "./logging";
import type { ModelsData } from "./modelsData";
import type { NotificationService } from "./notifications";
import { QuickStatsLoadMetric } from "./quickStatsLoadMetric";
import { hardenRendererWindow, rendererIpc } from "./rendererSecurity";
import { mergeAndSaveSettings } from "./settingsSave";
import { registerSystemIpc } from "./systemIpc";
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

/**
 * Cache-hit rate is a ratio that drifts by tiny amounts between polls. Rounding
 * it into the key keeps entries reusable across ticks while still separating
 * genuinely different inputs.
 */
function cacheHitRateKey(rate: { claude: number; codex: number }): string {
  return `${rate.claude.toFixed(3)}/${rate.codex.toFixed(3)}`;
}

export async function portableDataIsReady(
  statePath = getPortableMigrationPath(),
  store = getSharedUsageStore(path.dirname(statePath)),
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
          sandbox: true,
          preload: path.join(__dirname, "preload.js"),
        },
      });

      const htmlPath = path.join(__dirname, "../../src/renderer/index.html");
      hardenRendererWindow(this.win, htmlPath, "dashboard");
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

  notifyUpdateState(state: UpdateUiState): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send("update:state", state);
  }

  /** Called by RefreshLoop listener — push new data to the open window. */
  notifyUpdate(snapshots: UsageSnapshot[]): void {
    this.lastSnapshots = snapshots;
    this.lastRefreshedAt = new Date();
    this.clearSnapshotDerivedCaches();
    this.pushUpdate();
  }

  /**
   * A poll tick only brings fresh quota percentages from the provider APIs; the
   * token history behind analytics and models is untouched. Recomputing those
   * costs seconds on a large store, so only the caches that actually read from
   * snapshots are dropped here. Cache-hit rate does feed the analytics tasks,
   * so it is part of their cache keys instead of a reason to discard them.
   */
  private clearSnapshotDerivedCaches(): void {
    this.windowBudgetCache.clear();
    this.windowHistoryCache.clear();
  }

  /** Usage data itself changed (settings, plans, ingestion) — drop everything. */
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
    const cacheKey = `summary:${costWindow}:${cacheHitRateKey(cacheHitRate)}`;

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

  /**
   * Warms the worker and portable summary store before the dashboard opens.
   * Reached only after ingestion actually changed the store (refreshPortableData
   * returns "unchanged" before this), so it is the point where cached analytics
   * built on the old event set must be dropped.
   */
  async prewarmAnalytics(): Promise<void> {
    if (!await this.isPortableDataReady()) throw new Error("Portable analytics prewarm is not ready");
    this.clearAnalyticsCaches();
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
    registerSystemIpc(() => this.quickStatsLoadMetric.valueMs);
    rendererIpc.on("quota:ready", async () => {
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

    rendererIpc.on("window:toggle-pin", () => {
      this.isPinned = !this.isPinned;
      log.debug(`Dashboard pin toggled: ${this.isPinned}`);
      if (this.win && !this.win.isDestroyed()) {
        this.win.webContents.send("window:pin-state", this.isPinned);
      }
      void loadSettings().then(s => saveSettings({ ...s, pinned: this.isPinned }));
    });

    rendererIpc.on("quota:refresh", () => {
      log.debug("Dashboard window requested refresh");
      this.handleDashboardRefresh(this._onRefreshRequest ?? (() => {}));
    });

    rendererIpc.on("quota:recompute-cost", () => {
      log.debug("Dashboard window requested cost recompute");
      (this._onRecomputeRequest ?? (() => {}))();
    });

    rendererIpc.on("window:close", () => {
      this.hide();
    });

    rendererIpc.handle("settings:get", async () => {
      return await loadSettings();
    });

    rendererIpc.handle("app:meta", () => ({
      version: app.getVersion(),
      variant: detectAppVariant(),
    }));

    rendererIpc.handle("settings:save", async (_, partial: Record<string, unknown>) => {
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
    rendererIpc.handle("settings:test-proxy", async (_, raw: unknown) => {
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

    rendererIpc.handle("reports:get", async (_, request: ReportRequest) => {
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

    // The analytics tab needs the same time range split by provider. Asking
    // twice re-reads and re-adapts the whole range for each call; reading the
    // events once and building both reports from them is several times faster.
    rendererIpc.handle("reports:get-batch", async (_, request: ReportRequest & { providers?: unknown }) => {
      if (!await this.isPortableDataReady()) return PORTABLE_DATA_PREPARING;
      const settings = await loadRuntimeSettings();
      const providers = Array.isArray(request.providers)
        ? request.providers.filter((item): item is "claude" | "codex" => item === "claude" || item === "codex")
        : ["claude", "codex"] as const;
      const { providers: _ignored, ...base } = request;
      const range = portableReadRange(base.since, base.until);
      const usageEvents = await getSharedUsageStore().read(range);
      const reports = await Promise.all(providers.map((provider) => generateUsageReport(
        { ...base, provider, source: "portable" },
        { settings, usageEvents },
      )));
      return Object.fromEntries(providers.map((provider, index) => [provider, reports[index]]));
    });

    rendererIpc.handle("analytics:summary", async (_, request?: { costWindow?: string }) => {
      if (!await this.isPortableDataReady()) return PORTABLE_DATA_PREPARING;
      const settings = await this.runtimeSettings();
      const costWindow = normalizeCostWindow(request?.costWindow) ?? settings.costWindow;
      return this.computeSummary(settings, costWindow);
    });

    rendererIpc.handle("analytics:get", async (_, request?: { since?: string; until?: string; timeZone?: string }) => {
      if (!await this.isPortableDataReady()) return PORTABLE_DATA_PREPARING;
      const settings     = await this.runtimeSettings();
      const { since, until } = resolveAnalyticsGetWindow(request, this.nowMs());
      const cacheHitRate = computeCacheHitRate(this.lastSnapshots);

      const needsFx = settings.plans.some((p) => p.currency === "EUR");
      if (needsFx) await sharedFxFetcher.ensureRange(since, until);
      const eurUsdRates = sharedFxFetcher.exportRange("EURUSD", since, until);
      const fxEstimated = sharedFxFetcher.estimated;
      const planSig = JSON.stringify(settings.plans);

      return this.analyticsDataCache.get(`get:${since}:${until}:${request?.timeZone ?? "local"}:${planSig}:${cacheHitRateKey(cacheHitRate)}`, () => this.requestAnalyticsWorker(
        createAnalyticsGetRequest(settings, request, cacheHitRate, this.nowMs(), eurUsdRates, fxEstimated),
      ) as Promise<AnalyticsData>);
    });

    rendererIpc.handle("plans:get", async () => {
      const settings = await loadSettings();
      return settings.plans;
    });

    rendererIpc.handle("plans:save", async (_, plans: unknown) => {
      const current = await loadSettings();
      await saveSettings({ ...current, plans: Array.isArray(plans) ? (plans as typeof current.plans) : [] });
      this.clearAnalyticsCaches();
      log.info("Plans saved via dashboard");
      return { ok: true };
    });

    rendererIpc.handle("fx:status", () => ({ estimated: sharedFxFetcher.estimated }));

    rendererIpc.handle("dataSources:get", () => ({
      litellm: readDataSourceInfo("litellm", getLiteLLMModelPricesPath()),
      fx: readDataSourceInfo("fx", getFxCachePath()),
    }));

    rendererIpc.handle("models:get", async () => {
      if (!await this.isPortableDataReady()) return PORTABLE_DATA_PREPARING;
      const settings = await loadSettings();
      return this.modelsDataCache.get("models", () => this.requestAnalyticsWorker({
        task: "models",
        settings: analyticsWorkerSettings(settings),
        usageRange: { since: "1970-01-01T00:00:00.000Z", until: new Date().toISOString() },
      }) as Promise<ModelsData>);
    });

    rendererIpc.handle("windowBudget:get", async () => {
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
            // null = kein 5h-Fenster: Serie und Forecast bleiben, nur die
            // Umrechnung in 5h-Fenster und deren Reset-Marker entfallen.
            windowsPerWeek: budget.weeklyOnly ? null : budget.windowsPerWeek,
            burnRatePctPerHour: weekly.burnRatePctPerHour ?? null,
            pace: weekly.pace ?? null,
            planType: s.planType ?? null,
          }];
        });
      if (providers.length === 0) return { perProvider: {} };
      return this.windowBudgetCache.get(JSON.stringify(providers), () =>
        this.requestAnalyticsWorker({
          task: "windowBudget",
          nowMs: this.nowMs(),
          usageRange: { since: new Date(this.nowMs() - 28 * 24 * 3600 * 1000).toISOString(), until: new Date(this.nowMs()).toISOString() },
          quotaRange: { since: new Date(this.nowMs() - 28 * 24 * 3600 * 1000).toISOString(), until: new Date(this.nowMs()).toISOString() },
          providers,
        }) as Promise<WindowBudgetData>
      );
    });

    rendererIpc.handle("windowHistory:get", async () => {
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

    rendererIpc.handle("window:set-view", async (_, mode: string) => {
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

    rendererIpc.handle("notification:history", () => {
      return this.notificationService?.history.getRecent(20) ?? [];
    });

    rendererIpc.handle("notification:test", () => {
      this.notificationService?.sendTest();
      return { ok: true };
    });

    rendererIpc.handle("notification:settings:save", async (_, partial: Record<string, unknown>) => {
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

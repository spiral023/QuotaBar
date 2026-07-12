import path from "node:path";
import { app, shell } from "electron";
import { configureAppIdentity, ensureWindowsNotificationShortcut, detectAppVariant } from "./appIdentity";
import { isFirstRun } from "../config/firstRun";
import { loadSettings, saveSettings, normalizeNotificationSettings } from "../config/settings";
import { createProviderRegistry } from "../providers/providerRegistry";
import { PricingEngine } from "../pricing/subscription-factor";
import { RefreshLoop } from "../usage/refreshLoop";
import { UsageStore } from "../usage/usageStore";
import { applyStartupFlag } from "./autostart";
import { initializeLogging, log } from "./logging";
import { configureHttpProxy } from "./httpClient";
import { TrayController } from "./tray";
import { DetailsWindowController } from "./detailsWindow";
import { openOnboardingWindow } from "./onboardingWindow";
import { initializeUpdater, setUpdateReadyCallback, setUpdateManualCallback, quitAndInstall } from "./updater";
import { NotificationService, RELEASES_URL } from "./notifications";
import { collectSystemData, formatSystemPathDiagnostics, formatWslDiscoveryDiagnostics } from "./systemData";
import { getRuntimeAgentRoots, mergeSettingsWithAgentRoots, refreshRuntimeWslAgentRoots } from "./agentRootDiscovery";
import { DebugRecorder } from "./debugRecorder";
import { runBackfill, BACKFILL_REPAIR_VERSION } from "./debugBackfill";
import { getRepairedVersion, setRepairedVersion } from "./backfillManifest";
import { getDebugLogDir, getClaudeProjectsDirs, getCodexSessionsDirs, getCodexConfigPaths, getUsageSnapshotCachePath, getWindowRatioPath, getBonusStatePath } from "../config/paths";
import { WindowRatioTracker, clearTransients } from "../usage/windowRatio";
import { loadWindowRatioFile, saveWindowRatioFile } from "../usage/windowRatioStore";
import { BonusResetTracker } from "../usage/bonusReset";
import { loadBonusStateFile, saveBonusStateFile } from "../usage/bonusStateStore";
import { seedFromDebugLogs } from "./windowRatioSeeder";
import { LiteLLMFetcher } from "../pricing/litellm-fetcher";
import { HistoricalPricingResolver } from "../pricing/historical-pricing-resolver";
import { loadCachedSnapshots, markSnapshotsFromCache, saveCachedSnapshots } from "../usage/snapshotCache";
import { registerLifecycleEvents } from "./lifecycleEvents";

interface CliOptions {
  debug: boolean;
  noWindow: boolean;
  openWindow: boolean;
  pollIntervalSeconds?: number;
  startupAction: "install" | "uninstall" | null;
}

const cli = parseCliArgs(process.argv.slice(2));
initializeLogging(cli.debug);
log.info("--- QuotaBar session start ---");
configureAppIdentity();

// Wird in whenReady gesetzt, sobald der NotificationService existiert. Der
// second-instance-Handler kann eine quotabar://-Aktivierung dann weiterreichen.
let onProtocolUrl: ((url: string) => void) | null = null;

function findProtocolUrl(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.startsWith("quotabar://")) ?? null;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    log.info("Second instance attempted; existing tray instance kept");
    // Klick auf eine Windows-Toast (Body oder Button) startet einen neuen
    // Prozess mit der quotabar://-URL in argv. Hier an die laufende Instanz
    // weiterreichen, statt eine zweite (generische) App zu öffnen.
    const url = findProtocolUrl(argv);
    if (url && onProtocolUrl) onProtocolUrl(url);
  });

  app.whenReady()
    .then(async () => {
      ensureWindowsNotificationShortcut();
      // quotabar://-Protokoll registrieren, damit Windows Toast-Aktivierungen an
      // diese App weiterleitet (Voraussetzung für funktionierende Toast-Buttons).
      if (process.platform === "win32") {
        if (app.isPackaged) {
          app.setAsDefaultProtocolClient("quotabar");
        } else if (process.argv.length >= 2) {
          // Dev: electron.exe mit Projektpfad als Argument registrieren.
          app.setAsDefaultProtocolClient("quotabar", process.execPath, [path.resolve(process.argv[1])]);
        }
      }
      applyStartupFlag(cli.startupAction);

      const firstRun = await isFirstRun();
      const settings = await loadSettings(cli.pollIntervalSeconds ? { pollIntervalSeconds: cli.pollIntervalSeconds } : {});
      const appVariant = detectAppVariant();
      log.info(`QuotaBar startup: version=${app.getVersion()} variant=${appVariant.id} packaged=${app.isPackaged} noWindow=${cli.noWindow}`);
      // Route live requests through a proxy when configured. This must run
      // before the first refresh, but failures must never block startup.
      await configureHttpProxy(settings.proxy).catch((err: unknown) => {
        log.warn(`Proxy init failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
      const recorder = new DebugRecorder({
        enabled: settings.debugLog.enabled,
        logDir: getDebugLogDir(),
      });
      recorder.write({
        kind: "app.start",
        version: app.getVersion(),
        variant: appVariant.id,
        pollIntervalSeconds: settings.pollIntervalSeconds,
        noWindow: cli.noWindow,
        platform: process.platform,
      });
      await refreshRuntimeWslAgentRoots()
        .then(({ discovery, roots }) => {
          for (const line of formatWslDiscoveryDiagnostics(discovery)) log.info(line);
          log.info(`WSL discovery: runtime roots claudeRoots=${formatPathListForLog(roots.claudeRoots)} codexHomes=${formatPathListForLog(roots.codexHomes)}`);
        })
        .catch((err: unknown) => {
          log.warn(`WSL discovery failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      const loadRuntimeSettings = async () => mergeSettingsWithAgentRoots(await loadSettings());
      const runtimeSettings = mergeSettingsWithAgentRoots(settings);
      const providers = createProviderRegistry(settings.providerTimeoutMs, loadRuntimeSettings);
      if (firstRun) openOnboardingWindow(providers);
      const usageSnapshotCachePath = getUsageSnapshotCachePath();
      const cachedSnapshots = markSnapshotsFromCache(await loadCachedSnapshots(usageSnapshotCachePath));
      const store = new UsageStore(cachedSnapshots);
      const pricingEngine = new PricingEngine(runtimeSettings, undefined, undefined, undefined, loadRuntimeSettings);
      const windowRatioPath = getWindowRatioPath();
      const ratioFile = await loadWindowRatioFile(windowRatioPath);
      const windowRatioTracker = new WindowRatioTracker(clearTransients(ratioFile));
      if (!ratioFile.seededThrough) {
        // Einmal-Seed aus vorhandenen Debug-Logs — bewusst nicht awaited,
        // damit der App-Start nicht auf das Log-Parsing wartet.
        void seedFromDebugLogs(getDebugLogDir())
          .then((seed) => {
            // Safe to race with the first live record() calls: mergeSeed only
            // adds to the running sums and never touches the lastFive/lastWeekly
            // transients, so no observation pair is double-counted or lost.
            windowRatioTracker.mergeSeed(seed);
            return saveWindowRatioFile(windowRatioPath, windowRatioTracker.getFile());
          })
          .catch((err: unknown) => {
            log.warn(`Window-ratio seed failed: ${err instanceof Error ? err.message : String(err)}`);
          });
      }
      const bonusStatePath = getBonusStatePath();
      const bonusTracker = new BonusResetTracker(await loadBonusStateFile(bonusStatePath));
      const refreshLoop = new RefreshLoop(providers, store, settings.pollIntervalSeconds, settings.providerTimeoutMs, pricingEngine, recorder, windowRatioTracker, bonusTracker);
      const backfillFetcher = new LiteLLMFetcher(settings.pricingOfflineMode);
      const backfillPricingResolver = new HistoricalPricingResolver(backfillFetcher);
      const tray = new TrayController(providers, refreshLoop, async () => {
        const currentSettings = await loadSettings();
        const runtime = mergeSettingsWithAgentRoots(currentSettings);
        const pathContext = { claudeRoots: runtime.claudeRoots ?? [], codexHomes: runtime.codexHomes ?? [] };
        await runBackfill({
          recorder,
          logDir: getDebugLogDir(),
          claudeProjectsDirs: getClaudeProjectsDirs(pathContext),
          codexSessionsDirs: getCodexSessionsDirs(pathContext),
          codexConfigPaths: getCodexConfigPaths(pathContext),
          pricingResolver: backfillPricingResolver,
          force: true,
        }).catch((err: unknown) => {
          log.warn(`Backfill regenerate failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }, settings.providerOrder);
      const detailsWindow = new DetailsWindowController(
        () => tray.getTray(),
        recorder,
        (savedSettings, changedKeys) => {
          if (changedKeys.includes("providerOrder")) {
            tray.setProviderOrder(savedSettings.providerOrder);
          }
        },
      );
      tray.setDetailsWindow(detailsWindow);
      if (cachedSnapshots.length > 0) {
        tray.setSnapshots(cachedSnapshots);
        detailsWindow.notifyUpdate(cachedSnapshots);
      }
      // Analytics-Worker früh hochfahren und die JSONL-Historie parsen, damit die
      // Quick Stats beim ersten Dashboard-Öffnen nicht auf einen Kaltstart warten.
      detailsWindow.prewarmAnalytics();
      await tray.rebuildMenu();
      if (cli.openWindow) {
        setTimeout(() => detailsWindow.open(
          () => void refreshLoop.refreshNow("dashboard"),
          () => void refreshLoop.recomputeCost(),
        ), 1500);
      }
      const notificationService = new NotificationService(settings.notifications);
      detailsWindow.setNotificationService(notificationService);
      notificationService.setActionHandlers({
        openDashboard: (tab = "live") => detailsWindow.open(
          () => void refreshLoop.refreshNow("dashboard"),
          () => void refreshLoop.recomputeCost(),
          { tab },
        ),
        muteRule: async (ruleId: string) => {
          const current = await loadSettings();
          const rules = current.notifications.rules as unknown as Record<string, { enabled: boolean }>;
          if (rules[ruleId]) rules[ruleId].enabled = false;
          const merged = normalizeNotificationSettings(current.notifications);
          await saveSettings({ ...current, notifications: merged });
          return merged;
        },
        installUpdate: () => quitAndInstall(),
        // "Later" suppresses the re-notification for this version only — the downloaded
        // update still installs silently on next quit (autoInstallOnAppQuit = true).
        dismissUpdate: (version: string) => notificationService.dismissUpdateVersion(version),
        // ZIP/Portable: kein Auto-Update, daher Verweis auf die GitHub-Releases.
        openReleasesPage: () => void shell.openExternal(RELEASES_URL),
      });
      // Toast-Aktivierungen (quotabar://…) an den NotificationService weiterreichen.
      onProtocolUrl = (url: string) => notificationService.handleProtocolUrl(url);
      // Kaltstart über eine Toast: URL steht bereits in den Startargumenten.
      const initialUrl = findProtocolUrl(process.argv);
      if (initialUrl) onProtocolUrl(initialUrl);
      void collectSystemData({
          appVariant,
          ...runtimeRootContext(),
        })
        .then((report) => {
          const diagnostics = formatSystemPathDiagnostics(report, {
            settings,
            env: process.env,
            platform: process.platform,
          });
          for (const line of diagnostics.info) log.info(line);
          for (const line of diagnostics.debug) log.debug(line);
          notificationService.sendMissingPlanAlerts(report, settings.plans);
        })
        .catch((err: unknown) => {
          log.warn(`Missing-plan notification scan failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      refreshLoop.onRefresh((snapshots) => {
        notificationService.onRefresh(snapshots);
        detailsWindow.notifyUpdate(snapshots);
        void saveCachedSnapshots(usageSnapshotCachePath, snapshots).catch((err: unknown) => {
          log.warn(`Usage snapshot cache save failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        void saveWindowRatioFile(windowRatioPath, windowRatioTracker.getFile()).catch((err: unknown) => {
          log.warn(`Window-ratio save failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        void saveBonusStateFile(bonusStatePath, bonusTracker.getFile()).catch((err: unknown) => {
          log.warn(`Bonus-state save failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      });
      refreshLoop.start();
      registerLifecycleEvents({
        recorder,
        onResume: (sleepSeconds: number) => {
          tray.notifyStaleAfterResume(sleepSeconds);
          const doRefresh = (): void => {
            void refreshLoop.refreshNow("interval").catch((err: unknown) => {
              log.warn(`Resume refresh failed: ${err instanceof Error ? err.message : String(err)}`);
            });
          };
          // Nach längerem Sleep braucht das OS etwas Zeit für DNS – kurz warten
          if (sleepSeconds > 60) {
            const t = setTimeout(doRefresh, 8_000);
            t.unref();
          } else {
            doRefresh();
          }
        },
      });
      const backfillTimer = setTimeout(() => {
        void (async () => {
          const logDir = getDebugLogDir();
          // Erster Start nach einem datenverändernden Fix → einmaliger Force-Rebuild,
          // der alle bereits beschädigten Tagessätze neu berechnet. Danach läuft der
          // Backfill wieder inkrementell.
          const needsRepair = (await getRepairedVersion(logDir)) < BACKFILL_REPAIR_VERSION;
          if (needsRepair) {
            log.info(`Backfill repair: forcing one-time rebuild to version ${BACKFILL_REPAIR_VERSION}`);
          }
          const currentSettings = await loadSettings();
          const runtime = mergeSettingsWithAgentRoots(currentSettings);
          const pathContext = { claudeRoots: runtime.claudeRoots ?? [], codexHomes: runtime.codexHomes ?? [] };
          const result = await runBackfill({
            recorder,
            logDir,
            claudeProjectsDirs: getClaudeProjectsDirs(pathContext),
            codexSessionsDirs: getCodexSessionsDirs(pathContext),
            codexConfigPaths: getCodexConfigPaths(pathContext),
            pricingResolver: backfillPricingResolver,
            force: needsRepair,
          });
          // Marker nur setzen, wenn der Rebuild fehlerfrei durchlief – sonst beim
          // nächsten Start erneut versuchen.
          if (needsRepair && result.errors.length === 0) {
            await setRepairedVersion(logDir, BACKFILL_REPAIR_VERSION);
          }
        })().catch((err: unknown) => {
          log.warn(`Backfill failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }, 15_000);
      backfillTimer.unref();
      let flushed = false;
      app.on("before-quit", (event) => {
        if (flushed) return;
        event.preventDefault();
        recorder.write({ kind: "app.exit", reason: "user-quit" });
        void recorder.flush().finally(() => {
          flushed = true;
          app.quit();
        });
      });
      // Nur die installierte Variante kann sich selbst aktualisieren. ZIP/Portable
      // erhalten nur eine Benachrichtigung mit Verweis auf GitHub.
      await initializeUpdater({
        onStateChange: (updateState) => tray.setUpdateState(updateState),
        canAutoUpdate: appVariant.id === "installed",
      });
      setUpdateReadyCallback((version: string) => {
        notificationService.sendUpdateReady(version);
      });
      setUpdateManualCallback((version: string) => {
        notificationService.sendUpdateAvailableManual(version);
      });
      log.info(`QuotaBar started; poll interval ${settings.pollIntervalSeconds}s; noWindow=${cli.noWindow}`);
    })
    .catch((error: unknown) => {
      log.error(`Startup failed: ${error instanceof Error ? error.message : String(error)}`);
      app.quit();
    });
}

app.on("window-all-closed", () => {
  // Keep the tray app alive even if Electron ever creates/closes an auxiliary window.
});

function parseCliArgs(args: string[]): CliOptions {
  const options: CliOptions = { debug: false, noWindow: false, openWindow: false, startupAction: null };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--log-debug" || arg === "--debug") options.debug = true;
    else if (arg === "--no-window") options.noWindow = true;
    else if (arg === "--open-window") options.openWindow = true;
    else if (arg === "--install-startup") options.startupAction = "install";
    else if (arg === "--uninstall-startup") options.startupAction = "uninstall";
    else if (arg === "--poll-interval-seconds") {
      const value = Number(args[index + 1]);
      if (Number.isFinite(value) && value > 0) {
        options.pollIntervalSeconds = value;
      }
      index++;
    }
  }
  return options;
}

function runtimeRootContext(): { wslClaudeRoots: string[]; wslCodexHomes: string[] } {
  const roots = getRuntimeAgentRoots();
  return {
    wslClaudeRoots: roots.claudeRoots,
    wslCodexHomes: roots.codexHomes,
  };
}

function formatPathListForLog(paths: string[]): string {
  return paths.length === 0 ? "[]" : `[${paths.join(", ")}]`;
}

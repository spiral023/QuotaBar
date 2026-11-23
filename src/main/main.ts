import { app, shell } from "electron";
import path from "node:path";
import { getBonusStatePath, getClaudeProjectsDirs, getCodexConfigPaths, getCodexSessionsDirs, getDebugLogDir, getLegacyQuotaImportManifestPath, getPortableIngestStatePath, getPortableMigrationPath, getPortableQuotaDir, getPortableUsageDir, getUsageSnapshotCachePath, getWindowRatioPath } from "../config/paths";
import { isNotificationRuleId, loadSettings, normalizeNotificationSettings, updateSettings } from "../config/settings";
import { enrichPortableEventCosts } from "../portable/costEnrichment";
import { ingestPortableUsage } from "../portable/ingestion";
import { beginMigrationRefresh, beginMigrationRefreshRecovery, markMigrationComplete, markMigrationFailed, markMigrationRunning, migrateLegacyData, readCompleteMigrationRevision } from "../portable/migration";
import { appendQuotaSnapshots } from "../portable/quotaStore";
import { getSharedUsageStore } from "../portable/usageStore";
import { readCodexSpeedTierFromPaths } from "../pricing/codex-cost-calculator";
import { HistoricalPricingResolver } from "../pricing/historical-pricing-resolver";
import { LiteLLMFetcher } from "../pricing/litellm-fetcher";
import { PricingEngine } from "../pricing/subscription-factor";
import { createProviderRegistry } from "../providers/providerRegistry";
import { readBackfillDayRecords } from "../reports/backfill-reader";
import { errnoSuffix } from "../shared/errors";
import { BonusResetTracker } from "../usage/bonusReset";
import { loadBonusStateFile, saveBonusStateFile } from "../usage/bonusStateStore";
import { RefreshLoop } from "../usage/refreshLoop";
import { loadCachedSnapshots, markSnapshotsFromCache, saveCachedSnapshots } from "../usage/snapshotCache";
import { UsageStore } from "../usage/usageStore";
import { WindowRatioTracker, clearTransients } from "../usage/windowRatio";
import { loadWindowRatioFile, saveWindowRatioFile } from "../usage/windowRatioStore";
import { getRuntimeAgentRoots, mergeSettingsWithAgentRoots, refreshRuntimeWslAgentRoots } from "./agentRootDiscovery";
import { configureAppIdentity, detectAppVariant, ensureWindowsNotificationShortcut } from "./appIdentity";
import { applyStartupFlag } from "./autostart";
import { parseRuntimeCliArgs } from "./cli";
import { createIncrementalLegacyQuotaImport, createPortableIngestionLifecycle, createPortableIngestionRunner, preparePortableData, refreshPortableData, type PortableIngestionLifecycle } from "./debugBackfill";
import { snapshotEvent } from "./debugEvents";
import { DebugRecorder } from "./debugRecorder";
import { DetailsWindowController } from "./detailsWindow";
import { configureHttpProxy } from "./httpClient";
import { registerLifecycleEvents } from "./lifecycleEvents";
import { flushLogging, initializeLogging, log } from "./logging";
import { NotificationService, RELEASES_URL } from "./notifications";
import { openOnboardingWindow } from "./onboardingWindow";
import { loadInitialStartupState } from "./pendingImportStartup";
import { createShutdownDrain } from "./shutdown";
import { watchSourceRoots, type SourceChangeWatcher } from "./sourceChangeWatcher";
import { collectSystemData, formatSystemPathDiagnostics, formatWslDiscoveryDiagnostics } from "./systemData";
import { TrayController } from "./tray";
import { initializeUpdater, quitAndInstall, setUpdateManualCallback, setUpdateReadyCallback } from "./updater";
import { seedFromDebugLogs } from "./windowRatioSeeder";

const cli = parseRuntimeCliArgs(process.argv, app.isPackaged);
initializeLogging(cli.debug);
log.info("--- QuotaBar session start ---");
configureAppIdentity();

// Wird in whenReady gesetzt, sobald der NotificationService existiert. Der
// second-instance-Handler kann eine quotabar://-Aktivierung dann weiterreichen.
let onProtocolUrl: ((url: string) => void) | null = null;
let portableIngestionLifecycle: PortableIngestionLifecycle | undefined;
let sourceChangeWatcher: SourceChangeWatcher | undefined;

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
      await portableIngestionLifecycle?.stop();
      portableIngestionLifecycle = undefined;
      sourceChangeWatcher?.close();
      sourceChangeWatcher = undefined;
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

      const { firstRun, settings } = await loadInitialStartupState(
        cli.pollIntervalSeconds ? { pollIntervalSeconds: cli.pollIntervalSeconds } : {},
      );
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
      const portableUsageStore = getSharedUsageStore(getPortableUsageDir());
      const portablePricingResolver = new HistoricalPricingResolver(new LiteLLMFetcher(runtimeSettings.pricingOfflineMode));
      sourceChangeWatcher = watchSourceRoots([
        ...getClaudeProjectsDirs({ claudeRoots: runtimeSettings.claudeRoots ?? [], codexHomes: runtimeSettings.codexHomes ?? [] }),
        ...getCodexSessionsDirs({ claudeRoots: runtimeSettings.claudeRoots ?? [], codexHomes: runtimeSettings.codexHomes ?? [] }),
      ]);
      const ingestPortableSources = async () => {
        const currentSettings = mergeSettingsWithAgentRoots(await loadSettings());
        const pathContext = {
          claudeRoots: currentSettings.claudeRoots ?? [],
          codexHomes: currentSettings.codexHomes ?? [],
        };
        const codexSpeed = await readCodexSpeedTierFromPaths(getCodexConfigPaths(pathContext));
        return await ingestPortableUsage({
          store: portableUsageStore,
          statePath: getPortableIngestStatePath(),
          claudeProjectsDirs: getClaudeProjectsDirs(pathContext),
          codexSessionsDirs: getCodexSessionsDirs(pathContext),
          enrichCosts: (events) => enrichPortableEventCosts(events, portablePricingResolver, codexSpeed),
        });
      };
      const tray = new TrayController(providers, refreshLoop, async () => {
        await portableIngestionLifecycle?.trigger("manual-recompute");
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
      // Preparing portable data takes seconds on a large history (ingest, legacy
      // reconciliation, quota migration). It is started only once the live path
      // below is up, so quota polling, notifications and the tray menu no longer
      // wait for it. Shutdown waits for it instead of cutting a commit short.
      let portableStartupStopped = false;
      let portableStartup: Promise<void> = Promise.resolve();
      const legacyQuotaImport = createIncrementalLegacyQuotaImport({
        logDir: getDebugLogDir(),
        quotaDir: getPortableQuotaDir(),
        manifestPath: getLegacyQuotaImportManifestPath(),
        append: appendQuotaSnapshots,
      });
      const startPortableData = async (): Promise<void> => {
        let portableReady = false;
        await preparePortableData({
          beginMigration: () => markMigrationRunning(getPortableMigrationPath()),
          ingestProviderEvents: ingestPortableSources,
          readLegacyRecords: () => readBackfillDayRecords(getDebugLogDir()),
          reconcileLegacy: (records) => migrateLegacyData({
            store: portableUsageStore,
            records,
            statePath: getPortableMigrationPath(),
            finalizeState: false,
          }),
          readLegacyQuota: () => legacyQuotaImport.read(),
          migrateQuota: (snapshots) => legacyQuotaImport.migrate(snapshots),
          completeMigration: (revision) => markMigrationComplete(getPortableMigrationPath(), revision, portableUsageStore),
          failMigration: (code, expectation) => markMigrationFailed(
            getPortableMigrationPath(),
            code,
            expectation,
            portableUsageStore,
          ),
          prewarmConsumers: () => detailsWindow.prewarmAnalytics(),
          onStageComplete: (stage, durationMs, count) => {
            log.info(`Portable data stage=${stage} count=${count} durationMs=${durationMs}`);
          },
        }).then((result) => {
          portableReady = result.status === "complete";
        }).catch((err: unknown) => {
          log.warn(`Portable data preparation failed${errnoSuffix(err)}`);
        });
        if (portableReady && !portableStartupStopped) {
          portableIngestionLifecycle = createPortableIngestionLifecycle(createPortableIngestionRunner(async () => {
            await refreshPortableData({
              readCompleteRevision: () => readCompleteMigrationRevision(getPortableMigrationPath()),
              readStoreRevision: () => portableUsageStore.getRevision(),
              recoverRefresh: () => beginMigrationRefreshRecovery(getPortableMigrationPath()),
              ingestProviderEvents: ingestPortableSources,
              beginRefresh: (revision) => beginMigrationRefresh(getPortableMigrationPath(), revision),
              readLegacyRecords: () => readBackfillDayRecords(getDebugLogDir()),
              reconcileLegacy: (records, owner) => migrateLegacyData({
                store: portableUsageStore,
                records,
                statePath: getPortableMigrationPath(),
                finalizeState: false,
                expectedOwner: owner,
              }),
              completeMigration: (revision, owner) => markMigrationComplete(
                getPortableMigrationPath(),
                revision,
                portableUsageStore,
                owner,
              ),
              failMigration: (code, expectation) => markMigrationFailed(
                getPortableMigrationPath(),
                code,
                expectation,
                portableUsageStore,
              ),
              refreshConsumers: () => detailsWindow.prewarmAnalytics(),
              onStageComplete: (stage, durationMs, count) => {
                log.info(`Portable data refresh stage=${stage} count=${count} durationMs=${durationMs}`);
              },
            });
          }, (diagnostic) => log.warn(diagnostic)), undefined, {
            shouldRun: () => sourceChangeWatcher?.consume() ?? true,
          });
          await portableIngestionLifecycle.start();
        }
      };
      const recomputeCostsAndIngest = (): void => {
        void refreshLoop.recomputeCost().finally(() => portableIngestionLifecycle?.trigger("manual-recompute"));
      };
      await tray.rebuildMenu();
      if (cli.openWindow) {
        setTimeout(() => detailsWindow.open(
          () => void refreshLoop.refreshNow("dashboard"),
          recomputeCostsAndIngest,
        ), 1500);
      }
      const notificationService = new NotificationService(settings.notifications);
      detailsWindow.setNotificationService(notificationService);
      notificationService.setActionHandlers({
        openDashboard: (tab = "live") => detailsWindow.open(
          () => void refreshLoop.refreshNow("dashboard"),
          recomputeCostsAndIngest,
          { tab },
        ),
        muteRule: async (ruleId: string) => {
          const saved = await updateSettings((current) => {
            const rules = current.notifications.rules as unknown as Record<string, { enabled: boolean }>;
            if (isNotificationRuleId(ruleId) && Object.hasOwn(rules, ruleId)) rules[ruleId].enabled = false;
            return { ...current, notifications: normalizeNotificationSettings(current.notifications) };
          });
          return saved.notifications;
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
        void appendQuotaSnapshots(getPortableQuotaDir(), snapshots.map(snapshotEvent)).catch((err: unknown) => {
          log.warn(`Portable quota snapshot save failed${errnoSuffix(err)}`);
        });
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
      portableStartup = startPortableData().catch((err: unknown) => {
        log.warn(`Portable data startup failed: ${err instanceof Error ? err.message : String(err)}`);
      });
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
      const drainShutdown = createShutdownDrain({
        stopIngestion: async () => {
          portableStartupStopped = true;
          await portableStartup;
          const lifecycle = portableIngestionLifecycle;
          portableIngestionLifecycle = undefined;
          sourceChangeWatcher?.close();
          sourceChangeWatcher = undefined;
          await lifecycle?.stop();
        },
        flushNotifications: () => notificationService.flush(),
        flushRecorder: () => recorder.flush(),
        flushLogging,
        warn: (message) => log.warn(message),
      });
      let shutdownStarted = false;
      let shutdownFinished = false;
      app.on("before-quit", (event) => {
        if (shutdownFinished) return;
        event.preventDefault();
        if (shutdownStarted) return;
        shutdownStarted = true;
        recorder.write({ kind: "app.exit", reason: "user-quit" });
        void drainShutdown().finally(() => {
          shutdownFinished = true;
          app.quit();
        });
      });
      // Nur die installierte Variante kann sich selbst aktualisieren. ZIP/Portable
      // erhalten nur eine Benachrichtigung mit Verweis auf GitHub.
      await initializeUpdater({
        onStateChange: (updateState) => {
          tray.setUpdateState(updateState);
          detailsWindow.notifyUpdateState(updateState);
        },
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

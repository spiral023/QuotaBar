import { app } from "electron";
import { runFirstRunPrompt } from "../config/firstRun";
import { loadSettings } from "../config/settings";
import { createProviderRegistry } from "../providers/providerRegistry";
import { PricingEngine } from "../pricing/subscription-factor";
import { RefreshLoop } from "../usage/refreshLoop";
import { UsageStore } from "../usage/usageStore";
import { applyStartupFlag } from "./autostart";
import { initializeLogging, log } from "./logging";
import { TrayController } from "./tray";
import { DetailsWindowController } from "./detailsWindow";
import { initializeUpdater } from "./updater";
import { NotificationService } from "./notifications";
import { DebugRecorder } from "./debugRecorder";
import { runBackfill } from "./debugBackfill";
import { getDebugLogDir, getClaudeProjectsDirs, getCodexSessionsDirs, getCodexConfigPaths, getUsageSnapshotCachePath } from "../config/paths";
import { LiteLLMFetcher } from "../pricing/litellm-fetcher";
import { loadCachedSnapshots, markSnapshotsFromCache, saveCachedSnapshots } from "../usage/snapshotCache";
import { registerLifecycleEvents } from "./lifecycleEvents";

interface CliOptions {
  debug: boolean;
  noWindow: boolean;
  pollIntervalSeconds?: number;
  startupAction: "install" | "uninstall" | null;
}

const cli = parseCliArgs(process.argv.slice(2));
initializeLogging(cli.debug);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    log.info("Second instance attempted; existing tray instance kept");
  });

  app.whenReady()
    .then(async () => {
      app.setAppUserModelId("com.quotabar.windows");
      applyStartupFlag(cli.startupAction);

      await runFirstRunPrompt();
      const settings = await loadSettings(cli.pollIntervalSeconds ? { pollIntervalSeconds: cli.pollIntervalSeconds } : {});
      const recorder = new DebugRecorder({
        enabled: settings.debugLog.enabled,
        logDir: getDebugLogDir(),
      });
      recorder.write({
        kind: "app.start",
        version: app.getVersion(),
        pollIntervalSeconds: settings.pollIntervalSeconds,
        noWindow: cli.noWindow,
        platform: process.platform,
      });
      const providers = createProviderRegistry(settings.providerTimeoutMs);
      const usageSnapshotCachePath = getUsageSnapshotCachePath();
      const cachedSnapshots = markSnapshotsFromCache(await loadCachedSnapshots(usageSnapshotCachePath));
      const store = new UsageStore(cachedSnapshots);
      const pricingEngine = new PricingEngine(settings);
      const refreshLoop = new RefreshLoop(providers, store, settings.pollIntervalSeconds, settings.providerTimeoutMs, pricingEngine, recorder);
      const backfillFetcher = new LiteLLMFetcher(settings.pricingOfflineMode);
      const tray = new TrayController(providers, refreshLoop, async () => {
        await runBackfill({
          recorder,
          logDir: getDebugLogDir(),
          claudeProjectsDirs: getClaudeProjectsDirs(),
          codexSessionsDirs: getCodexSessionsDirs(),
          codexConfigPaths: getCodexConfigPaths(),
          fetcher: backfillFetcher,
          force: true,
        }).catch((err: unknown) => {
          log.warn(`Backfill regenerate failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      });
      const detailsWindow = new DetailsWindowController(() => tray.getTray(), recorder);
      tray.setDetailsWindow(detailsWindow);
      if (cachedSnapshots.length > 0) {
        tray.setSnapshots(cachedSnapshots);
        detailsWindow.notifyUpdate(cachedSnapshots);
      }
      await tray.rebuildMenu();
      const notificationService = new NotificationService(settings.notifications);
      detailsWindow.setNotificationService(notificationService);
      refreshLoop.onRefresh((snapshots) => {
        notificationService.onRefresh(snapshots);
        detailsWindow.notifyUpdate(snapshots);
        void saveCachedSnapshots(usageSnapshotCachePath, snapshots).catch((err: unknown) => {
          log.warn(`Usage snapshot cache save failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      });
      refreshLoop.start();
      registerLifecycleEvents({
        recorder,
        onResume: (sleepSeconds: number) => {
          tray.notifyStaleAfterResume(sleepSeconds);
          void refreshLoop.refreshNow("interval").catch((err: unknown) => {
            log.warn(`Resume refresh failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        },
      });
      const backfillTimer = setTimeout(() => {
        void runBackfill({
          recorder,
          logDir: getDebugLogDir(),
          claudeProjectsDirs: getClaudeProjectsDirs(),
          codexSessionsDirs: getCodexSessionsDirs(),
          codexConfigPaths: getCodexConfigPaths(),
          fetcher: backfillFetcher,
        }).catch((err: unknown) => {
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
      await initializeUpdater();
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
  const options: CliOptions = { debug: false, noWindow: false, startupAction: null };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--log-debug" || arg === "--debug") options.debug = true;
    else if (arg === "--no-window") options.noWindow = true;
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

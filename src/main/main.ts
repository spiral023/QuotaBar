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
      const providers = createProviderRegistry(settings.providerTimeoutMs);
      const store = new UsageStore();
      const pricingEngine = new PricingEngine(settings);
      const refreshLoop = new RefreshLoop(providers, store, settings.pollIntervalSeconds, settings.providerTimeoutMs, pricingEngine);
      const tray = new TrayController(providers, refreshLoop);
      const detailsWindow = new DetailsWindowController(() => tray.getTray());
      tray.setDetailsWindow(detailsWindow);
      await tray.rebuildMenu();
      const notificationService = new NotificationService(settings.notifications);
      detailsWindow.setNotificationService(notificationService);
      refreshLoop.onRefresh((snapshots) => {
        notificationService.onRefresh(snapshots);
        detailsWindow.notifyUpdate(snapshots);
      });
      refreshLoop.start();
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

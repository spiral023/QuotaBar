import { app, ipcMain } from "electron";
import { autoUpdater } from "electron-updater";
import { log } from "./logging";
import { initialUpdateState, reduceUpdateState, UpdateUiState } from "./updateState";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const START_DELAY_MS = 20_000; // App-Init nicht blockieren

let state: UpdateUiState = initialUpdateState("0.0.0", false);
let notifyStateChange: ((state: UpdateUiState) => void) | null = null;

function apply(event: Parameters<typeof reduceUpdateState>[1]): void {
  state = reduceUpdateState(state, event);
  notifyStateChange?.(state);
}

// Adapter: electron-updater erwartet einen Logger mit (msg, ...args) – auf den
// vorhandenen String-File-Logger abbilden, niemals werfen.
function toMessage(args: unknown[]): string {
  return args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
}
const updaterLogger = {
  info: (...a: unknown[]) => log.info(`[updater] ${toMessage(a)}`),
  warn: (...a: unknown[]) => log.warn(`[updater] ${toMessage(a)}`),
  error: (...a: unknown[]) => log.error(`[updater] ${toMessage(a)}`),
  debug: (...a: unknown[]) => log.debug(`[updater] ${toMessage(a)}`),
};

export function getUpdateState(): UpdateUiState {
  return state;
}

export function checkForUpdatesNow(): void {
  if (state.status === "disabled") return;
  autoUpdater.checkForUpdates().catch((err: unknown) => {
    apply({ type: "error", message: err instanceof Error ? err.message : String(err) });
  });
}

export function quitAndInstall(): void {
  if (state.status !== "ready") return;
  // isSilent=true, isForceRunAfter=true → still installieren, danach App starten.
  autoUpdater.quitAndInstall(true, true);
}

export async function initializeUpdater(
  opts: { onStateChange?: (state: UpdateUiState) => void } = {},
): Promise<void> {
  notifyStateChange = opts.onStateChange ?? null;

  // IPC-Handler IMMER registrieren, damit der System-Tab auch im Dev funktioniert.
  ipcMain.handle("update:get-state", () => state);
  ipcMain.handle("update:check", () => {
    checkForUpdatesNow();
    return state;
  });
  ipcMain.handle("update:quit-and-install", () => {
    quitAndInstall();
    return state;
  });

  if (!app.isPackaged) {
    state = initialUpdateState(app.getVersion(), false);
    log.debug("Updater disabled: app is not packaged (dev build)");
    return;
  }

  state = initialUpdateState(app.getVersion(), true);
  autoUpdater.logger = updaterLogger;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => apply({ type: "checking" }));
  autoUpdater.on("update-available", (info) => apply({ type: "available", version: info.version }));
  autoUpdater.on("update-not-available", () => apply({ type: "not-available" }));
  autoUpdater.on("download-progress", (p) => apply({ type: "progress", percent: p.percent }));
  autoUpdater.on("update-downloaded", (info) => {
    log.info(`Update ${info.version} heruntergeladen; installiert beim Beenden`);
    apply({ type: "downloaded", version: info.version });
  });
  autoUpdater.on("error", (err) => {
    apply({ type: "error", message: err instanceof Error ? err.message : String(err) });
  });

  // Erster Check verzögert, dann periodisch (Tray-App läuft tagelang).
  const startTimer = setTimeout(() => checkForUpdatesNow(), START_DELAY_MS);
  startTimer.unref();
  const intervalTimer = setInterval(() => checkForUpdatesNow(), SIX_HOURS_MS);
  intervalTimer.unref();

  log.info(`Updater initialisiert (Version ${app.getVersion()})`);
}

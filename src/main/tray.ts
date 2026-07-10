import { Tray } from "electron";
import { renderTrayIcon } from "../icon/renderTrayIcon";
import { buildIconState } from "../icon/iconState";
import { normalizeProviderOrder, sortByProviderOrder } from "../providers/providerOrder";
import { UsageProvider, UsageSnapshot } from "../providers/types";
import { RefreshLoop } from "../usage/refreshLoop";
import { buildContextMenu } from "./menu";
import type { DetailsWindowController } from "./detailsWindow";
import { quitAndInstall } from "./updater";
import type { UpdateUiState } from "./updateState";
import { buildTooltip } from "./trayPresentation";

const STALE_RESUME_THRESHOLD_S = 300; // 5 Minuten Sleep → Stale-Indikator

export class TrayController {
  private tray: Tray;
  private snapshots: UsageSnapshot[] = [];
  private detailsWindow: DetailsWindowController | null = null;
  private isStaleAfterResume = false;
  private updateState: UpdateUiState | null = null;
  private providerOrder: string[];

  constructor(
    private readonly providers: UsageProvider[],
    private readonly refreshLoop: RefreshLoop,
    private readonly onRegenerateBackfill: () => Promise<void>,
    providerOrder?: unknown,
  ) {
    this.providerOrder = normalizeProviderOrder(providerOrder);
    this.tray = new Tray(renderTrayIcon({ bars: [], hasError: false }));
    this.tray.setToolTip("QuotaBar");
    this.tray.on("double-click", () => void this.showMenu());
    this.tray.on("click", () => void this.showMenu());
    this.tray.on("right-click", () => void this.showMenu());
    this.refreshLoop.onRefresh((snapshots) => {
      this.snapshots = snapshots;
      void this.update();
    });
  }

  getTray(): Tray {
    return this.tray;
  }

  setSnapshots(snapshots: UsageSnapshot[]): void {
    this.snapshots = snapshots;
    this.tray.setImage(renderTrayIcon(buildIconState(this.snapshots, this.providerOrder)));
    this.tray.setToolTip(buildTooltip(this.snapshots, this.providerOrder));
  }

  setProviderOrder(order: unknown): void {
    this.providerOrder = normalizeProviderOrder(order);
    void this.update();
  }

  setDetailsWindow(dw: DetailsWindowController): void {
    this.detailsWindow = dw;
  }

  setUpdateState(state: UpdateUiState): void {
    this.updateState = state;
    void this.rebuildMenu();
  }

  /** Zeigt "Aktualisiere…" im Tooltip nach einem langen Sleep. Wird beim nächsten Refresh automatisch gelöscht. */
  notifyStaleAfterResume(sleepSeconds: number): void {
    if (sleepSeconds >= STALE_RESUME_THRESHOLD_S) {
      this.isStaleAfterResume = true;
      this.tray.setToolTip("QuotaBar – Aktualisiere…");
    }
  }

  async update(): Promise<void> {
    this.isStaleAfterResume = false;
    this.tray.setImage(renderTrayIcon(buildIconState(this.snapshots, this.providerOrder)));
    this.tray.setToolTip(buildTooltip(this.snapshots, this.providerOrder));
    await this.rebuildMenu();
  }

  async rebuildMenu(): Promise<void> {
    const orderedProviders = sortByProviderOrder(this.providers, this.providerOrder, (provider) => provider.id);
    this.tray.setContextMenu(await buildContextMenu(this.snapshots, orderedProviders, {
      refreshNow: async () => {
        this.snapshots = await this.refreshLoop.refreshNow("manual");
        await this.update();
      },
      rebuildMenu: () => void this.rebuildMenu(),
      openDashboard: () => {
        this.detailsWindow?.open(
          () => void this.refreshLoop.refreshNow("dashboard"),
          () => void this.refreshLoop.recomputeCost(),
        );
      },
      regenerateBackfill: this.onRegenerateBackfill,
      updateReady: this.updateState?.status === "ready",
      updateVersion: this.updateState?.newVersion ?? null,
      installUpdate: () => quitAndInstall(),
    }));
  }

  async showMenu(): Promise<void> {
    await this.rebuildMenu();
    this.tray.popUpContextMenu();
  }
}

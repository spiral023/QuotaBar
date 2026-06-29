import { Tray } from "electron";
import { renderTrayIcon } from "../icon/renderTrayIcon";
import { buildIconState } from "../icon/iconState";
import { UsageProvider, UsageSnapshot } from "../providers/types";
import { RefreshLoop } from "../usage/refreshLoop";
import { buildContextMenu } from "./menu";
import type { DetailsWindowController } from "./detailsWindow";
import { quitAndInstall } from "./updater";
import type { UpdateUiState } from "./updateState";

const STALE_RESUME_THRESHOLD_S = 300; // 5 Minuten Sleep → Stale-Indikator

export class TrayController {
  private tray: Tray;
  private snapshots: UsageSnapshot[] = [];
  private detailsWindow: DetailsWindowController | null = null;
  private isStaleAfterResume = false;
  private updateState: UpdateUiState | null = null;

  constructor(
    private readonly providers: UsageProvider[],
    private readonly refreshLoop: RefreshLoop,
    private readonly onRegenerateBackfill: () => Promise<void>
  ) {
    this.tray = new Tray(renderTrayIcon({ hasError: false }));
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
    this.tray.setImage(renderTrayIcon(buildIconState(this.snapshots)));
    this.tray.setToolTip(buildTooltip(this.snapshots));
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
    this.tray.setImage(renderTrayIcon(buildIconState(this.snapshots)));
    this.tray.setToolTip(buildTooltip(this.snapshots));
    await this.rebuildMenu();
  }

  async rebuildMenu(): Promise<void> {
    this.tray.setContextMenu(await buildContextMenu(this.snapshots, this.providers, {
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

function buildTooltip(snapshots: UsageSnapshot[]): string {
  const lines = ["QuotaBar"];
  for (const provider of ["claude", "codex"]) {
    const snapshot = snapshots.find((item) => item.provider === provider);
    const usage = snapshot?.windows.find((window) => typeof window.usedPercent === "number")?.usedPercent;
    if (typeof usage === "number") {
      lines.push(`${capitalize(provider)}: ${Math.round(usage)}%`);
    }
  }
  return lines.join("\n");
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

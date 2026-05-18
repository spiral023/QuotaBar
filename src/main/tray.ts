import { Tray } from "electron";
import { renderTrayIcon } from "../icon/renderTrayIcon";
import { buildIconState } from "../icon/iconState";
import { UsageProvider, UsageSnapshot } from "../providers/types";
import { RefreshLoop } from "../usage/refreshLoop";
import { buildContextMenu } from "./menu";

export class TrayController {
  private tray: Tray;
  private snapshots: UsageSnapshot[] = [];

  constructor(
    private readonly providers: UsageProvider[],
    private readonly refreshLoop: RefreshLoop
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

  async update(): Promise<void> {
    this.tray.setImage(renderTrayIcon(buildIconState(this.snapshots)));
    this.tray.setToolTip(buildTooltip(this.snapshots));
    await this.rebuildMenu();
  }

  async rebuildMenu(): Promise<void> {
    this.tray.setContextMenu(await buildContextMenu(this.snapshots, this.providers, {
      refreshNow: async () => {
        this.snapshots = await this.refreshLoop.refreshNow();
        await this.update();
      },
      rebuildMenu: () => void this.rebuildMenu()
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

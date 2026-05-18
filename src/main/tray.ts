import { Tray } from "electron";
import { renderTrayIcon } from "../icon/renderTrayIcon";
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
    this.tray = new Tray(renderTrayIcon({ connected: false, hasError: false }));
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
    const maxUsage = computeMaxUsage(this.snapshots);
    const connected = this.snapshots.some((snapshot) => snapshot.status === "ok" || snapshot.status === "stale");
    const hasError = this.snapshots.some((snapshot) => snapshot.status === "error" || snapshot.status === "stale");
    this.tray.setImage(renderTrayIcon({ maxUsage, connected, hasError }));
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

function computeMaxUsage(snapshots: UsageSnapshot[]): number | undefined {
  const codex = snapshots.find((snapshot) => snapshot.provider === "codex");
  const claude = snapshots.find((snapshot) => snapshot.provider === "claude");
  const candidates = [
    codex?.windows.find((window) => window.name === "fiveHour" || window.name === "session")?.usedPercent,
    claude?.windows.find((window) => window.name === "fiveHour")?.usedPercent
  ].filter((value): value is number => typeof value === "number");
  return candidates.length > 0 ? Math.max(...candidates) : undefined;
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

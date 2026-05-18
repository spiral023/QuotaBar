import { app, Menu, MenuItemConstructorOptions, shell } from "electron";
import { getAppConfigDir, getLogPath } from "../config/paths";
import { openClaudeLoginTerminal } from "../providers/claude";
import { CostFactorResult, UsageProvider, UsageSnapshot } from "../providers/types";
import { formatTimeRemaining } from "../usage/formatters";
import { PaceStage, UsagePace } from "../usage/usagePace";
import { isStartWithWindowsEnabled, setStartWithWindows } from "./autostart";

export interface MenuActions {
  refreshNow(): Promise<void>;
  rebuildMenu(): void;
  openDashboard(): void;
}

export async function buildContextMenu(
  snapshots: UsageSnapshot[],
  providers: UsageProvider[],
  actions: MenuActions
): Promise<Menu> {
  const items: MenuItemConstructorOptions[] = [];
  const byProvider = new Map(snapshots.map((snapshot) => [snapshot.provider, snapshot]));

  for (const provider of providers) {
    const snapshot = byProvider.get(provider.id);
    if (!snapshot || snapshot.status === "not_authenticated") {
      const hint = await provider.getAuthHint();
      items.push({
        label: hint ?? `${provider.displayName}: Not authenticated`,
        enabled: provider.id === "claude",
        click: provider.id === "claude" ? () => openClaudeLoginTerminal() : undefined
      });
      items.push({ type: "separator" });
      continue;
    }

    for (const line of snapshotToMenuLines(provider.displayName, snapshot)) {
      items.push({ label: line, enabled: false });
    }
    items.push({ type: "separator" });
  }

  items.push(
    { label: "Open Dashboard", click: () => actions.openDashboard() },
    { label: "Refresh Now", click: () => void actions.refreshNow() },
    {
      label: `Start with Windows: ${isStartWithWindowsEnabled() ? "On" : "Off"}`,
      click: () => {
        setStartWithWindows(!isStartWithWindowsEnabled());
        actions.rebuildMenu();
      }
    },
    { label: "Open Log", click: () => void shell.openPath(getLogPath()) },
    { label: "Open Config Folder", click: () => void shell.openPath(getAppConfigDir()) },
    { type: "separator" },
    { label: "Exit", click: () => app.quit() }
  );

  return Menu.buildFromTemplate(items);
}

function snapshotToMenuLines(displayName: string, snapshot: UsageSnapshot): string[] {
  const lines = snapshot.windows.length > 0
    ? snapshot.windows.flatMap((window, index) => {
      const label = index === 0 ? displayName : window.name === "weekly" ? "Weekly" : window.label ?? titleCase(window.name);
      const usage = typeof window.usedPercent === "number" ? `${Math.round(window.usedPercent)}%` : window.label ?? "unknown";
      const reset = window.resetsAt
        ? new Date(window.resetsAt).getTime() <= Date.now()
          ? " (resetting...)"
          : ` (resets in ${formatTimeRemaining(window.resetsAt)})`
        : "";
      const mainLine = `${label}: ${usage}${reset}`;
      const paceLine = window.name === "weekly" && window.pace != null ? formatPaceLine(window.pace) : null;
      return paceLine != null ? [mainLine, paceLine] : [mainLine];
    })
    : [`${displayName}: ${snapshot.status}`];

  if (snapshot.status === "stale") {
    lines[0] = `${lines[0]} (stale)`;
  }

  if (snapshot.costFactor) {
    lines.push(formatCostFactorLine(snapshot.costFactor));
  }

  return lines;
}

function formatCostFactorLine(cost: CostFactorResult): string {
  if (cost.factor === null) return `  API-Äq: ${cost.label}`;
  if (cost.apiCostUSD === 0 && !cost.isEstimate) return "  API-Äq: $0.00 (keine Daten)";
  const prefix = cost.isEstimate ? "~" : "";
  return `  API-Äq: ${prefix}$${cost.apiCostUSD.toFixed(2)} (${cost.label})`;
}

function titleCase(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function formatPaceLine(pace: UsagePace): string {
  const STAGE_LABELS: Record<PaceStage, string> = {
    onTrack: "On track",
    slightlyAhead: "Slightly ahead",
    ahead: "Ahead",
    farAhead: "Far ahead",
    slightlyBehind: "Slightly behind",
    behind: "Behind",
    farBehind: "Far behind",
  };
  const label = STAGE_LABELS[pace.stage];
  const delta =
    pace.stage !== "onTrack"
      ? ` (${pace.deltaPercent >= 0 ? "+" : "−"}${Math.round(Math.abs(pace.deltaPercent))}%)`
      : "";
  const eta = pace.willLastToReset
    ? " · Lasts to reset"
    : pace.etaSeconds != null
      ? ` · Runs out in ${formatTimeRemaining(new Date(Date.now() + pace.etaSeconds * 1000))}`
      : "";
  return `  Pace: ${label}${delta}${eta}`;
}

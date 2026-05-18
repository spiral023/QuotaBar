import { app, Menu, MenuItemConstructorOptions, shell } from "electron";
import { getAppConfigDir, getLogPath } from "../config/paths";
import { openClaudeLoginTerminal } from "../providers/claude";
import { UsageProvider, UsageSnapshot } from "../providers/types";
import { formatTimeRemaining } from "../usage/formatters";
import { isStartWithWindowsEnabled, setStartWithWindows } from "./autostart";

export interface MenuActions {
  refreshNow(): Promise<void>;
  rebuildMenu(): void;
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
  if (snapshot.provider === "gemini") {
    const label = snapshot.windows[0]?.label ?? "local sessions unavailable";
    return [`${displayName}: ${label}`];
  }

  const lines = snapshot.windows.length > 0
    ? snapshot.windows.map((window, index) => {
      const label = index === 0 ? displayName : window.name === "weekly" ? "Weekly" : window.label ?? titleCase(window.name);
      const usage = typeof window.usedPercent === "number" ? `${Math.round(window.usedPercent)}%` : window.label ?? "unknown";
      const reset = window.resetsAt ? ` (resets in ${formatTimeRemaining(window.resetsAt)})` : "";
      return `${label}: ${usage}${reset}`;
    })
    : [`${displayName}: ${snapshot.status}`];

  if (snapshot.status === "stale") {
    lines[0] = `${lines[0]} (stale)`;
  }
  return lines;
}

function titleCase(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

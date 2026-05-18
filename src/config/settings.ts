import fs from "node:fs/promises";
import { ensureConfigDir } from "../main/logging";
import { getSettingsPath } from "./paths";

export type CostWindow = "7d" | "30d" | "billing";
export type ViewMode = "dashboard" | "compact";

export interface SubscriptionCosts {
  claude: number;
  codex: number;
}

export interface Settings {
  pollIntervalSeconds: number;
  providerTimeoutMs: number;
  subscriptionCosts: SubscriptionCosts;
  pricingOfflineMode: boolean;
  costWindow: CostWindow;
  viewMode: ViewMode;
  insightsPanelOpen: boolean;
}

export const defaultSettings: Settings = {
  pollIntervalSeconds: 60,
  providerTimeoutMs: 10_000,
  subscriptionCosts: { claude: 20, codex: 10 },
  pricingOfflineMode: false,
  costWindow: "billing",
  viewMode: "dashboard",
  insightsPanelOpen: false,
};

export async function loadSettings(overrides: Partial<Settings> = {}): Promise<Settings> {
  try {
    const parsed = JSON.parse(await fs.readFile(getSettingsPath(), "utf8")) as Partial<Settings>;
    return normalizeSettings({ ...defaultSettings, ...parsed, ...overrides });
  } catch {
    await saveSettings({ ...defaultSettings, ...overrides });
    return normalizeSettings({ ...defaultSettings, ...overrides });
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await ensureConfigDir();
  await fs.writeFile(getSettingsPath(), `${JSON.stringify(normalizeSettings(settings), null, 2)}\n`, "utf8");
}

export function normalizeSettings(settings: Settings): Settings {
  const sub = (settings.subscriptionCosts ?? {}) as Partial<SubscriptionCosts>;
  const validWindows: CostWindow[] = ["7d", "30d", "billing"];
  const costWindow: CostWindow = validWindows.includes(settings.costWindow as CostWindow)
    ? (settings.costWindow as CostWindow)
    : "billing";
  const validViewModes: ViewMode[] = ["dashboard", "compact"];
  const viewMode: ViewMode = validViewModes.includes(settings.viewMode as ViewMode)
    ? (settings.viewMode as ViewMode)
    : "dashboard";
  return {
    pollIntervalSeconds: Math.max(15, Math.floor(Number(settings.pollIntervalSeconds) || defaultSettings.pollIntervalSeconds)),
    providerTimeoutMs: Math.max(1000, Math.floor(Number(settings.providerTimeoutMs) || defaultSettings.providerTimeoutMs)),
    subscriptionCosts: {
      claude: Math.max(0, Number(sub.claude) || defaultSettings.subscriptionCosts.claude),
      codex: Math.max(0, Number(sub.codex) || defaultSettings.subscriptionCosts.codex),
    },
    pricingOfflineMode: Boolean(settings.pricingOfflineMode),
    costWindow,
    viewMode,
    insightsPanelOpen: Boolean(settings.insightsPanelOpen),
  };
}

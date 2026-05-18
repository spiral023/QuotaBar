import fs from "node:fs/promises";
import { ensureConfigDir } from "../main/logging";
import { getSettingsPath } from "./paths";

export interface SubscriptionCosts {
  claude: number;
  codex: number;
  gemini: number;
}

export interface Settings {
  pollIntervalSeconds: number;
  providerTimeoutMs: number;
  subscriptionCosts: SubscriptionCosts;
  pricingOfflineMode: boolean;
}

export const defaultSettings: Settings = {
  pollIntervalSeconds: 60,
  providerTimeoutMs: 10_000,
  subscriptionCosts: { claude: 20, codex: 10, gemini: 19 },
  pricingOfflineMode: false
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

function normalizeSettings(settings: Settings): Settings {
  const sub = (settings.subscriptionCosts ?? {}) as Partial<SubscriptionCosts>;
  return {
    pollIntervalSeconds: Math.max(15, Math.floor(Number(settings.pollIntervalSeconds) || defaultSettings.pollIntervalSeconds)),
    providerTimeoutMs: Math.max(1000, Math.floor(Number(settings.providerTimeoutMs) || defaultSettings.providerTimeoutMs)),
    subscriptionCosts: {
      claude: Math.max(0, Number(sub.claude) || defaultSettings.subscriptionCosts.claude),
      codex: Math.max(0, Number(sub.codex) || defaultSettings.subscriptionCosts.codex),
      gemini: Math.max(0, Number(sub.gemini) || defaultSettings.subscriptionCosts.gemini),
    },
    pricingOfflineMode: Boolean(settings.pricingOfflineMode)
  };
}

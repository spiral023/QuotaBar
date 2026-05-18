import fs from "node:fs/promises";
import { ensureConfigDir } from "../main/logging";
import { getSettingsPath } from "./paths";

export interface Settings {
  pollIntervalSeconds: number;
  providerTimeoutMs: number;
}

export const defaultSettings: Settings = {
  pollIntervalSeconds: 60,
  providerTimeoutMs: 10_000
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
  return {
    pollIntervalSeconds: Math.max(15, Math.floor(Number(settings.pollIntervalSeconds) || defaultSettings.pollIntervalSeconds)),
    providerTimeoutMs: Math.max(1000, Math.floor(Number(settings.providerTimeoutMs) || defaultSettings.providerTimeoutMs))
  };
}
